import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSessionRequests } from '../dist/claude-accounting.js';
const scope={org:'org_example',projectId:'project',workloadId:'workload',sessionId:'session',environment:'test',startedAt:'2026-11-02T10:00:00.000Z'};
const row=(id,status=200)=>({request_id:`019faa55-0000-7000-8000-${String(id).padStart(12,'0')}`,ts:'2026-11-02T11:00:00.000Z',project_id:'project',workload_id:'workload',request_environment:'test',status_code:status,outcome:status===200?'success':'error',tokens:{input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0,reasoning_output_tokens:0},capture_state:status===200?'expected':'disabled'});
const page=(calls,next_cursor=null)=>({org_id:'org_example',window_start:'2026-11-01T00:00:00.000Z',window_end:'2026-11-02T12:00:00.000Z',snapshot_watermark:'2026-11-02T12:00:01.000Z',filters:{session_id:'session',project_id:'project',workload_id:'workload',request_environment:'test'},calls,next_cursor,coverage:{source_timestamp:null,data_completeness:1,known_gaps:['late arrivals possible']}});
test('walks frozen pages including failed requests without a transcript',async()=>{
 const cursors=[];const result=await collectSessionRequests(scope,async c=>{cursors.push(c);return c===null?page([row(2)],'next'):page([row(1,400)]);});
 assert.deepEqual(cursors,[null,'next']);assert.equal(result.calls.length,2);assert.equal(result.calls[1].status_code,400);assert.deepEqual(result.known_gaps,['late arrivals possible']);
});
test('refuses scope drift, ignored session filter, and clipped session windows',async()=>{
 await assert.rejects(collectSessionRequests(scope,async()=>({...page([]),org_id:'another'})),/scope mismatch/);
 await assert.rejects(collectSessionRequests(scope,async()=>({...page([]),filters:{...page([]).filters,session_id:'another'}})),/scope mismatch/);
 await assert.rejects(collectSessionRequests({...scope,startedAt:'2026-10-01T00:00:00Z'},async()=>page([])),/before the inventory/);
});
test('refuses duplicate requests and changed pagination snapshots',async()=>{
 await assert.rejects(collectSessionRequests(scope,async c=>c===null?page([row(1)],'next'):page([row(1)])),/Repeated or unordered/);
 await assert.rejects(collectSessionRequests(scope,async c=>c===null?page([row(2)],'next'):{...page([row(1)]),snapshot_watermark:'2026-11-02T12:00:02Z'}),/snapshot changed/);
 await assert.rejects(collectSessionRequests(scope,async()=>page([],'next')),/Invalid inventory/);
});

import { accountClaudeSession } from '../dist/claude-accounting.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('customer API accounting preserves failed calls and unknown prices and rejects foreign costs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-account-'));
  const saved = Object.fromEntries(['HOME','UNDERSTUDY_API_KEY','UNDERSTUDY_GATEWAY_URL'].map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const session = {org:scope.org,project:'example',workload:'example',session_id:scope.sessionId,environment:'test',created_at:scope.startedAt,gateway_url:'https://synthetic.example.test'};
  let mode = 'missing';
  const cost = call => ({...call,org_id:scope.org,provider:'managed',served_model:'example',unpriced_reason:null,cost_categories:null,coverage:page([]).coverage,generated_at:call.ts,pricing_status:'priced',customer_cost_usd:0.01});
  try {
    process.env.HOME = root;
    process.env.UNDERSTUDY_API_KEY = 'synthetic-account-key';
    process.env.UNDERSTUDY_GATEWAY_URL = session.gateway_url;
    globalThis.fetch = async input => {
      const url = new URL(String(input));
      let body;
      let status = 200;
      if (url.pathname.endsWith('/projects')) body = {projects:[{id:'project',slug:'example'}]};
      else if (url.pathname.endsWith('/workloads')) body = {workloads:[{id:'workload',name:'example',project_id:'project'}]};
      else if (url.pathname.endsWith('/request-logs')) {
        assert.equal(url.searchParams.get('session_id'),scope.sessionId);
        assert.equal(url.searchParams.get('request_environment'),'test');
        assert.equal(url.searchParams.get('include_rejection_details'),'true');
        body = page(mode === 'empty' ? [] : [row(2),row(1,400)]);
      } else if (url.pathname.endsWith(`/${row(2).request_id}/cost`)) body = {...cost(row(2)),...(mode === 'foreign' ? {org_id:'another'} : {})};
      else if (url.pathname.endsWith(`/${row(1).request_id}/cost`)) {
        if (mode === 'missing') { status = 404; body = {error:'Not found'}; }
        else body = {...cost(row(1)),pricing_status:'unpriced',customer_cost_usd:null};
      } else throw new Error('Unexpected endpoint');
      return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    };
    for (mode of ['missing','unpriced']) {
      const result = await accountClaudeSession(session);
      assert.equal(result.requests,2);
      assert.equal(result.failed_requests,1);
      assert.equal(result.priced_cost_usd,0.01);
      assert.equal(result.customer_cost_usd,null);
      assert.deepEqual(result.unpriced_request_ids,[row(1).request_id]);
      assert.equal(result.unmatched_requests,null);
      assert.equal(result.ambiguous_requests,null);
      assert.ok(result.known_gaps.includes('late arrivals possible'));
      assert.equal(result.records[0].provider,undefined);
    }
    mode = 'foreign';
    await assert.rejects(accountClaudeSession(session),/Cost record scope mismatch/);
    mode = 'empty';
    assert.equal((await accountClaudeSession(session)).customer_cost_usd,null);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key,value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root,{recursive:true,force:true});
  }
});
