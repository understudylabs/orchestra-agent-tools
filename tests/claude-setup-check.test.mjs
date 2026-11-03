import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyClaudeSetup } from '../dist/commands/claude-setup.js';
function fixture(actions, failures=1) {
  const messages=[];let attempts=0,logins=0,removals=0;
  return {messages,get attempts(){return attempts;},get logins(){return logins;},get removals(){return removals;},deps:{
    interactive:true,
    check:async()=>{if(attempts++<failures)throw new Error('synthetic private error');return {inference:'verified',capture:'not_checked',session_id:'synthetic-session'};},
    recover:async()=>{assert.ok(actions.length);return actions.shift();},
    login:async()=>{logins++;return true;},remove:()=>{removals++;return {next:'Restored.'};},write:m=>messages.push(m),
  }};
}
test('only successful Claude inference produces Ready; retry stays explicit',async()=>{
  const f=fixture(['retry']);assert.equal(await verifyClaudeSetup(f.deps),'verified');assert.equal(f.attempts,2);
  assert.equal(f.messages.filter(m=>m.startsWith('Ready:')).length,1);
  assert.match(f.messages.at(-1),/Capture has not been verified/);
  assert.ok(f.messages.every(m=>!m.includes('synthetic private error')));
});
test('failed verification can sign in then retry without removing settings',async()=>{
  const f=fixture(['login']);assert.equal(await verifyClaudeSetup(f.deps),'verified');assert.equal(f.logins,1);assert.equal(f.removals,0);
});
for(const [action,result] of [['restore','restored'],['change','change'],['keep','unverified']]){
  test(`failed verification supports ${action}`,async()=>{
    const f=fixture([action]);assert.equal(await verifyClaudeSetup(f.deps),result);
    assert.equal(f.removals,action==='restore'?1:0);assert.ok(f.messages.every(m=>!m.startsWith('Ready:')));
  });
}
test('noninteractive failure reports failure without retries or hidden login',async()=>{
  const f=fixture([]);f.deps.interactive=false;await assert.rejects(verifyClaudeSetup(f.deps),/check failed/);assert.equal(f.attempts,1);assert.equal(f.logins,0);
});
test('cancelled login never produces Ready',async()=>{
  const f=fixture(['login']);f.deps.login=async()=>false;assert.equal(await verifyClaudeSetup(f.deps),'unverified');assert.equal(f.attempts,1);
});

import { assertSetupProvider } from '../dist/claude-setup-check.js';
test('alternate provider modes cannot produce a gateway readiness claim',()=>{
  for(const key of ['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']){
    assert.throws(()=>assertSetupProvider({}, {[key]:'1'}),/bypass/);
    assert.throws(()=>assertSetupProvider({[key]:'1'}, {}),/bypass/);
    assert.doesNotThrow(()=>assertSetupProvider({[key]:''}, {[key]:'1'}));
  }
});
