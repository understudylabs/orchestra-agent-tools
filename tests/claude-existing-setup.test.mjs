import assert from 'node:assert/strict';
import test from 'node:test';
import { existingClaudeSetup } from '../dist/commands/claude-setup.js';
function fixture(action='keep', approved=true) {
  let removals=0; let confirmations=0;
  return { get removals(){return removals;},get confirmations(){return confirmations;},deps:{
    exists:()=>true, read:()=>({config:{org:'org_example',project:'coding',workload:'claude-code',environment:'test'}}),
    interactive:true, select:async()=>action, confirm:async()=>{confirmations++;return approved;},
    remove:()=>{removals++;return {next:'Restart Claude.',preserved_user_edits:[]};},write:()=>{},
  }};
}
test('fresh setup continues, existing setup defaults to keep with no mutations',async()=>{
  const f=fixture();assert.equal(await existingClaudeSetup(f.deps),false);assert.equal(f.removals,0);assert.equal(f.confirmations,0);
  f.deps.exists=()=>false;assert.equal(await existingClaudeSetup(f.deps),true);
});
test('reconfiguration removes only after explicit confirmation and then continues',async()=>{
  const f=fixture('reconfigure');assert.equal(await existingClaudeSetup(f.deps),true);assert.equal(f.removals,1);
  const g=fixture('reconfigure',false);assert.equal(await existingClaudeSetup(g.deps),false);assert.equal(g.removals,0);
});
test('removal exits setup, noninteractive runs cannot silently replace configuration',async()=>{
  const f=fixture('remove');assert.equal(await existingClaudeSetup(f.deps),false);assert.equal(f.removals,1);
  const g=fixture();g.deps.interactive=false;await assert.rejects(existingClaudeSetup(g.deps),/nothing changed/);assert.equal(g.removals,0);
});
