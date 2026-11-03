import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:https';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = promisify(execFile);
const supported = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty']).status === 0 && spawnSync('openssl', ['version']).status === 0;
const driver = String.raw`
import os, pty, select, sys, time, json, signal
steps = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execve(sys.argv[2], sys.argv[2:], os.environ.copy())
output = b''
step = 0
start = 0
deadline = time.monotonic() + 30
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready: continue
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if step < len(steps) and steps[step][0].encode() in output[start:]:
            time.sleep(0.1)
            os.write(fd, steps[step][1].encode())
            step += 1
            start = len(output)
    else:
        os.killpg(pid, signal.SIGKILL)
    _, status = os.waitpid(pid, 0)
    print(output.decode('utf-8', 'replace'))
    if step != len(steps): sys.exit(90)
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    os.close(fd)
`;

for (const scenario of ['fresh', 'stale', 'wrong-code', 'still-denied', 'inference-denied']) {
  test(`real terminal setup: ${scenario}`, { skip: !supported || (scenario === 'inference-denied' && !process.env.CLAUDE_TEST_BINARY), timeout: 45000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'orchestra-setup-terminal-'));
    const home = join(root, 'home'); const config = join(home, '.understudy');
    mkdirSync(config, {recursive:true}); mkdirSync(join(home, '.claude')); mkdirSync(join(root, 'bin'));
    const cert = join(root, 'cert.pem'); const key = join(root, 'key.pem');
    const generated = spawnSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'], {encoding:'utf8'});
    assert.equal(generated.status, 0, generated.stderr);
    writeFileSync(join(root,'bin','claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.309 (Claude Code)"; else exec "$CLAUDE_TEST_BINARY" "$@"; fi\n', {mode:0o755});
    writeFileSync(join(home,'.claude','CLAUDE.md'),'Synthetic memory sentinel: MEMORY_MUST_NOT_ENTER_SETUP_CHECK.');
    const settingsPath = join(home,'.claude','settings.json');
    writeFileSync(settingsPath, JSON.stringify({theme:'dark',env:{USER_SETTING:'keep'}}));
    const requests = []; let base;
    const project = {id:'project_example',slug:'coding',name:'Coding'};
    const server = createServer({key:readFileSync(key),cert:readFileSync(cert)}, async (req,res) => {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      requests.push({path:req.url,auth:req.headers.authorization,model:body.model,environment:req.headers['x-understudy-environment'],body});
      const reply = (status,value) => {res.writeHead(status,{'content-type':'application/json','x-understudy-request-id':'synthetic-request'});res.end(JSON.stringify(value));};
      if (req.url === '/.well-known/oauth-authorization-server') return reply(200,{agent_auth:{register_uri:base+'/register',claim_uri:base+'/claim'}});
      if (req.url === '/register') return reply(200,{registration_id:'synthetic-registration',claim_token:'synthetic-claim',claim_url:base+'/claim'});
      if (req.url === '/claim') {
        if (scenario === 'wrong-code') return reply(400,{message:'Synthetic invalid code'});
        assert.equal(body.code,'synthetic-code');
        return reply(200,{credential_type:'api_key',credential:'sk_test_fresh',org_id:'org_example',email:'tester@example.com',gateway_url:base});
      }
      if (req.headers.authorization !== 'Bearer sk_test_fresh' || scenario === 'still-denied') return reply(403,{error:{type:'authorization_error',message:'synthetic denied'}});
      if (req.url.startsWith('/v1/messages') && scenario==='inference-denied') return reply(403,{error:{type:'permission_error',message:'Synthetic model access denied'}});
      if (req.url.startsWith('/v1/messages')) return reply(200,{id:'msg_synthetic',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:JSON.stringify(body.messages).includes('ORCHESTRA_SETUP_OK')?'ORCHESTRA_SETUP_OK':'synthetic ok'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:3}});
      if (req.url.endsWith('/identity')) return reply(200,{organization:{id:'org_example',name:'Example organization'}});
      if (req.url.endsWith('/projects')) return reply(200,{projects:[project]});
      if (req.url.endsWith('/workloads')) return reply(200,{workloads:[{id:'workload_example',name:'claude-code',project_id:project.id,capture_enabled:true}]});
      return reply(404,{message:'Unexpected synthetic route'});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    base = `https://127.0.0.1:${server.address().port}`;
    writeFileSync(join(config,'credentials.json'),JSON.stringify({orgs:{org_example:{api_key:['fresh','inference-denied'].includes(scenario)?'sk_test_fresh':'sk_test_stale',gateway_url:base}}}),{mode:0o600});
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(UNDERSTUDY_|ANTHROPIC_|CLAUDE_|CLAUDECODE|NODE_OPTIONS)/.test(key)));
    Object.assign(env,{HOME:home,UNDERSTUDY_HOME:config,CLAUDE_CONFIG_DIR:join(home,'.claude'),UNDERSTUDY_TELEMETRY:'0',NODE_EXTRA_CA_CERTS:cert,PATH:join(root,'bin')+':'+process.env.PATH,TERM:'xterm-256color',CLAUDE_TEST_BINARY:process.env.CLAUDE_TEST_BINARY||''});
    const steps = ['fresh','inference-denied'].includes(scenario) ? [] : [['Organization access needs attention','\r'],['Email for your Orchestra account','tester@example.com\r'],['One-time code:','synthetic-code\r']];
    if (['fresh','stale','inference-denied'].includes(scenario)) steps.push(['Verify setup with a small billable Claude request?',process.env.CLAUDE_TEST_BINARY?'y\r':'n\r']);
    if (scenario==='inference-denied') steps.push(['Claude setup check failed','\x1b[B\x1b[B\x1b[B\r']);
    if (scenario==='still-denied') steps.push(['Organization access needs attention','\x1b[B\r']);
    try {
      const {stdout}=await exec('python3',['-c',driver,JSON.stringify(steps),process.execPath,resolve('dist/bin.js'),'claude-setup','--project','coding','--workload','claude-code','--environment','production','--yes'],{env,cwd:home,timeout:40000,maxBuffer:1024*1024});
      assert.doesNotMatch(stdout,/UnderstudyApiError:|at async/);
      const installed=existsSync(join(config,'claude-native.json'));
      if (scenario==='fresh'||scenario==='stale') {
        assert.equal(installed,true,stdout);
        const state=JSON.parse(readFileSync(join(config,'claude-native.json')));
        assert.equal(state.config.org,'org_example');assert.equal(state.config.project,'coding');assert.equal(state.config.environment,'production');
        const settings=JSON.parse(readFileSync(settingsPath));
        assert.equal(settings.theme,'dark'); assert.equal(settings.env.USER_SETTING,'keep');
        assert.equal(JSON.parse(readFileSync(join(home,'.claude','.claude.json'))).hasCompletedOnboarding,true);
        assert.ok(requests.some(r=>r.path.endsWith('/workloads')&&r.auth==='Bearer sk_test_fresh'));
        if (process.env.CLAUDE_TEST_BINARY) {
          const {stdout: response}=await exec(process.env.CLAUDE_TEST_BINARY,['-p','Reply synthetic ok','--model','deepseek-v4.1-flash-1017[1m]','--tools','','--setting-sources','user','--output-format','json'],{env:{...env,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},cwd:home,timeout:30000});
          const result=JSON.parse(response);
          assert.equal(result.is_error,false,JSON.stringify(result));
          assert.ok(requests.some(r=>r.path.startsWith('/v1/messages')&&r.auth==='Bearer sk_test_fresh'&&r.model==='deepseek-v4.1-flash-1017'));
          const checkModule=new URL('../dist/claude-setup-check.js',import.meta.url).href;
          const {stdout:checked}=await exec(process.execPath,['--input-type=module','-e',`import {checkClaudeSetup} from ${JSON.stringify(checkModule)}; console.log(JSON.stringify(await checkClaudeSetup()));`],{env:{...env,CLAUDE_TEST_BINARY:process.env.CLAUDE_TEST_BINARY},cwd:home,timeout:65000});
          assert.equal(JSON.parse(checked).inference,'verified');
          assert.equal(JSON.parse(checked).capture,'not_checked');
          const checks=requests.filter(r=>r.path.startsWith('/v1/messages')&&r.environment==='test');
          assert.ok(checks.length>0);
          for(const request of checks){
            assert.ok(!JSON.stringify(request.body).includes('MEMORY_MUST_NOT_ENTER_SETUP_CHECK'));
            assert.equal(request.body.tools?.length??0,0);
          }
          assert.equal(JSON.parse(readFileSync(join(config,'claude-native.json'))).config.environment,'production');

        }
        for (const action of ['repair','models','models']) await exec(process.execPath,[resolve('dist/bin.js'),'claude-setup',action],{env,cwd:home});
        const {stdout:health}=await exec(process.execPath,[resolve('dist/bin.js'),'claude-setup','status'],{env,cwd:home});
        assert.deepEqual(JSON.parse(health).verification,{configuration:'configured',inference:'not_checked',capture:'not_checked'});
        await exec(process.execPath,[resolve('dist/bin.js'),'claude-setup','remove'],{env,cwd:home});
        assert.equal(existsSync(join(config,'claude-native.json')),false);
        const removed=JSON.parse(readFileSync(settingsPath));
        assert.equal(removed.theme,'dark');assert.equal(removed.env.USER_SETTING,'keep');
        assert.equal(removed.env.ANTHROPIC_AUTH_TOKEN,undefined);
        await exec(process.execPath,[resolve('dist/bin.js'),'claude-setup','--org','org_example','--project','coding','--workload','claude-code','--environment','production','--yes'],{env,cwd:home});
        assert.equal(JSON.parse(readFileSync(join(home,'.claude','.claude.json'))).hasCompletedOnboarding,true);
      } else {
        assert.equal(installed,false,stdout);
        assert.deepEqual(JSON.parse(readFileSync(settingsPath)),{theme:'dark',env:{USER_SETTING:'keep'}});
        assert.match(stdout,scenario==='wrong-code'?/Sign-in did not complete/:scenario==='inference-denied'?/Claude did not complete the setup check/:/Sign-in completed.*still cannot access/);
        assert.doesNotMatch(stdout,/Ready:/);
      }
    } finally { await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true}); }
  });
}
