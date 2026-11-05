import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeModSource } from '../dist/claude-native.js';

const moduleUrl = new URL('../dist/claude-native.js', import.meta.url).href;
test('persistent setup, native session/resume, unknown git, and ownership-aware removal', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchestra-native-'));
  try {
    mkdirSync(join(home,'.understudy'));
    writeFileSync(join(home,'.understudy','credentials.json'), JSON.stringify({orgs:{org_example:{api_key:'synthetic-key',gateway_url:'https://gateway.example.com'}}}), {mode:0o600});
    const script = `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
      import { join } from 'node:path';
      import { enableNativeClaude, removeNativeClaude, nativeClaudeEnvironment, claudeSettingsPath, BLOCKED_GATEWAY, refreshNativeClaudeModels } from ${JSON.stringify(moduleUrl)};
      const settings = claudeSettingsPath(); mkdirSync(join(process.env.HOME,'.claude'));
      const before={env:{ANTHROPIC_API_KEY:'previous-key',KEEP:'yes'},theme:'dark',model:'previous-model',modelSettings:{'claude-example':{effortLevel:'high'}},hooks:{SessionStart:[]}};
      writeFileSync(settings,JSON.stringify(before));
      const config={version:1,org:'org_example',project:'example',workload:'coding',environment:'test',gateway_url:'https://gateway.example.com',model:'claude-example'};
      enableNativeClaude(config,${JSON.stringify(resolve('dist/bin.js'))});
      const enabled=JSON.parse(readFileSync(settings));
      assert.equal(enabled.modelSettings['deepseek-v4.1-flash-1017'].autoCompactWindow,786432);
      assert.equal(enabled.env.ANTHROPIC_BASE_URL,BLOCKED_GATEWAY);
      assert.equal(enabled.env.ANTHROPIC_API_KEY,'');
      assert.equal(enabled.env.ANTHROPIC_AUTH_TOKEN,'orchestra-initialization-required');
      assert.equal(enabled.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,undefined);
      assert.equal(enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,'Orchestra Flash');
      const upgradeStatePath=join(process.env.HOME,'.understudy','claude-native.json');
      const upgradeState=JSON.parse(readFileSync(upgradeStatePath));
      enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=upgradeState.installed.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='DeepSeek V4.1 Flash 1017';
      enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION=upgradeState.installed.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION='Through Orchestra';
      enabled.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS='1048576';
      upgradeState.installed.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS='1048576';
      enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION=upgradeState.installed.env.ANTHROPIC_CUSTOM_MODEL_OPTION='deepseek-v4.1-flash-1017';
      writeFileSync(settings,JSON.stringify(enabled));
      writeFileSync(upgradeStatePath,JSON.stringify(upgradeState));
      assert.equal(refreshNativeClaudeModels().changed,true);
      assert.equal(JSON.parse(readFileSync(settings)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,undefined);
      assert.equal(JSON.parse(readFileSync(settings)).env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,'Orchestra Flash');
      enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='Orchestra Flash';
      enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION='Fast coding through Orchestra';
      delete enabled.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION='deepseek-v4.1-flash-1017[1m]';
      assert.equal(JSON.parse(readFileSync(settings)).env.ANTHROPIC_CUSTOM_MODEL_OPTION,enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION);
      const profilePath=join(process.env.HOME,'.claude.json');
      const profile=JSON.parse(readFileSync(profilePath));
      assert.equal(profile.hasCompletedOnboarding,true);
      profile.theme='light';writeFileSync(profilePath,JSON.stringify(profile));
      assert.equal(enabled.env.ANTHROPIC_CUSTOM_MODEL_OPTION,'deepseek-v4.1-flash-1017[1m]');
      assert.equal(refreshNativeClaudeModels().changed,false);
      for (const key of ['ANTHROPIC_MODEL','ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL','ANTHROPIC_DEFAULT_HAIKU_MODEL']) assert.equal(enabled.env[key],undefined);
      assert.ok(!readFileSync(settings,'utf8').includes('synthetic-key'));
      assert.equal(statSync(settings).mode&0o777,0o600);
      assert.throws(()=>enableNativeClaude(config,'cli'),/already enabled/);
      const id='11111111-1111-4111-8111-111111111111';
      const first=nativeClaudeEnvironment(id,process.env.HOME);
      assert.equal(first.ANTHROPIC_API_KEY,'synthetic-key');
      assert.deepEqual(nativeClaudeEnvironment(id,process.env.HOME),first);
      assert.ok(!first.ANTHROPIC_CUSTOM_HEADERS.includes('"repository"'));
      assert.throws(()=>nativeClaudeEnvironment('../escape',process.env.HOME));
      enabled.theme='light'; enabled.env.KEEP='changed'; enabled.model='user-choice';
      enabled.env.CLAUDE_CODE_PLUGIN_DIRS += ':/tmp/another-plugin';
      writeFileSync(settings,JSON.stringify(enabled));
      const removed=removeNativeClaude();
      const after=JSON.parse(readFileSync(settings));
      assert.equal(after.env.ANTHROPIC_API_KEY,'previous-key');
      assert.equal(JSON.parse(readFileSync(profilePath)).hasCompletedOnboarding,undefined);
      assert.equal(JSON.parse(readFileSync(profilePath)).theme,'light');
      assert.equal(after.env.ANTHROPIC_BASE_URL,undefined);
      assert.equal(after.env.ANTHROPIC_CUSTOM_MODEL_OPTION,undefined);
      assert.equal(after.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,undefined);
      assert.deepEqual(after.modelSettings,before.modelSettings);
      assert.equal(after.model,'user-choice'); assert.equal(after.theme,'light');
      assert.equal(after.env.KEEP,'changed'); assert.equal(after.env.CLAUDE_CODE_PLUGIN_DIRS,'/tmp/another-plugin');
      assert.deepEqual(removed.preserved_user_edits,['model']);
      assert.throws(()=>nativeClaudeEnvironment(id),/not enabled/);
      delete config.model;
      enableNativeClaude(config,${JSON.stringify(resolve('dist/bin.js'))});
      const unpinned=JSON.parse(readFileSync(settings));
      assert.equal(unpinned.model,'user-choice');
      unpinned.model='next-picker-choice'; writeFileSync(settings,JSON.stringify(unpinned));
      const switched=nativeClaudeEnvironment('22222222-2222-4222-8222-222222222222',process.env.HOME);
      assert.equal(switched.ANTHROPIC_MODEL,undefined);
      removeNativeClaude();
      assert.equal(JSON.parse(readFileSync(settings)).model,'next-picker-choice');
      const custom=JSON.parse(readFileSync(settings));
      custom.env.ANTHROPIC_CUSTOM_MODEL_OPTION='user-model';
      custom.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='User model';
      writeFileSync(settings,JSON.stringify(custom));
      enableNativeClaude(config,${JSON.stringify(resolve('dist/bin.js'))});
      assert.equal(refreshNativeClaudeModels().changed,false);
      assert.equal(JSON.parse(readFileSync(settings)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,undefined);
      assert.equal(JSON.parse(readFileSync(settings)).env.ANTHROPIC_CUSTOM_MODEL_OPTION,'user-model');
      removeNativeClaude();
      assert.equal(JSON.parse(readFileSync(settings)).env.ANTHROPIC_CUSTOM_MODEL_OPTION,'user-model');
      delete custom.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
      delete custom.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME;
      writeFileSync(settings,JSON.stringify(custom));
      enableNativeClaude(config,${JSON.stringify(resolve('dist/bin.js'))});
      const withWindow=JSON.parse(readFileSync(settings));
      withWindow.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS='262144';
      writeFileSync(settings,JSON.stringify(withWindow));
      assert.equal(refreshNativeClaudeModels().changed,false);
      assert.equal(JSON.parse(readFileSync(settings)).env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,'262144');
      withWindow.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME='My preferred label';
      writeFileSync(settings,JSON.stringify(withWindow));
      assert.equal(refreshNativeClaudeModels().changed,false);
      assert.equal(JSON.parse(readFileSync(settings)).env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME,'My preferred label');
      const statePath=join(process.env.HOME,'.understudy','claude-native.json');
      const legacy=JSON.parse(readFileSync(statePath));
      const legacySettings=JSON.parse(readFileSync(settings));
      for(const key of Object.keys(legacy.installed.env).filter(k=>k.startsWith('ANTHROPIC_CUSTOM_MODEL_OPTION'))) {
        delete legacy.installed.env[key]; delete legacySettings.env[key];
      }
      writeFileSync(statePath,JSON.stringify(legacy)); writeFileSync(settings,JSON.stringify(legacySettings));
      assert.equal(refreshNativeClaudeModels().changed,true);
      assert.equal(refreshNativeClaudeModels().changed,false);
      assert.equal(JSON.parse(readFileSync(settings)).model,'next-picker-choice');
      removeNativeClaude();
      assert.equal(JSON.parse(readFileSync(settings)).env.ANTHROPIC_CUSTOM_MODEL_OPTION,undefined);


    `;
    const env = {...process.env, HOME:home, CLAUDE_CONFIG_DIR:''};
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_PLUGIN_DIRS$)/.test(key)) delete env[key];
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',cwd:home});
    assert.equal(result.status,0,result.stderr);
  } finally { rmSync(home,{recursive:true,force:true}); }
});

