import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { claudeUpdateCommand } from '../dist/claude-native.js';
for (const cask of ['claude-code', 'claude-code@latest']) {
  test(`active ${cask} cask uses its Homebrew upgrade command`, () => {
    const root = mkdtempSync(join(tmpdir(), 'orchestra-brew-'));
    try {
      const bin = join(root,'bin'); mkdirSync(bin);
      const caskDir = join(root,'Caskroom',cask,'2.1.100'); mkdirSync(caskDir,{recursive:true});
      const target = join(caskDir,'claude'); writeFileSync(target,'#!/bin/sh\n',{mode:0o755});
      symlinkSync(target,join(bin,'claude'));
      assert.deepEqual(claudeUpdateCommand(bin),{command:'brew',args:['upgrade',cask]});
      const native = join(root,'native'); mkdirSync(native); writeFileSync(join(native,'claude'),'#!/bin/sh\n',{mode:0o755});
      assert.deepEqual(claudeUpdateCommand([native,bin].join(delimiter)),{command:'claude',args:['update']});
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
}

import { spawnSync } from 'node:child_process';
test('version gate accepts validated Homebrew stable and rejects earlier unvalidated versions', () => {
  const root=mkdtempSync(join(tmpdir(),'orchestra-version-floor-'));
  const moduleUrl=new URL('../dist/claude-native.js',import.meta.url).href;
  try {
    for (const [version,accepted] of [['2.1.308',false],['2.1.309',true],['2.1.312',true],['2.2.0',true]]) {
      writeFileSync(join(root,'claude'),`#!/bin/sh\necho '${version} (Claude Code)'\n`,{mode:0o755});
      const result=spawnSync(process.execPath,['--input-type=module','-e',`import {checkClaudeVersion} from ${JSON.stringify(moduleUrl)};checkClaudeVersion();`],{env:{...process.env,PATH:root},encoding:'utf8'});
      assert.equal(result.status===0,accepted,result.stderr);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});
