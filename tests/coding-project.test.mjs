import assert from 'node:assert/strict';
import test from 'node:test';
import { codingProjectIdentity, chooseCodingProject } from '../dist/onboarding/coding-project.js';
const credentials = { email: 'alex@example.com', orgs: {} };
const expected = codingProjectIdentity(credentials.email);
function fixture(choice = '__create__', approved = true) {
  const created = []; const confirmations = []; let options;
  return { created, confirmations, get options() { return options; }, deps: {
    interactive: true,
    select: async choices => { options = choices; return choice; },
    identity: async () => 'alex@example.com',
    confirm: async (...args) => { confirmations.push(args); return approved; },
    create: async proposal => { created.push(proposal); return { id: 'project_example', ...proposal }; },
  } };
}
test('identity is stable, valid and distinguishes matching local email parts', () => {
  assert.deepEqual(codingProjectIdentity(' ALEX@example.com '), expected);
  assert.notEqual(codingProjectIdentity('alex@other.example').slug, expected.slug);
  assert.match(codingProjectIdentity('人物'.repeat(100)).slug, /^[a-z0-9][a-z0-9-]{1,62}$/);
});
test('empty project inventory offers and explicitly confirms creation', async () => {
  const f = fixture();
  assert.equal(await chooseCodingProject('org_example', credentials, [], undefined, f.deps), expected.slug);
  assert.deepEqual(f.created, [expected]); assert.equal(f.confirmations.length, 1);
});
test('existing dedicated project is recommended and reused', async () => {
  const f = fixture(expected.slug);
  assert.equal(await chooseCodingProject('org_example', credentials, [{ id: 'p', ...expected }], undefined, f.deps), expected.slug);
  assert.equal(f.options[0].value, expected.slug); assert.equal(f.created.length, 0);
});
test('existing alternative and explicit project remain available without mutation', async () => {
  const f = fixture('existing'); const projects = [{ id: 'p', slug: 'existing', name: 'Existing' }];
  assert.equal(await chooseCodingProject('org_example', credentials, projects, undefined, f.deps), 'existing');
  assert.equal(await chooseCodingProject('org_example', credentials, projects, 'existing', f.deps), 'existing');
  assert.equal(f.created.length, 0);
});
test('declined creation does not write, and missing identity can be supplied', async () => {
  const f = fixture('__create__', false);
  assert.equal(await chooseCodingProject('org_example', credentials, [], undefined, f.deps), undefined);
  assert.equal(f.created.length, 0);
  const g = fixture();
  assert.equal(await chooseCodingProject('org_example', { orgs: {} }, [], undefined, g.deps), expected.slug);
});
test('noninteractive setup never implicitly creates a project', async () => {
  const f = fixture(); f.deps.interactive = false;
  await assert.rejects(chooseCodingProject('org_example', credentials, [], undefined, f.deps), /--project/);
  assert.equal(f.created.length, 0);
});

import { UnderstudyApiError } from '../dist/internal/http.js';
test('creation conflict and permission denial provide recovery without retries', async () => {
  for (const [status, pattern] of [[409, /just created/], [403, /administrator/]]) {
    const f = fixture(); let writes = 0;
    f.deps.create = async () => { writes++; throw new UnderstudyApiError({ status, errorType: 'test', message: 'failed', requestId: 'synthetic' }); };
    await assert.rejects(chooseCodingProject('org_example', credentials, [], undefined, f.deps), pattern);
    assert.equal(writes, 1);
  }
});