test('native mod applies credentials only after attribution and blocks failed steps', async () => {
  const source=nativeModSource(['node','example-cli','claude-native-env']);
  const mod=await import('data:text/javascript,'+encodeURIComponent(source));
  const handlers={}; mod.register((name,handler)=>{handlers[name]=handler;});
  const writes=[]; let succeed=true;
  const $={env:{get:async()=>undefined,set:async(k,v)=>writes.push([k,v])},session:{id:async()=> 'id'},process:{run:async()=>({exitCode:succeed?0:1,stdout:JSON.stringify({ANTHROPIC_CUSTOM_HEADERS:'session-header',ANTHROPIC_API_KEY:'synthetic',ANTHROPIC_BASE_URL:'https://gateway.example.com'})})},ui:{log:()=>{}}};
  let next=0;
  await handlers['session.start']($,{},async()=>{next++;});
  assert.equal(writes[0][1],'http://127.0.0.1:1');
  assert.equal(writes.at(-1)[1],'https://gateway.example.com');
  assert.equal(next,1);
  const initialized=Object.fromEntries(writes);
  assert.equal(initialized.ANTHROPIC_AUTH_TOKEN,'synthetic');
  assert.equal(initialized.ANTHROPIC_API_KEY,'');
  assert.equal(initialized.ANTHROPIC_CUSTOM_HEADERS,'session-header');
  succeed=false;
  for await (const value of handlers['turn.step']($,{},async function*(){next++;yield 1;})) assert.fail('failed initialization yielded inference');
  assert.equal(next,1);
  assert.deepEqual(writes.at(-1),['ANTHROPIC_API_KEY','orchestra-initialization-required']);
});

