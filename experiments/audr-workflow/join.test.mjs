import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { joinAudrWorkflow } from './join.mjs';

const record = (overrides = {}) => ({
  spec_version: '1.1.0', record_id: 'record-0001', emitter: { component: 'harness', name: 'synthetic-harness', version: '1' },
  timing: { event_time: '2026-11-16T12:00:00.000Z' },
  attribution: { account_id: 'account-example', environment: 'test' },
  run: { run_id: 'run-example-01', span_id: 'model-1', outcome: 'resolved' },
  resource: { provider: 'example', name: 'synthetic-model', type: 'model', operation: 'generation', modality: 'text' },
  usage: { llm: { input_tokens: 12, output_tokens: 3 } }, cost: { total_cost: 0.1, currency: 'USD' }, ...overrides,
});
const capture = () => ({ schema_version: 4, workos_org_id: 'org-example', project_id: 'project-example', request_id: 'request-1', request_environment: 'test', customer_request_body: 'PRIVATE_PAYLOAD_SENTINEL', response_body: 'PRIVATE_RESPONSE_SENTINEL' });
const link = () => ({ account_id: 'account-example', environment: 'test', run_id: 'run-example-01', span_id: 'model-1', org_id: 'org-example', project_id: 'project-example', request_id: 'request-1' });
const analyze = (records = [record()], captures = [capture()], links = [link()]) => joinAudrWorkflow({ records, captures, links });

