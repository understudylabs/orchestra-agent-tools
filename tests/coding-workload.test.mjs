import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseCodingWorkload } from '../dist/onboarding/coding-workload.js';
import { UnderstudyApiError } from '../dist/internal/http.js';
const project = { auth: { orgId: 'org_example' }, projectId: 'project_example' };
const other = { id: 'w_main', name: 'main', capture_enabled: false };
const dedicated = { id: 'w_claude', name: 'claude-code', capture_enabled: false };
function fixture(choice = '__create__', approved = true, capture = true) {
  const writes = []; let options; let capturePrompts = 0;
  return { writes, get options() { return options; }, get capturePrompts() { return capturePrompts; }, deps: {
    interactive: true,
    select: async choices => { options = choices; return choice; },
    confirm: async () => approved,
    capture: async () => { capturePrompts++; return capture; },
    create: async enabled => { writes.push(enabled); return {...dedicated, capture_enabled: enabled}; },
  } };
}
test('offers Claude-specific creation before unrelated workloads, including nonempty projects', async () => {
  const f = fixture(); const result = await chooseCodingWorkload(project, [other], undefined, f.deps);
  assert.match(f.options[0].name, /Create claude-code/); assert.equal(f.options[1].value, 'main');
  assert.equal(result.name, 'claude-code'); assert.deepEqual(f.writes, [true]);
});
test('reuses dedicated workload without changing its capture policy', async () => {
  const f = fixture('claude-code');
  assert.equal(await chooseCodingWorkload(project, [other, dedicated], undefined, f.deps), dedicated);
  assert.equal(f.options[0].value, 'claude-code'); assert.equal(f.writes.length, 0); assert.equal(f.capturePrompts, 0);
});
test('empty project supports capture opt-out and creation cancellation', async () => {
  const f = fixture('__create__', true, false);
  assert.equal((await chooseCodingWorkload(project, [], undefined, f.deps)).capture_enabled, false);
  const canceled = fixture('__create__', false);
  assert.equal(await chooseCodingWorkload(project, [], undefined, canceled.deps), undefined);
  assert.equal(canceled.capturePrompts, 0); assert.equal(canceled.writes.length, 0);
});
test('explicit or selected existing workload is preserved; noninteractive never creates', async () => {
  const f = fixture('main');
  assert.equal(await chooseCodingWorkload(project, [other], undefined, f.deps), other);
  f.deps.interactive = false;
  assert.equal(await chooseCodingWorkload(project, [other], 'main', f.deps), other);
  await assert.rejects(chooseCodingWorkload(project, [other], undefined, f.deps), /--workload/);
  assert.equal(f.writes.length, 0);
});
test('create conflicts and permission failures offer an actionable retry path', async () => {
  for (const [status, pattern] of [[409, /just created/], [403, /administrator/]]) {
    const f = fixture();
    f.deps.create = async () => { throw new UnderstudyApiError({ status, errorType: 'test', message: 'failed', requestId: 'synthetic' }); };
    await assert.rejects(chooseCodingWorkload(project, [], undefined, f.deps), pattern);
  }
});
