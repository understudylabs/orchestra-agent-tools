import assert from 'node:assert/strict';
import test from 'node:test';
import { finishClaudeSetup } from '../dist/onboarding/claude-handoff.js';
function fixture(action='open',status=0){
 const messages=[],launches=[];
 return {messages,launches,deps:{interactive:true,cwd:'/tmp/example-project',choose:async()=>action,folder:async()=>'/tmp/another-project',launch:async cwd=>{launches.push(cwd);return status;},write:m=>messages.push(m)}};
}
test('verified setup offers Claude launch and explains where to type before and after it',async()=>{
 const f=fixture();await finishClaudeSetup(true,f.deps);assert.deepEqual(f.launches,['/tmp/example-project']);
 assert.match(f.messages[1],/Type your request after Claude opens/);assert.match(f.messages.at(-1),/back in your terminal/);assert.match(f.messages.at(-1),/claude --resume/);
});
test('project folder selection controls the launch directory',async()=>{
 const f=fixture('folder');await finishClaudeSetup(true,f.deps);assert.deepEqual(f.launches,['/tmp/another-project']);
});
for(const mode of ['later','noninteractive','no-start'])test(`${mode} prints an actionable command without launching`,async()=>{
 const f=fixture('later');if(mode==='noninteractive')f.deps.interactive=false;
 await finishClaudeSetup(mode!=='no-start',f.deps);assert.equal(f.launches.length,0);assert.match(f.messages.at(-1),/  claude\n/);
});
test('failed launch retains an actionable return to the terminal',async()=>{
 const f=fixture('open',1);await finishClaudeSetup(true,f.deps);assert.ok(f.messages.some(m=>m.includes('claude-setup status')));assert.match(f.messages.at(-1),/back in your terminal/);
});
