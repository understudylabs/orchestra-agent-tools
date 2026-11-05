import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexConfig, codexEnvironment, codexArguments, validateCodexArgs } from '../dist/commands/codex.js';
const session={version:1,session_id:'11111111-1111-4111-8111-111111111111',root:'/example',org:'org_example',project:'coding',workload:'codex',environment:'test',model:'gpt-example',gateway_url:'https://gateway.example.com'};
test('Codex configuration uses native Responses, attribution and env credentials',()=>{
 const text=codexConfig(session);
 for(const expected of ['wire_api = "responses"','requires_openai_auth = false','supports_websockets = false','enable_request_compression = false','x-understudy-environment" = "test"','x-understudy-session-id','/v1"'])assert.ok(text.includes(expected));
 assert.ok(codexConfig({...session,gateway_url:'https://gateway.example.com/v1/'}).includes('base_url = "https://gateway.example.com/v1"'));
 assert.throws(()=>codexConfig({...session,gateway_url:'https://user:pass@gateway.example.com'}),/HTTPS/);
 assert.throws(()=>codexConfig({...session,gateway_url:'http://gateway.example.com'}),/HTTPS/);
});
test('Codex credentials and home are isolated without mutating the caller',()=>{
 const before={HOME:'/example',PATH:'/bin',CODEX_HOME:'/original',OPENAI_API_KEY:'old',UNDERSTUDY_API_KEY:'old',UNDERSTUDY_GATEWAY_URL:'https://wrong.example'};
 const after=codexEnvironment(before,'/isolated','test-token');
 assert.equal(after.CODEX_HOME,'/isolated');assert.equal(after.UNDERSTUDY_API_KEY,'test-token');assert.equal(after.OPENAI_API_KEY,undefined);assert.equal(after.UNDERSTUDY_GATEWAY_URL,undefined);
 assert.equal(before.CODEX_HOME,'/original');assert.equal(before.UNDERSTUDY_API_KEY,'old');assert.equal(after.HOME,before.HOME);
});
test('Codex resume stays in the managed session and rejects routing overrides',()=>{
 assert.deepEqual(codexArguments(['exec','--json','hello'],true),['exec','resume','--last','--json','hello']);
 assert.deepEqual(codexArguments([],true),['resume','--last']);
 for(const arg of ['--config','-cmodel_provider=other','--profile=other','-mfoo','--cd','--oss','--ephemeral','--enable','resume','login'])assert.throws(()=>validateCodexArgs([arg]),/Orchestra/);
 assert.doesNotThrow(()=>validateCodexArgs(['exec','--json','--sandbox','read-only','hello']));
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('Codex launcher persists a credential-free isolated session and resumes it',()=>{
 const home=mkdtempSync(join(tmpdir(),'orchestra-codex-test-'));
 try {
  mkdirSync(join(home,'.orchestra')); writeFileSync(join(home,'.orchestra','.orchestra-home'),'1'); mkdirSync(join(home,'bin'));
  writeFileSync(join(home,'.orchestra','credentials.json'),JSON.stringify({orgs:{org_example:{api_key:'synthetic-key',gateway_url:'https://gateway.example.com'}}}),{mode:0o600});
  writeFileSync(join(home,'bin','codex'),`#!${process.execPath}\nconsole.log(JSON.stringify({home:process.env.CODEX_HOME,tokenPresent:process.env.UNDERSTUDY_API_KEY==='synthetic-key',args:process.argv.slice(2)}));`,{mode:0o700});
  const env={...process.env,HOME:home,PATH:join(home,'bin')+':'+process.env.PATH};
  delete env.UNDERSTUDY_API_KEY; delete env.UNDERSTUDY_GATEWAY_URL; delete env.UNDERSTUDY_ORG_ID;
  const bin=new URL('../dist/bin.js',import.meta.url).pathname;
  const run=args=>spawnSync(process.execPath,[bin,'codex',...args],{env,cwd:home,encoding:'utf8'});
  const first=run(['--org','org_example','--project','coding','--workload','codex','--environment','test','--model','gpt-example','--','exec','--json','hello']);
  assert.equal(first.status,0,first.stderr); const result=JSON.parse(first.stdout);
  assert.equal(result.tokenPresent,true); assert.notEqual(result.home,join(home,'.codex'));
  const id=readdirSync(join(home,'.orchestra','codex-sessions'))[0];
  const session=readFileSync(join(home,'.orchestra','codex-sessions',id,'session.json'),'utf8');
  const config=readFileSync(join(result.home,'config.toml'),'utf8');
  assert.equal((session+config).includes('synthetic-key'),false);
  const resumed=run(['--resume',id,'--','exec','--json','again']);
  assert.equal(resumed.status,0,resumed.stderr);
  assert.deepEqual(JSON.parse(resumed.stdout).args.slice(-5),['exec','resume','--last','--json','again']);
  assert.equal(JSON.parse(resumed.stdout).home,result.home);
  assert.notEqual(run(['--resume',id,'--model','different']).status,0);
 } finally {rmSync(home,{recursive:true,force:true});}
});