test('joins scoped model evidence without copying payloads; keeps missing counters absent', () => {
  const report = analyze();
  assert.equal(report.accounting.joined_captures, 1);
  assert.equal(report.cohorts[0].descriptive_cost_per_reported_resolved_run.amount, 0.1);
  assert.equal(report.workflows[0].outcome_quality_verified, false);
  assert.equal(report.workflows[0].completeness_verified, false);
  assert.equal(report.workflows[0].operations[0].usage.llm.cache_read_tokens, undefined);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PAYLOAD|PRIVATE_RESPONSE/);
});
test('deduplicates redelivery regardless of JSON property order, rejects ID collisions', () => {
  assert.equal(analyze([record(), Object.fromEntries(Object.entries(record()).reverse())]).accounting.duplicates, 1);
  assert.throws(() => analyze([record(), record({ cost: { total_cost: 1, currency: 'USD' } })]), /collision/);
});
test('applies out-of-order full corrections exactly once', () => {
  const correction = record({ record_id: 'record-0002', corrects: 'record-0001', cost: { total_cost: 0.2, currency: 'USD' } });
  const report = analyze([correction, record(), correction]);
  assert.equal(report.accounting.active_operations, 1);
  assert.equal(report.accounting.corrections, 1);
  assert.equal(report.cohorts[0].asserted_cost_by_currency.USD, 0.2);
});
test('rejects orphan, forked and cyclic corrections', () => {
  const c = record({ record_id: 'record-0002', corrects: 'record-0001' });
  assert.throws(() => analyze([c]), /target is missing/);
  assert.throws(() => analyze([record(), c, { ...c, record_id: 'record-0003' }]), /forked/);
  assert.throws(() => analyze([record({ corrects: 'record-0002' }), c]), /cycle/);
});
test('rejects corrections crossing tenant or emitter boundary', () => {
  assert.throws(() => analyze([record(), record({ record_id: 'record-0002', corrects: 'record-0001', attribution: { account_id: 'another', environment: 'test' } })]), /boundary/);
  assert.throws(() => analyze([record(), record({ record_id: 'record-0002', corrects: 'record-0001', emitter: { component: 'harness', name: 'other', version: '1' } })]), /boundary/);
});
test('void corrections remove usage and outcomes; stale links fail', () => {
  const records = [record(), record({ record_id: 'record-0002', corrects: 'record-0001', usage: { llm: { requests: 0 } }, cost: { total_cost: 0, currency: 'USD' } })];
  assert.equal(analyze(records, [], []).accounting.voided, 1);
  assert.equal(analyze(records, [], []).workflows.length, 0);
  assert.throws(() => analyze(records), /active model/);
});
test('rejects competing operation writers and non-harness records', () => {
  assert.throws(() => analyze([record(), record({ record_id: 'record-0002' })]), /authoritative/);
  assert.throws(() => analyze([record({ emitter: { component: 'router' } })]), /only harness/);
});
test('never joins by trace ID, timing or model; exposes unmatched coverage', () => {
  const report = analyze([record()], [capture()], []);
  assert.equal(report.accounting.joined_captures, 0);
  assert.equal(report.accounting.unjoined_captures, 1);
  assert.ok(report.workflows[0].issues.includes('unmatched_model_operation'));
  assert.equal(report.cohorts[0].descriptive_cost_per_reported_resolved_run, null);
});
test('scoped joins reject wrong org, environment and many-to-one mappings', () => {
  assert.throws(() => analyze([record()], [capture()], [{ ...link(), org_id: 'wrong' }]), /missing scoped/);
  assert.throws(() => analyze([record()], [{ ...capture(), request_environment: 'production' }]), /environment/);
  assert.throws(() => analyze([record()], [capture()], [link(), link()]), /ambiguous/);
});
test('retains tool costs and parent edges; does not count model tool requests as tool execution', () => {
  const tool = record({ record_id: 'record-tool1', run: { run_id: 'run-example-01', span_id: 'tool-1', parent_span_id: 'model-1' },
    resource: { provider: 'self-hosted', type: 'tool', name: 'lookup', operation: 'retrieval' }, usage: { tool: { call_count: 1 } }, cost: { total_cost: 0.05, currency: 'USD' } });
  const report = analyze([record(), tool]);
  assert.equal(report.workflows[0].operations.length, 2);
  assert.deepEqual(report.workflows[0].issues, []);
  assert.ok(Math.abs(report.cohorts[0].asserted_cost_by_currency.USD - 0.15) < 1e-9);
});
test('missing parents, cycles and contradictory outcomes remain unresolved', () => {
  const r = record({ run: { run_id: 'run-example-01', span_id: 'model-1', parent_span_id: 'missing', outcome: 'resolved' } });
  assert.ok(analyze([r]).workflows[0].issues.includes('missing_parent_span'));
  assert.ok(analyze([{ ...r, run: { ...r.run, parent_span_id: 'model-1' } }]).workflows[0].issues.includes('parent_cycle'));
  const second = record({ record_id: 'record-0002', run: { run_id: 'run-example-01', span_id: 'model-2', outcome: 'failed' } });
  assert.equal(analyze([record(), second], [], []).workflows[0].reported_outcome, null);
});
test('failed-run costs belong in cohort numerator; no-success and missing-cost metrics are null', () => {
  const failed = record({ record_id: 'record-0002', run: { run_id: 'run-example-02', span_id: 'model-1', outcome: 'failed' } });
  const secondLink = { ...link(), run_id: 'run-example-02', request_id: 'request-2' };
  const report = analyze([record(), failed], [capture(), { ...capture(), request_id: 'request-2' }], [link(), secondLink]);
  assert.equal(report.cohorts[0].descriptive_cost_per_reported_resolved_run.amount, 0.2);
  assert.equal(analyze([failed], [{ ...capture(), request_id: 'request-2' }], [secondLink]).cohorts[0].descriptive_cost_per_reported_resolved_run, null);
  assert.equal(analyze([record({ cost: undefined })]).cohorts[0].descriptive_cost_per_reported_resolved_run, null);
});
test('currencies and account/environment cohorts are never silently pooled', () => {
  const euro = record({ record_id: 'record-tool1', run: { run_id: 'run-example-01', span_id: 'tool-1' }, resource: { provider: 'self-hosted', type: 'tool', name: 'lookup', operation: 'retrieval' }, usage: { tool: { call_count: 1 } }, cost: { total_cost: 1, currency: 'EUR' } });
  const report = analyze([record(), euro]);
  assert.equal(report.cohorts[0].descriptive_cost_per_reported_resolved_run, null);
  assert.deepEqual(report.cohorts[0].asserted_cost_by_currency, { USD: 0.1, EUR: 1 });
});
test('invalid numeric usage/cost and malformed inputs fail closed', () => {
  assert.throws(() => analyze([record({ usage: { llm: { input_tokens: -1 } } })]), /counter/);
  assert.throws(() => analyze([record({ cost: { total_cost: NaN, currency: 'USD' } })]), /cost/);
  assert.throws(() => analyze([record({ spec_version: '2.0.0' })]), /profile/);
});
test('CLI writes a private report, prints only counts, and refuses overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audr-test-'));
  try {
    for (const [file, rows] of Object.entries({ audr: [record()], captures: [capture()], links: [link()] })) writeFileSync(join(dir, file), rows.map(JSON.stringify).join('\n'));
    const args = ['experiments/audr-workflow/run.mjs', '--audr', join(dir, 'audr'), '--captures', join(dir, 'captures'), '--links', join(dir, 'links'), '--output', join(dir, 'report')];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /account-example|run-example|PRIVATE/);
    assert.equal(statSync(join(dir, 'report')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(dir, 'report'), 'utf8')).accounting.joined_captures, 1);
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
