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
