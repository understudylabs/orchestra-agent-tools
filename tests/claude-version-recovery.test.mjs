import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareClaudeVersion } from '../dist/commands/claude-setup.js';

function fixture(versions, actions = [], updates = []) {
  const messages = [];
  let updateCalls = 0;
  return {
    messages,
    get updateCalls() { return updateCalls; },
    deps: {
      check: () => {
        const value = versions.shift();
        if (value instanceof Error) throw value;
        assert.ok(value, 'unexpected extra version check');
        return value;
      },
      interactive: true,
      choose: async () => { assert.ok(actions.length); return actions.shift(); },
      update: async () => { updateCalls++; return updates.shift(); },
      write: message => messages.push(message),
    },
  };
}
const old = () => new Error('Detected 2.1.100; requires 2.1.312');
test('supported Claude proceeds without prompting or updating', async () => {
  const f = fixture(['2.1.312']);
  assert.equal(await prepareClaudeVersion(f.deps), '2.1.312');
  assert.equal(f.updateCalls, 0);
});
test('outdated Claude updates only after selection and verifies the new version', async () => {
  const f = fixture([old(), '2.1.312'], ['update'], [true]);
  assert.equal(await prepareClaudeVersion(f.deps), '2.1.312');
  assert.equal(f.updateCalls, 1);
});
test('successful updater that still returns an old version cannot enable setup', async () => {
  const f = fixture([old(), old()], ['update', 'skip'], [true]);
  assert.equal(await prepareClaudeVersion(f.deps), undefined);
  assert.equal(f.updateCalls, 1);
});
test('failed update can recover after external package manager update', async () => {
  const f = fixture([old(), old(), '2.1.313'], ['update', 'retry'], [false]);
  assert.equal(await prepareClaudeVersion(f.deps), '2.1.313');
  assert.ok(f.messages.some(message => message.includes('did not complete')));
});
test('missing Claude can be skipped without updating', async () => {
  const f = fixture([new Error('Claude not found')], ['skip']);
  assert.equal(await prepareClaudeVersion(f.deps), undefined);
  assert.equal(f.updateCalls, 0);
});
test('noninteractive setup fails with actionable guidance and never updates', async () => {
  const f = fixture([old()]);
  f.deps.interactive = false;
  await assert.rejects(prepareClaudeVersion(f.deps), /brew upgrade.*No gateway settings were changed/);
  assert.equal(f.updateCalls, 0);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
test('real noninteractive setup with old Claude preserves settings even with --yes', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchestra-old-claude-'));
  try {
    mkdirSync(join(home, 'bin'));
    mkdirSync(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    const before = '{"theme":"dark"}\n';
    writeFileSync(settings, before);
    writeFileSync(join(home, 'bin', 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.100 (Claude Code)"; else exit 99; fi\n', { mode: 0o755 });
    const result = spawnSync(process.execPath, [resolve('dist/bin.js'), 'claude-setup', '--yes'], {
      env: { ...process.env, HOME: home, UNDERSTUDY_HOME: join(home, '.orchestra'), CLAUDE_CONFIG_DIR: join(home, '.claude'), PATH: join(home, 'bin'), UNDERSTUDY_TELEMETRY: '0' }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /claude update/);
    assert.equal(readFileSync(settings, 'utf8'), before);
    assert.equal(existsSync(join(home, '.orchestra', 'claude-native.json')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
