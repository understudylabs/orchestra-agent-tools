import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeEnvironment, repositoryFromRemote, validateClaudeArgs } from '../dist/commands/claude.js';

test('repository attribution strips transport and refuses embedded credentials', () => {
  assert.equal(repositoryFromRemote('git@github.com:example/demo.git'), 'example/demo');
  assert.equal(repositoryFromRemote('https://github.com/example/demo.git'), 'example/demo');
  assert.throws(() => repositoryFromRemote('https://secret@github.com/example/demo.git'));
  assert.throws(() => repositoryFromRemote('/tmp/demo'));
});
test('session-changing Claude arguments cannot bypass managed resume', () => {
  for (const arg of ['--resume', '--resume=other', '-r', '--continue', '--fork-session', '--session-id=x', '--settings', '-rother', '-wbranch']) assert.throws(() => validateClaudeArgs([arg]));
  validateClaudeArgs(['--model', 'example-model', '-p', 'hello']);
});
test('child authentication and attribution replace inherited Anthropic configuration', () => {
  const session = { session_id: 'session', repository: 'example/demo', branch: 'feature/docs', base_commit: 'a'.repeat(40), environment: 'test', project: 'example', workload: 'docs', gateway_url: 'https://gateway.example.com' };
  const env = claudeEnvironment({ ANTHROPIC_AUTH_TOKEN: 'old', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: old', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' }, session, 'synthetic-key');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'synthetic-key');
  assert.equal(env.PATH, '/bin');
  assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /x-understudy-session-id: session/);
  assert.match(env.ANTHROPIC_CUSTOM_HEADERS, /"repository":"example\/demo"/);
  assert.ok(!env.ANTHROPIC_CUSTOM_HEADERS.includes('old'));
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const cli = resolve('dist/bin.js');
test('real CLI persists scoped launch, resumes, rejects branch drift, and propagates failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-claude-'));
  try {
    const repo = join(dir, 'repo'); const bin = join(dir, 'bin');
    mkdirSync(repo); mkdirSync(bin); mkdirSync(join(dir, '.understudy'));
    writeFileSync(join(dir, '.understudy', 'credentials.json'), JSON.stringify({orgs:{org_example:{api_key:'synthetic-test-key',gateway_url:'https://gateway.example.com'}}}), {mode:0o600});
    const git = (...args) => execFileSync('git', args, {cwd:repo, stdio:'pipe'});
    git('init', '-b', 'feature/docs'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-m', 'initial'); git('remote', 'add', 'origin', 'https://github.com/example/demo.git');
    const captured = join(dir,'child.json');
    writeFileSync(join(bin,'claude'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE,JSON.stringify({args:process.argv.slice(2),headers:process.env.ANTHROPIC_CUSTOM_HEADERS,key:process.env.ANTHROPIC_API_KEY}));process.exit(Number(process.env.CHILD_EXIT||0));\n', {mode:0o700});
    const env = {...process.env, HOME:dir, PATH:bin+':'+process.env.PATH, CAPTURE:captured, UNDERSTUDY_TELEMETRY:'0'};
    delete env.UNDERSTUDY_API_KEY; delete env.UNDERSTUDY_GATEWAY_URL;
    const run = (args, extra={}) => spawnSync(process.execPath,[cli,'claude',...args],{cwd:repo,env:{...env,...extra},encoding:'utf8'});
    const first = run(['--org','org_example','--project','example','--workload','docs','--environment','test','--','-p','hello']);
    assert.equal(first.status,0,first.stderr);
    const sessions=join(dir,'.understudy','claude-sessions'); const file=join(sessions,readdirSync(sessions)[0]);
    const session=JSON.parse(readFileSync(file));
    assert.match(session.traceparent,/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    assert.equal(statSync(file).mode & 0o777,0o600);
    assert.ok(!readFileSync(file,'utf8').includes('synthetic-test-key'));
    assert.ok(!first.stderr.includes('synthetic-test-key'));
    const initial=JSON.parse(readFileSync(captured));
    assert.deepEqual(initial.args.slice(0,4),['--setting-sources','','--session-id',session.session_id]);
    assert.equal(initial.key,'synthetic-test-key');
    assert.ok(initial.headers.includes(`traceparent: ${session.traceparent}`));
    const lock=join(sessions,session.session_id+'.lock');
    writeFileSync(lock,'');
    assert.match(run(['--resume',session.session_id]).stderr,/already running/);
    rmSync(lock);
    const resumed=run(['--resume',session.session_id,'--','-p','review']);
    assert.equal(resumed.status,0,resumed.stderr);
    assert.equal(JSON.parse(readFileSync(captured)).headers,initial.headers);
    assert.equal(run(['--resume',session.session_id,'--environment','production']).status,1);
    assert.equal(run(['--resume',session.session_id],{CHILD_EXIT:'7'}).status,7);
    git('checkout','-b','other');
    assert.match(run(['--resume',session.session_id]).stderr,/original repository worktree and branch/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

import { verifyClaudePullRequest } from '../dist/commands/claude-session.js';
test('PR linkage records merged commit and refuses unrelated branches or forks', () => {
  const session = {session_id:'example', created_at:'2025-12-31T00:00:00Z', repository:'example/demo', branch:'feature/docs',base_commit:'a'.repeat(40)};
  const pr = {number:12,url:'https://github.com/example/demo/pull/12',state:'MERGED',headRefName:'feature/docs',headRefOid:'b'.repeat(40),headRepository:{name:'demo'},headRepositoryOwner:{login:'example'},mergedAt:'2026-01-01T00:00:00Z',mergeCommit:{oid:'c'.repeat(40)}};
  assert.equal(verifyClaudePullRequest(session,pr).merge_commit,'c'.repeat(40));
  assert.throws(()=>verifyClaudePullRequest(session,{...pr,headRefName:'other'}));
  assert.throws(()=>verifyClaudePullRequest(session,{...pr,headRepositoryOwner:{login:'another'}}));
  assert.throws(()=>verifyClaudePullRequest(session,{...pr,mergeCommit:null}));
  assert.throws(()=>verifyClaudePullRequest({...session,created_at:'2026-01-02T00:00:00Z'},pr),/before this session/);
});

import { readClaudeEvidence, verifySessionCapture } from '../dist/claude-reconciliation.js';
test('transcript reconciliation deduplicates streaming messages but rejects duplicate results and mixed sessions', () => {
  const dir=mkdtempSync(join(tmpdir(),'claude-evidence-'));
  const file=join(dir,'run.jsonl');
  const usage={input_tokens:2,output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:5};
  const assistant={type:'assistant',session_id:'session',message:{id:'msg_example'}};
  const result={type:'result',session_id:'session',uuid:'result',subtype:'success',is_error:false,usage};
  const write=(rows)=>writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n'));
  try {
    write([assistant,assistant,result]);
    assert.deepEqual(readClaudeEvidence([file],'session'),{messageIds:['msg_example'],usage,results:1});
    assert.throws(()=>readClaudeEvidence([file,file],'session'),/double-count/);
    assert.throws(()=>readClaudeEvidence([file],'another'),/session ID/);
    writeFileSync(file,'secret malformed transcript');
    assert.throws(()=>readClaudeEvidence([file],'session'),error=>!error.message.includes('secret') && /raw content omitted/.test(error.message));
    write([assistant]);assert.throws(()=>readClaudeEvidence([file],'session'),/completed result/);
    write([assistant,{...result,is_error:true}]);assert.throws(()=>readClaudeEvidence([file],'session'),/unsuccessful/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('capture verification refuses cross-session data and missing response payload',()=>{
  const session={session_id:'session',environment:'test',repository:'example/demo',branch:'feature/docs',base_commit:'a'.repeat(40)};
  const capture={request_id:'request',request_environment:'test',tags:{run_id:'session',repository:'example/demo',branch:'feature/docs',base_commit:'a'.repeat(40),harness:'claude-code'},customer_request_body:{messages:[]},response_body:{content:[]}};
  verifySessionCapture(capture,session,'request');
  assert.throws(()=>verifySessionCapture(capture,session,'other'),/identity/);
  assert.throws(()=>verifySessionCapture({...capture,tags:{...capture.tags,run_id:'other'}},session,'request'),/attribution/);
  assert.throws(()=>verifySessionCapture({...capture,response_body:null},session,'request'),/missing/);
});