import { verifySessionCapture } from '../dist/claude-reconciliation.js';
test('missing git attribution stays absent in flat string tags and capture verification', () => {
  const session={session_id:'session',environment:'test',repository:null,branch:null,base_commit:null};
  const capture={request_id:'request',request_environment:'test',tags:{run_id:'session',harness:'claude-code'},customer_request_body:{messages:[]},response_body:{content:[]}};
  verifySessionCapture(capture,session,'request');
  assert.throws(()=>verifySessionCapture({...capture,tags:{...capture.tags,repository:'invented/repo'}},session,'request'),/Unexpected/);
});

test('repair migrates legacy auth without replacing routing, model, edits, or uninstall backup', () => {
  const home=mkdtempSync(join(tmpdir(),'orchestra-repair-'));
  try {
    mkdirSync(join(home,'.understudy'));
    mkdirSync(join(home,'bin'));
    writeFileSync(join(home,'bin','claude'),'#!/bin/sh\necho "2.1.309 (Claude Code)"\n',{mode:0o700});
    writeFileSync(join(home,'.understudy','credentials.json'),JSON.stringify({orgs:{org_example:{api_key:'synthetic-key',gateway_url:'https://gateway.example.com'}}}));
    const script=`
      import assert from 'node:assert/strict';
      import {readFileSync,writeFileSync,rmSync} from 'node:fs';
      import {join} from 'node:path';
      import {enableNativeClaude,repairNativeClaude,nativeClaudeHookStatus,readNativeState,removeNativeClaude,claudeSettingsPath} from ${JSON.stringify(moduleUrl)};
      const config={version:1,org:'org_example',project:'example',workload:'coding',environment:'test',gateway_url:'https://gateway.example.com'};
      enableNativeClaude(config,'old-cli');
      assert.equal(nativeClaudeHookStatus(),'current');
      writeFileSync(join(process.env.HOME,'.understudy','claude-native-mod','hooks','register.js'),'old hook');
      assert.equal(nativeClaudeHookStatus(),'outdated_or_modified');
      const statePath=join(process.env.HOME,'.understudy','claude-native.json');
      const state=readNativeState();
      const current=JSON.parse(readFileSync(claudeSettingsPath()));
      state.installed.env.ANTHROPIC_API_KEY=current.env.ANTHROPIC_API_KEY='orchestra-initialization-required';
      state.installed.env.ANTHROPIC_AUTH_TOKEN=current.env.ANTHROPIC_AUTH_TOKEN='';
      current.model='user-selected'; current.theme='light';
      writeFileSync(statePath,JSON.stringify(state));writeFileSync(claudeSettingsPath(),JSON.stringify(current));
      repairNativeClaude('new-cli');repairNativeClaude('new-cli');
      assert.equal(nativeClaudeHookStatus(),'current');
      for (const file of ['hooks/hooks.json','.claude-plugin/plugin.json']) {
        const path=join(process.env.HOME,'.understudy','claude-native-mod',file);
        rmSync(path);
        assert.equal(nativeClaudeHookStatus(),'missing');
        repairNativeClaude('new-cli');
        assert.equal(nativeClaudeHookStatus(),'current');
        writeFileSync(path,'invalid json');
        assert.equal(nativeClaudeHookStatus(),'outdated_or_modified');
        repairNativeClaude('new-cli');
        assert.equal(nativeClaudeHookStatus(),'current');
      }
      const repaired=JSON.parse(readFileSync(claudeSettingsPath()));
      assert.equal(repaired.env.ANTHROPIC_API_KEY,'');
      assert.equal(repaired.env.ANTHROPIC_AUTH_TOKEN,'orchestra-initialization-required');
      assert.equal(repaired.model,'user-selected');assert.equal(repaired.theme,'light');
      assert.deepEqual(readNativeState().before,state.before);
      assert.deepEqual(readNativeState().config,config);
      repaired.env.ANTHROPIC_AUTH_TOKEN='user-override';writeFileSync(claudeSettingsPath(),JSON.stringify(repaired));
      assert.deepEqual(repairNativeClaude('new-cli').preserved_user_edits,['env.ANTHROPIC_AUTH_TOKEN']);
      removeNativeClaude();
      const removed=JSON.parse(readFileSync(claudeSettingsPath()));
      assert.equal(removed.env.ANTHROPIC_AUTH_TOKEN,'user-override');
      assert.equal(removed.model,'user-selected');
    `;
    const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:'',PATH:join(home,'bin')+':'+process.env.PATH};
    for(const key of Object.keys(env)) if(/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_PLUGIN_DIRS$)/.test(key)) delete env[key];
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',cwd:home});
    assert.equal(result.status,0,result.stderr);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('compaction preset preserves explicit windows and later model settings edits', () => {
  const home=mkdtempSync(join(tmpdir(),'orchestra-compaction-'));
  try {
    mkdirSync(join(home,'.understudy'));
    writeFileSync(join(home,'.understudy','credentials.json'),JSON.stringify({orgs:{org_example:{api_key:'synthetic-key',gateway_url:'https://gateway.example.com'}}}));
    const script=`
      import assert from 'node:assert/strict';
      import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
      import {dirname} from 'node:path';
      import {enableNativeClaude,removeNativeClaude,refreshNativeClaudeModels,claudeSettingsPath} from ${JSON.stringify(moduleUrl)};
      const model='deepseek-v4.1-flash-1017';
      const path=claudeSettingsPath(); mkdirSync(dirname(path),{recursive:true});
      const config={version:1,org:'org_example',project:'example',workload:'coding',environment:'test',gateway_url:'https://gateway.example.com'};
      for(const before of [
        {modelSettings:{[model]:{autoCompactWindow:250000,effortLevel:'high'}}},
        {autoCompactWindow:300000},
        {env:{CLAUDE_CODE_AUTO_COMPACT_WINDOW:'350000'}},
      ]) {
        writeFileSync(path,JSON.stringify(before));
        enableNativeClaude(config,'example-cli');
        refreshNativeClaudeModels();
        const enabled=JSON.parse(readFileSync(path));
        assert.equal(enabled.modelSettings?.[model]?.autoCompactWindow,before.modelSettings?.[model]?.autoCompactWindow);
        removeNativeClaude();
        assert.deepEqual(JSON.parse(readFileSync(path)),before);
      }
      const explicit={model,env:{CLAUDE_CODE_MAX_CONTEXT_TOKENS:'262144'}};
      writeFileSync(path,JSON.stringify(explicit));
      enableNativeClaude(config,'example-cli'); refreshNativeClaudeModels();
      assert.equal(JSON.parse(readFileSync(path)).model,model);
      assert.equal(JSON.parse(readFileSync(path)).env.ANTHROPIC_CUSTOM_MODEL_OPTION,model);
      removeNativeClaude(); assert.deepEqual(JSON.parse(readFileSync(path)),explicit);
      for (const laterChoice of [undefined, 'another-model']) {
        writeFileSync(path,'{}'); enableNativeClaude(config,'example-cli');
        const selected=JSON.parse(readFileSync(path)); selected.model=model;
        writeFileSync(path,JSON.stringify(selected));
        assert.equal(refreshNativeClaudeModels().changed,true);
        assert.equal(JSON.parse(readFileSync(path)).model,model+'[1m]');
        assert.equal(refreshNativeClaudeModels().changed,false);
        if(laterChoice) {
          const changed=JSON.parse(readFileSync(path)); changed.model=laterChoice;
          writeFileSync(path,JSON.stringify(changed));
        }
        removeNativeClaude();
        assert.equal(JSON.parse(readFileSync(path)).model,laterChoice ?? model);
      }
      writeFileSync(path,JSON.stringify({model}));
      enableNativeClaude(config,'example-cli');
      assert.equal(JSON.parse(readFileSync(path)).model,model+'[1m]');
      removeNativeClaude();
      assert.equal(JSON.parse(readFileSync(path)).model,model);
      writeFileSync(path,'{}'); enableNativeClaude(config,'example-cli');
      const edited=JSON.parse(readFileSync(path));
      edited.modelSettings[model]={autoCompactWindow:400000,effortLevel:'high'};
      edited.modelSettings['another-model']={effortLevel:'low'};
      writeFileSync(path,JSON.stringify(edited));
      refreshNativeClaudeModels(); removeNativeClaude();
      assert.deepEqual(JSON.parse(readFileSync(path)).modelSettings,edited.modelSettings);
    `;
    const env={...process.env,HOME:home,CLAUDE_CONFIG_DIR:''};
    for(const key of Object.keys(env)) if(/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_PLUGIN_DIRS$)/.test(key)) delete env[key];
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',cwd:home});
    assert.equal(result.status,0,result.stderr);
  } finally {rmSync(home,{recursive:true,force:true});}
});

 for (const entrypoint of ['claude-desktop','claude-desktop-3p']) test('Desktop '+entrypoint+' never initializes terminal routing', async () => {
  const mod=await import('data:text/javascript,'+encodeURIComponent(nativeModSource(['unused'])));
  const handlers={}; mod.register((name, handler)=>{handlers[name]=handler;});
  const $={env:{get:async name=>{assert.equal(name,'CLAUDE_CODE_ENTRYPOINT');return entrypoint;},set:()=>assert.fail('overwrote Desktop routing')},process:{run:()=>assert.fail('loaded terminal credentials')}};
  let next=0;
  await handlers['session.start']($,{},async()=>{next++;});
  for await (const value of handlers['turn.step']($,{},async function*(){next++;yield 'ok';})) assert.equal(value,'ok');
  assert.equal(next,2);
});

