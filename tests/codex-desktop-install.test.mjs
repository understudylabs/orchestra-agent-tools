import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const source = readFileSync('install.sh', 'utf8');
const install = source.slice(source.indexOf('install_codex_plugin() {'), source.indexOf('\nlink_opencode_path()'));
function run(home) {
  return spawnSync('bash', ['-c', `
    should_install_codex_adapter() { return 0; }
    need() { [ "$1" != codex ]; }
    resolve_plugin_repo() { printf '%s' "$REPO"; }
    say() { printf '%s\\n' "$*"; }
    ok() { say "$*"; }
    warn() { say "$*"; }
    record_adapter() { say "$*"; }
    record_adapter_failure() { say "FAILED $*"; }
    adapter_prereq_missing() { say "FAILED $*"; }
    ${install}
    install_codex_plugin
  `], { env: { ...process.env, HOME: home, REPO: resolve('.'), LOG_FILE: join(home, 'install.log') }, encoding: 'utf8' });
}
test('Desktop-only registration preserves personal plugins and is repeatable without calling Codex', () => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-plugin-'));
  try {
    const dir = join(home, '.agents/plugins'); mkdirSync(dir, { recursive: true });
    const file = join(dir, 'marketplace.json');
    const original = JSON.stringify({ name: 'my-tools', plugins: [{ name: 'other', source: { source: 'local', path: './other' } }] });
    writeFileSync(file, original);
    for (let i=0; i<2; i++) {
      const result = run(home); assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout, /FAILED/);
      assert.match(result.stdout, /no Codex CLI required/);
    }
    const catalog = JSON.parse(readFileSync(file));
    assert.equal(catalog.name, 'my-tools'); assert.equal(catalog.plugins.length, 2);
    assert.deepEqual(catalog.plugins[0], JSON.parse(original).plugins[0]);
    assert.equal(catalog.plugins[1].source.package, '@orchestraai/agent-tools');
    assert.equal(catalog.plugins[1].source.version, JSON.parse(readFileSync('package.json')).version);
    assert.equal(readFileSync(file + '.orchestra-backup', 'utf8'), original);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('Desktop registration creates a personal catalog and preserves malformed or conflicting existing files', () => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-plugin-'));
  try {
    assert.doesNotMatch(run(home).stdout, /FAILED/);
    const file = join(home, '.agents/plugins/marketplace.json');
    assert.equal(JSON.parse(readFileSync(file)).plugins[0].name, 'orchestra');
    for (const original of ['not-json', JSON.stringify({name:'personal',plugins:[{name:'orchestra',source:{source:'local',path:'./custom'}}]})]) {
      writeFileSync(file,original);assert.match(run(home).stdout,/FAILED/);assert.equal(readFileSync(file,'utf8'),original);
    }
  } finally { rmSync(home, { recursive:true, force:true }); }
});
