import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopPaths, desktopProfile, installDesktop, removeDesktop, desktopStatus } from '../dist/claude-desktop.js';
const config={version:1,org:'org_example',project:'example',workload:'coding',environment:'test',gateway_url:'https://gateway.example.com'};
const previous='11111111-1111-4111-8111-111111111111';
function fixture(fn) {
 const home=mkdtempSync(join(tmpdir(),'desktop-profile-')); const paths=desktopPaths(home,join(home,'config'));
 mkdirSync(paths.library,{recursive:true}); writeFileSync(paths.metadata,JSON.stringify({entries:[{id:previous,name:'Personal'}],appliedId:previous,extra:'preserve'}));
 try {fn(paths);} finally {rmSync(home,{recursive:true,force:true});}
}
test('Desktop setup and reconfiguration preserve other profiles and restore original selection',()=>fixture(paths=>{
 installDesktop(config,['claude-sonnet-5'],'/example/cli.js',paths);
 const first=JSON.parse(readFileSync(paths.state));
 installDesktop({...config,workload:'other'},['claude-opus-5'],'/example/cli.js',paths);
 assert.equal(JSON.parse(readFileSync(paths.state)).id,first.id);
 assert.equal(desktopStatus(paths).active,true); assert.equal(desktopStatus(paths).verified,false);
 const profile=JSON.parse(readFileSync(join(paths.library,first.id+'.json')));
 assert.equal(profile.inferenceCustomHeaders['x-understudy-workload'],'other');
 assert.equal(profile.inferenceCredentialKind,'helper-script');
 assert.equal(JSON.stringify(profile).includes('api_key'),false);
 removeDesktop(paths);
 assert.deepEqual(JSON.parse(readFileSync(paths.metadata)),{entries:[{id:previous,name:'Personal'}],appliedId:previous,extra:'preserve'});
 assert.equal(desktopStatus(paths).configured,false);
}));
test('Desktop removal refuses user edits and preserves a different selected profile',()=>fixture(paths=>{
 installDesktop(config,['claude-sonnet-5'],'/example/cli.js',paths);
 const state=JSON.parse(readFileSync(paths.state)), file=join(paths.library,state.id+'.json');
 writeFileSync(file,JSON.stringify({...state.profile,deploymentDisplayName:'My edit'}));
 assert.equal(desktopStatus(paths).drift,true);
 assert.throws(()=>removeDesktop(paths),/user edits/);
 assert.throws(()=>installDesktop(config,['claude-sonnet-5'],'/example/cli.js',paths),/edited/);
 writeFileSync(file,JSON.stringify(state.profile));
 const meta=JSON.parse(readFileSync(paths.metadata));meta.appliedId=previous;writeFileSync(paths.metadata,JSON.stringify(meta));
 removeDesktop(paths);assert.equal(JSON.parse(readFileSync(paths.metadata)).appliedId,previous);
}));
test('Desktop rejects unsupported models and insecure credential destinations',()=>{
 assert.throws(()=>desktopProfile(config,['deepseek-example'],'/cli'),/experimental/);
 assert.throws(()=>desktopProfile({...config,gateway_url:'http://gateway.example.com'},['claude-sonnet-5'],'/cli'),/HTTPS/);
 assert.throws(()=>desktopProfile({...config,gateway_url:'https://user:pass@gateway.example.com'},['claude-sonnet-5'],'/cli'),/credentials/);
});

import { desktopStatusText } from '../dist/commands/claude-desktop.js';
test('Desktop status gives recovery without claiming inference verification',()=>{
 assert.match(desktopStatusText({configured:false,verified:false}),/setup/);
 const healthy={configured:true,verified:false,active:true,drift:false,credentialAvailable:true,helperAvailable:true,config};
 assert.match(desktopStatusText(healthy),/do not verify inference/);
 assert.match(desktopStatusText({...healthy,credentialAvailable:false}),/orchestra login/);
 assert.match(desktopStatusText({...healthy,helperAvailable:false}),/helper is missing/);
 assert.match(desktopStatusText({...healthy,drift:true}),/preserve any profile edits/);
});

import { spawnSync } from 'node:child_process';
test('installer Desktop choice hands off without installing coding-agent plugins',()=>{
 const home=mkdtempSync(join(tmpdir(),'desktop-init-'));
 try {
  const moduleUrl=new URL('../dist/onboarding/init.js',import.meta.url).href;
  const script=`import {runInit} from ${JSON.stringify(moduleUrl)}; const result=await runInit({skipLogin:true},{setup:async()=> 'desktop'},'0.0.0'); if(result.choice!=='desktop'||result.installed.length||result.labStarted)process.exitCode=1;`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,HOME:home},cwd:home});
  assert.equal(result.status,0,result.stderr);
 } finally {rmSync(home,{recursive:true,force:true});}
});