test('terminal setup leaves Desktop settings untouched and migrates legacy shared routing',()=>{
 const home=mkdtempSync(join(tmpdir(),'orchestra-desktop-isolation-'));
 try {
  mkdirSync(join(home,'.understudy'));mkdirSync(join(home,'.claude'));mkdirSync(join(home,'bin'));
  writeFileSync(join(home,'.understudy','credentials.json'),JSON.stringify({orgs:{org_example:{api_key:'synthetic',gateway_url:'https://gateway.example.com'}}}));
  writeFileSync(join(home,'bin','claude'),'#!/bin/sh\necho "2.1.312 (Claude Code)"\n',{mode:0o700});
  const script=`
   import assert from 'node:assert/strict';
   import {readFileSync,writeFileSync,renameSync} from 'node:fs';
   import {join} from 'node:path';
   import {enableNativeClaude,repairNativeClaude,removeNativeClaude,claudeSettingsPath} from ${JSON.stringify(moduleUrl)};
   const h=process.env.HOME, shared=join(h,'.claude','settings.json'), statePath=join(h,'.understudy','claude-native.json');
   const original=JSON.stringify({theme:'dark',env:{KEEP:'yes'}});writeFileSync(shared,original);
   const config={version:1,org:'org_example',project:'example',workload:'coding',environment:'test',gateway_url:'https://gateway.example.com'};
   enableNativeClaude(config,'example-cli');
   assert.equal(readFileSync(shared,'utf8'),original);
   removeNativeClaude();assert.equal(readFileSync(shared,'utf8'),original);
   enableNativeClaude(config,'example-cli');
   const state=JSON.parse(readFileSync(statePath));state.settings_path=shared;state.before={theme:'dark',env:{ANTHROPIC_API_KEY:'old-key',KEEP:'yes'}};
   renameSync(claudeSettingsPath(),shared);const legacySettings=JSON.parse(readFileSync(shared));legacySettings.theme='dark';legacySettings.env.KEEP='yes';writeFileSync(shared,JSON.stringify(legacySettings));writeFileSync(statePath,JSON.stringify(state));
   repairNativeClaude('example-cli');
   const restored=JSON.parse(readFileSync(shared));assert.equal(restored.theme,'dark');assert.equal(restored.env.KEEP,'yes');
   assert.equal(Object.keys(restored.env).some(k=>k.startsWith('ANTHROPIC_')),false);
   assert.equal(JSON.parse(readFileSync(statePath)).settings_path,claudeSettingsPath());
   assert.ok(readFileSync(join(h,'.zshrc'),'utf8').includes('claude-native-launch'));
   writeFileSync(join(h,'.zshrc'),readFileSync(join(h,'.zshrc'),'utf8')+'\\n# user addition\\n');
   removeNativeClaude();assert.equal(JSON.parse(readFileSync(shared)).env.ANTHROPIC_API_KEY,undefined);
   assert.equal(readFileSync(join(h,'.zshrc'),'utf8'),'\\n# user addition\\n');
  `;
  const env={...process.env,HOME:home,ZDOTDIR:home,SHELL:'/bin/zsh',PATH:join(home,'bin')+':'+process.env.PATH};
  for(const k of Object.keys(env))if(/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_PLUGIN_DIRS$)/.test(k))delete env[k];
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,cwd:home,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('terminal launcher forwards arguments and fails closed when private settings are missing', () => {
 const home=mkdtempSync(join(tmpdir(),'orchestra-launch-test-'));
 try {
  mkdirSync(join(home,'.understudy'));mkdirSync(join(home,'bin'));
  writeFileSync(join(home,'.understudy','credentials.json'),JSON.stringify({orgs:{org_example:{api_key:'synthetic',gateway_url:'https://gateway.example.com'}}}),{mode:0o600});
  writeFileSync(join(home,'bin','claude'),'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.312 (Claude Code)"; else printf "%s\\n" "$@"; fi\n',{mode:0o700});
  const script=`
   import assert from 'node:assert/strict';
   import {unlinkSync} from 'node:fs';
   import {enableNativeClaude,launchNativeClaude,claudeSettingsPath} from ${JSON.stringify(moduleUrl)};
   enableNativeClaude({version:1,org:'org_example',project:'example',workload:'coding',environment:'test',gateway_url:'https://gateway.example.com'},'example-cli');
   await launchNativeClaude(['--resume','a session']);
   unlinkSync(claudeSettingsPath());
   await assert.rejects(()=>launchNativeClaude([]),/settings are missing/);
  `;
  const env={...process.env,HOME:home,ZDOTDIR:home,SHELL:'/bin/zsh',PATH:join(home,'bin')+':'+process.env.PATH};
  for(const k of Object.keys(env))if(/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_PLUGIN_DIRS$)/.test(k))delete env[k];
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,cwd:home,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/--settings\n[^\n]+claude-terminal-settings.json\n--resume\na session/);
 }finally{rmSync(home,{recursive:true,force:true});}
});
