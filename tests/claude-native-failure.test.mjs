import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeModSource } from '../dist/claude-native.js';

// Opt-in real harness: a failed synthetic helper must finish without inference.
test('Claude stops cleanly when native initialization fails', {skip:!process.env.CLAUDE_TEST_BINARY}, async () => {
  const home=await mkdtemp(join(tmpdir(),'orchestra-native-failure-'));
  try {
    const plugin=join(home,'plugin');
    await mkdir(join(plugin,'.claude-plugin'),{recursive:true});
    await mkdir(join(plugin,'hooks'));
    await writeFile(join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'orchestra-gateway',version:'0.1.0'}));
    await writeFile(join(plugin,'hooks','hooks.json'),JSON.stringify({modules:['./register.js']}));
    await writeFile(join(plugin,'hooks','register.js'),nativeModSource([process.execPath,'-e','process.exit(1)']));
    await writeFile(join(home,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true}));
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(UNDERSTUDY_|ANTHROPIC_|CLAUDE_|CLAUDECODE|NODE_OPTIONS)/.test(key)));
    Object.assign(env,{HOME:home,CLAUDE_CONFIG_DIR:home,ANTHROPIC_AUTH_TOKEN:'synthetic-local-only',ANTHROPIC_BASE_URL:'http://127.0.0.1:1',CLAUDE_CODE_PLUGIN_DIRS:plugin,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'});
    const {stdout,stderr}=await promisify(execFile)(process.env.CLAUDE_TEST_BINARY,['-p','Reply synthetic ok','--model','deepseek-v4.1-flash-1017[1m]','--tools','','--setting-sources','user','--output-format','json'],{env,cwd:home,timeout:20000});
    const result=JSON.parse(stdout);
    assert.match(result.result,/Orchestra could not initialize/);
    assert.doesNotMatch(stdout+stderr,/wrong shape|ECONNREFUSED/);
    assert.equal(result.total_cost_usd,0);
  } finally { await rm(home,{recursive:true,force:true}); }
});
