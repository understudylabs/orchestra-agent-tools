import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDemo, demoScenarios } from './build-demo.mjs';

test('demo scenarios use real join results and withhold ratios for incomplete evidence', () => {
  const [joined, correlation, cost, outcome] = demoScenarios();
  assert.equal(joined.report.accounting.joined_captures, 3);
  assert.equal(joined.report.cohorts[0].descriptive_cost_per_reported_resolved_run.amount, 0.1);
  assert.equal(correlation.report.accounting.joined_captures, 2);
  assert.equal(cost.report.workflows[0].missing_cost_operations, 1);
  assert.ok(outcome.report.workflows.every(w => w.reported_outcome === null));
  for (const scenario of [correlation, cost, outcome]) assert.equal(scenario.report.cohorts[0].descriptive_cost_per_reported_resolved_run, null);
});

test('build creates a standalone private overview with no embedded capture payloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audr-demo-'));
  try {
    const path = join(dir, 'demo.html');
    buildDemo(path);
    const html = readFileSync(path, 'utf8');
    assert.doesNotMatch(html, /__AUDR_DEMO_DATA__|__MODEL_CHOICE_DATA__|customer_request_body|response_body|<script[^>]+src=|<link[^>]+href=/);
    assert.match(html, /Synthetic data/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const data = JSON.parse(html.match(/<script type="application\/json" id="demo-data">(.*?)<\/script>/s)[1]);
    assert.equal(data.length, 4);
    assert.throws(() => buildDemo(path), { code: 'EEXIST' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
