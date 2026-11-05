import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSession, matchesPullRequest, buildReport } from '../runtime-assets/pr-capture/capture.mjs';
const repo='example/project';
const session={version:1,session_id:'11111111-1111-4111-8111-111111111111',repository:repo,branch:'feature',base_commit:'a'.repeat(40),created_at:'2026-11-01T00:00:00Z'};
const pr={number:12,html_url:'https://github.com/example/project/pull/12',state:'closed',merged_at:'2026-11-02T00:00:00Z',closed_at:'2026-11-02T00:00:00Z',merge_commit_sha:'c'.repeat(40),head:{repo:{full_name:repo},ref:'feature',sha:'b'.repeat(40)}};
test('registration strips all non-contract fields and rejects foreign repositories',()=>{
 assert.deepEqual(validateSession({...session,api_key:'synthetic',root:'/private',prompt:'private'},repo),session);
 assert.throws(()=>validateSession(session,'other/repo'));
 assert.throws(()=>validateSession({...session,branch:'bad\nbranch'},repo));
 assert.throws(()=>validateSession({...session,base_commit:'not-a-sha'},repo));
});
test('branch, fork, time and ancestry boundaries remain explicit',async()=>{
 assert.equal(matchesPullRequest({...session,branch:'other'},pr),false);
 assert.equal(matchesPullRequest(session,{...pr,head:{...pr.head,repo:{full_name:'fork/project'}}}),false);
 assert.equal(matchesPullRequest({...session,created_at:'2026-11-03T00:00:00Z'},pr),false);
 const report=await buildReport(pr,[session],async()=> 'ahead');
 assert.equal(report.linked_sessions.length,1);assert.equal(report.customer_cost_usd,null);
 assert.equal(report.merge_commit,'c'.repeat(40));assert.equal(report.state,'merged');
 const rebased=await buildReport(pr,[session],async()=> 'diverged');
 assert.equal(rebased.linked_sessions.length,0);assert.equal(rebased.rejected_sessions.length,1);
 const closed=await buildReport({...pr,merged_at:null},[session],async()=> 'identical');
 assert.equal(closed.state,'closed');assert.equal(closed.merge_commit,null);
});
