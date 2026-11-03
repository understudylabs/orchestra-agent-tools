import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt-in real-harness check: all model traffic terminates at the local synthetic server.
test('Claude scopes a 1M suffix locally and sends the exact gateway model ID', {skip:!process.env.CLAUDE_TEST_BINARY}, async () => {
  const home=await mkdtemp(join(tmpdir(),'orchestra-context-'));
  const models=[];
  const server=createServer(async (req,res) => {
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    models.push(body.model);
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'msg_synthetic',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'synthetic ok'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:3}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await writeFile(join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true}));
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(ANTHROPIC_|CLAUDE_|CLAUDECODE)/.test(key)));
    Object.assign(env,{HOME:home,CLAUDE_CONFIG_DIR:home,ANTHROPIC_AUTH_TOKEN:'synthetic-local-only',ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
    const {stdout}=await promisify(execFile)(process.env.CLAUDE_TEST_BINARY,['-p','Reply synthetic ok','--model','deepseek-v4.1-flash-1017[1m]','--tools','','--setting-sources','user','--output-format','json'],{env,cwd:home,timeout:30000});
    const result=JSON.parse(stdout);
    assert.equal(result.is_error,false);
    assert.equal(result.modelUsage['deepseek-v4.1-flash-1017[1m]'].contextWindow,1000000);
    assert.ok(models.length>0);
    assert.ok(models.every(model=>model==='deepseek-v4.1-flash-1017'));
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await rm(home,{recursive:true,force:true});
  }
});
