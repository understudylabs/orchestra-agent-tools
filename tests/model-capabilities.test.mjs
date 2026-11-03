import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerModelsCommand } from '../dist/commands/models.js';
import { parseGatewayModelCapabilities } from '../dist/internal/model-capabilities.js';

const catalog = data => ({object:'list',data});
test('gateway metadata distinguishes unknown, false, malformed and supported without dropping models', () => {
  const models = parseGatewayModelCapabilities(catalog([
    {id:'old-model'},
    {id:'known',wire_shapes:['anthropic-messages'],capabilities:{context_window_tokens:1000,max_output_tokens:100,tool_calls:true,parallel_tool_calls:false,vision:false,private_field:'omit'}},
    {id:'invalid',capabilities:{context_window_tokens:100,max_output_tokens:101}},
    {id:'inconsistent',capabilities:{parallel_tool_calls:true,tool_calls:false}},
    {id:'future-only',capabilities:{future_field:true}},
    {id:'legacy-shape',capabilities:['tools']},
  ]));
  assert.equal(models.length,6);
  assert.deepEqual(models.map(m=>m.capability_status),['unknown','reported','invalid','invalid','unknown','invalid']);
  assert.equal(models[1].capabilities.vision,false);
  assert.equal(models[1].capabilities.parallel_tool_calls,false);
  assert.equal(models[1].capabilities.private_field,undefined);
  assert.equal(models[0].capabilities,null);
  assert.equal(models[2].capabilities,null);
  assert.throws(()=>parseGatewayModelCapabilities(catalog([{id:'same'},{id:'same'}])),/duplicate/);
  assert.throws(()=>parseGatewayModelCapabilities({models:[{id:'legacy'}]}),/raw response omitted/);
});

test('capabilities command reads the gateway catalog with scoped credentials and no mutation', async () => {
  const root=mkdtempSync(join(tmpdir(),'orchestra-capabilities-'));
  const saved=Object.fromEntries(['HOME','UNDERSTUDY_API_KEY','UNDERSTUDY_GATEWAY_URL'].map(key=>[key,process.env[key]]));
  const fetchBefore=globalThis.fetch;
  const writeBefore=process.stdout.write;
  let output='';
  try {
    process.env.HOME=root;
    process.env.UNDERSTUDY_API_KEY='synthetic-capabilities-key';
    process.env.UNDERSTUDY_GATEWAY_URL='https://synthetic.example.test';
    globalThis.fetch=async (url, init)=>{
      assert.equal(String(url),'https://synthetic.example.test/v1/models');
      assert.equal(init.method,'GET');
      assert.equal(init.headers.Authorization,'Bearer synthetic-capabilities-key');
      assert.equal(init.body,undefined);
      return new Response(JSON.stringify(catalog([{id:'exact-model',capabilities:{tool_calls:false}},{id:'other'}])),{headers:{'content-type':'application/json'}});
    };
    process.stdout.write=function(chunk){output+=String(chunk);return true;};
    const program=new Command();
    registerModelsCommand(program);
    await program.parseAsync(['models','capabilities','exact-model','--org','org_example','--json'],{from:'user'});
    const report=JSON.parse(output);
    assert.equal(report.models.length,1);
    assert.equal(report.models[0].id,'exact-model');
    assert.equal(report.models[0].capabilities.tool_calls,false);
    assert.match(report.note,/not a Claude compatibility test/);
  } finally {
    process.stdout.write=writeBefore;
    globalThis.fetch=fetchBefore;
    for(const [key,value] of Object.entries(saved)) value===undefined?delete process.env[key]:process.env[key]=value;
    rmSync(root,{recursive:true,force:true});
  }
});
