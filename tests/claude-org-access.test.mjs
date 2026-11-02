import assert from 'node:assert/strict';
import test from 'node:test';
import { accessibleOrganization } from '../dist/commands/claude-setup.js';
import { UnderstudyApiError } from '../dist/internal/http.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const choices = [{ name: 'Example A', value: 'org_a' }, { name: 'Example B', value: 'org_b' }];
function denied(status = 403) { return new UnderstudyApiError({ status, errorType: 'authorization_error', message: 'denied', requestId: 'request_example' }); }
test('denied org can recover to another without retrying wrong credential', async () => {
  const loaded = [];
  const result = await accessibleOrganization(choices, 'org_a', {
    interactive: true, pick: async available => { assert.deepEqual(available, [choices[1]]); return 'org_b'; },
    load: async org => { loaded.push(org); if (org === 'org_a') throw denied(); return []; },
    recover: async another => { assert.equal(another, true); return 'another'; }, write: () => {},
  });
  assert.equal(result.org, 'org_b'); assert.deepEqual(loaded, ['org_a', 'org_b']);
});
test('last unavailable org supports a clean stop and noninteractive keeps diagnostics', async () => {
  const deps = { interactive: true, pick: async () => 'org_a', load: async () => { throw denied(401); }, recover: async another => { assert.equal(another, false); return 'skip'; }, write: () => {} };
  assert.equal(await accessibleOrganization([choices[0]], undefined, deps), undefined);
  deps.interactive = false;
  await assert.rejects(accessibleOrganization([choices[0]], 'org_a', deps), error => error.status === 401 && error.requestId === 'request_example' && /orchestra login/.test(error.message));
});
test('server errors are not mislabeled as credential problems', async () => {
  await assert.rejects(accessibleOrganization(choices, 'org_a', { interactive: false, load: async () => { throw denied(500); } }), error => error.status === 500);
});
test('org-scoped key and gateway take priority over the last-login legacy key', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchestra-org-auth-'));
  try {
    const script = `
      import assert from 'node:assert/strict';
      import {writeCredentials} from './dist/config/credentials.js';
      import {resolveAuth} from './dist/internal/http.js';
      delete process.env.UNDERSTUDY_API_KEY; delete process.env.UNDERSTUDY_GATEWAY_URL;
      writeCredentials({api_key:'synthetic-last-login',gateway_url:'https://legacy.example.com',orgs:{org_a:{api_key:'synthetic-a',gateway_url:'https://a.example.com'},org_b:{api_key:'synthetic-b',gateway_url:'https://b.example.com'}}});
      assert.equal(resolveAuth('org_a').token,'synthetic-a');
      assert.equal(resolveAuth('org_a').gatewayUrl,'https://a.example.com');
      assert.equal(resolveAuth('org_b').token,'synthetic-b');
      process.env.UNDERSTUDY_API_KEY='synthetic-explicit';
      assert.equal(resolveAuth('org_a').token,'synthetic-explicit');
      delete process.env.UNDERSTUDY_API_KEY;
      writeCredentials({api_key:'synthetic-legacy',orgs:{}});
      assert.equal(resolveAuth('org_legacy').token,'synthetic-legacy');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding:'utf8', env:{...process.env,HOME:home,UNDERSTUDY_HOME:home} });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(home, {recursive:true,force:true}); }
});
test('installer init renders asynchronous failures without a Node stack trace', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchestra-init-error-'));
  try {
    const script = `
      import {mkdirSync,writeFileSync} from 'node:fs';
      import {dirname} from 'node:path';
      import {spawnSync} from 'node:child_process';
      import assert from 'node:assert/strict';
      import {globalCredentialsPath} from './dist/config/paths.js';
      const path=globalCredentialsPath(); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,'invalid-json',{mode:0o600});
      const result=spawnSync(process.execPath,['dist/bin.js','--json','init','--agents','none','--skip-login','--no-start'],{env:process.env,encoding:'utf8'});
      assert.equal(result.status,1);
      const body=JSON.parse(result.stderr.trim());
      assert.equal(body.ok,false); assert.match(body.error,/Failed to parse/);
      assert.doesNotMatch(result.stderr,/file:\\/\\/|at async|Node.js v/);
    `;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,HOME:home,UNDERSTUDY_HOME:home,UNDERSTUDY_TELEMETRY:'0'}});
    assert.equal(result.status,0,result.stderr);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
