import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticModelChoices } from './model-choice.mjs';

test('synthetic call-price ranking reverses when tool expense and task success are included', () => {
  const rows = syntheticModelChoices();
  const [baseline, cheapA, cheapB] = rows;
  assert.equal([...rows].sort((a,b) => a.cost_per_call-b.cost_per_call)[0].id, 'cheap-a');
  assert.equal(baseline.full_cost, 10);
  assert.equal(cheapA.full_cost, 14);
  assert.equal(cheapB.full_cost, 6);
  assert.ok(cheapA.cost_per_correct_task > baseline.cost_per_correct_task);
  assert.equal([...rows].sort((a,b) => a.cost_per_correct_task-b.cost_per_correct_task)[0].id, 'cheap-b');
  assert.ok(rows.every(row => row.route_change_allowed === false && row.evidence.includes('no replay')));
});
