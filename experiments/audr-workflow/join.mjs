// Local research prototype. Validates a supported projection, not full AUDR conformance.
import { createHash } from 'node:crypto';

const environments = new Set(['production', 'staging', 'development', 'test', 'evaluation']);
const outcomes = new Set(['resolved', 'escalated', 'abandoned', 'failed']);
const modelOps = new Set(['generation', 'embedding', 'reranking']);
const toolOps = new Set(['tool_execution', 'retrieval']);
const key = (...parts) => JSON.stringify(parts);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const scope = r => key(r.attribution.account_id, r.attribution.environment, r.run.run_id);
const operation = r => key(scope(r), r.run.span_id);
const captureKey = c => key(c.workos_org_id, c.project_id, c.request_id);
function requireThat(condition, message) { if (!condition) throw new Error(message); }

function validateRecord(r, index) {
  const fail = message => requireThat(false, `AUDR row ${index + 1}: ${message}`);
  if (!object(r) || !/^1\.1\.\d+$/.test(r.spec_version ?? '')) fail('supported profile requires AUDR 1.1.x');
  if (!text(r.record_id) || r.record_id.length < 8 || r.record_id.length > 64) fail('invalid record_id');
  if (r.emitter?.component !== 'harness') fail('only harness records are supported; mixed emitters would double count');
  if (!text(r.emitter.name) || !text(r.emitter.version)) fail('missing emitter identity');
  if (!text(r.attribution?.account_id) || !environments.has(r.attribution?.environment)) fail('account_id and a supported environment are required');
  if (!text(r.run?.run_id) || r.run.run_id.length < 8 || r.run.run_id.length > 64 || !text(r.run.span_id)) fail('invalid run/span identity');
  if (r.run.parent_span_id !== undefined && !text(r.run.parent_span_id)) fail('invalid parent span');
  if (r.run.outcome !== undefined && !outcomes.has(r.run.outcome)) fail('unsupported outcome');
  if (!text(r.timing?.event_time) || !Number.isFinite(Date.parse(r.timing.event_time))) fail('invalid event_time');
  if (!text(r.resource?.provider) || !text(r.resource?.name)) fail('missing resource identity');
  const model = modelOps.has(r.resource.operation);
  const tool = toolOps.has(r.resource.operation);
  if ((!model && !tool) || r.resource.type !== (model ? 'model' : 'tool')) fail('unsupported resource operation/type');
  const counters = r.usage?.[model ? 'llm' : 'tool'];
  if (!object(counters) || Object.keys(counters).length === 0 || r.usage?.[model ? 'tool' : 'llm'] !== undefined) fail('exactly one usage block is required');
  for (const [name, value] of Object.entries(counters)) {
    if (tool && name === 'type') { if (!text(value)) fail('invalid tool type'); }
    else if (!nonnegative(value)) fail('invalid usage counter');
  }
  if (r.cost !== undefined && (!object(r.cost) || !nonnegative(r.cost.total_cost) || !/^[A-Z]{3}$/.test(r.cost.currency ?? ''))) fail('invalid asserted cost');
  if (r.corrects !== undefined && (!text(r.corrects) || r.corrects === r.record_id)) fail('invalid correction reference');
  return r;
}

function activeRecords(records) {
  const byId = new Map();
  let duplicates = 0;
  records.forEach((value, i) => {
    const r = validateRecord(value, i), old = byId.get(r.record_id);
    if (old) {
      requireThat(digest(old) === digest(r), 'record_id collision with different content');
      duplicates++;
    } else byId.set(r.record_id, r);
  });
  const replaced = new Map();
  for (const r of byId.values()) if (r.corrects !== undefined) {
    const original = byId.get(r.corrects);
    requireThat(original, 'correction target is missing; include complete correction history');
    requireThat(operation(original) === operation(r) && original.emitter.name === r.emitter.name, 'correction crosses operation/account/environment/emitter boundary');
    requireThat(!replaced.has(r.corrects), 'forked correction history');
    replaced.set(r.corrects, r.record_id);
  }
  for (const id of byId.keys()) {
    const seen = new Set();
    let cursor = id;
    while (replaced.has(cursor)) {
      requireThat(!seen.has(cursor), 'correction cycle');
      seen.add(cursor); cursor = replaced.get(cursor);
    }
  }
  const active = [], operations = new Set();
  let voided = 0;
  for (const r of byId.values()) if (!replaced.has(r.record_id)) {
    requireThat(!operations.has(operation(r)), 'multiple authoritative records for one operation; use corrections');
    operations.add(operation(r));
    const numeric = Object.values(r.usage.llm ?? r.usage.tool).filter(v => typeof v === 'number');
    if (r.corrects && numeric.length > 0 && numeric.every(v => v === 0)) {
      requireThat(r.cost === undefined || r.cost.total_cost === 0, 'void correction has nonzero cost');
      voided++; continue;
    }
    active.push(r);
  }
  return { active, duplicates, corrections: replaced.size, voided };
}

/** Exact links are an explicit local sidecar, never a timestamp/model-name heuristic. */
export function joinAudrWorkflow({ records, captures, links }) {
  const { active, ...accounting } = activeRecords(records);
  const capturesByKey = new Map();
  for (const c of captures) {
    requireThat(object(c) && [2, 3, 4].includes(c.schema_version) &&
      [c.workos_org_id, c.project_id, c.request_id].every(text), 'capture requires v2/v3/v4 envelope and org/project/request identity');
    const k = captureKey(c), old = capturesByKey.get(k);
    requireThat(!old || digest(old) === digest(c), 'conflicting capture envelopes');
    capturesByKey.set(k, c);
  }
  const recordsByOp = new Map(active.map(r => [operation(r), r]));
  const linkByOp = new Map(), linkedCaptures = new Set();
  for (const link of links) {
    requireThat(object(link) && ['account_id', 'environment', 'run_id', 'span_id', 'org_id', 'project_id', 'request_id'].every(k => text(link[k])), 'link requires complete scoped identity');
    const op = key(key(link.account_id, link.environment, link.run_id), link.span_id);
    const ck = key(link.org_id, link.project_id, link.request_id), record = recordsByOp.get(op);
    requireThat(record && record.resource.type === 'model', 'link must reference an active model operation');
    requireThat(!linkByOp.has(op) && !linkedCaptures.has(ck), 'ambiguous link: operation and capture must each appear once');
    requireThat(capturesByKey.has(ck), 'link references a missing scoped capture');
    const capture = capturesByKey.get(ck);
    if (capture.request_environment !== undefined) requireThat(capture.request_environment === link.environment, 'capture environment differs from link');
    linkByOp.set(op, { org_id: link.org_id, project_id: link.project_id, request_id: link.request_id });
    linkedCaptures.add(ck);
  }
  const groups = new Map();
  for (const r of active) groups.set(scope(r), [...(groups.get(scope(r)) ?? []), r]);
  const workflows = [...groups.values()].map(rows => {
    const first = rows[0], spans = new Map(rows.map(r => [r.run.span_id, r]));
    const issues = new Set();
    for (const r of rows) {
      const seen = new Set([r.run.span_id]);
      let parent = r.run.parent_span_id;
      while (parent !== undefined) {
        if (!spans.has(parent)) { issues.add('missing_parent_span'); break; }
        if (seen.has(parent)) { issues.add('parent_cycle'); break; }
        seen.add(parent); parent = spans.get(parent).run.parent_span_id;
      }
      if (r.resource.type === 'model' && !linkByOp.has(operation(r))) issues.add('unmatched_model_operation');
    }
    const declared = [...new Set(rows.map(r => r.run.outcome).filter(Boolean))];
    if (declared.length !== 1) issues.add(declared.length ? 'conflicting_outcomes' : 'missing_outcome');
    const costs = {}, missing = rows.filter(r => r.cost === undefined).length;
    for (const r of rows) if (r.cost) costs[r.cost.currency] = (costs[r.cost.currency] ?? 0) + r.cost.total_cost;
    if (missing) issues.add('missing_asserted_cost');
    return {
      account_id: first.attribution.account_id, environment: first.attribution.environment, run_id: first.run.run_id,
      reported_outcome: declared.length === 1 ? declared[0] : null,
      outcome_quality_verified: false, completeness_verified: false,
      issues: [...issues].sort(), missing_cost_operations: missing, asserted_cost_by_currency: costs,
      operations: rows.map(r => ({ record_id: r.record_id, span_id: r.run.span_id,
        parent_span_id: r.run.parent_span_id ?? null, event_time: r.timing.event_time,
        resource: { type: r.resource.type, provider: r.resource.provider, name: r.resource.name, operation: r.resource.operation },
        usage: r.usage, asserted_cost: r.cost ? { total_cost: r.cost.total_cost, currency: r.cost.currency } : null,
        capture: linkByOp.get(operation(r)) ?? null,
      })).sort((a, b) => a.span_id.localeCompare(b.span_id)),
    };
  }).sort((a, b) => key(a.account_id, a.environment, a.run_id).localeCompare(key(b.account_id, b.environment, b.run_id)));
  // Cohort numerator includes failed/unresolved runs too. No cross-account/env/currency pooling.
  const cohorts = new Map();
  for (const w of workflows) {
    const k = key(w.account_id, w.environment);
    const cohort = cohorts.get(k) ?? { account_id: w.account_id, environment: w.environment, runs: 0, reported_resolved_runs: 0, asserted_cost_by_currency: {}, blocked: false };
    cohort.runs++; cohort.reported_resolved_runs += Number(w.reported_outcome === 'resolved');
    cohort.blocked ||= w.issues.length > 0;
    for (const [currency, cost] of Object.entries(w.asserted_cost_by_currency)) cohort.asserted_cost_by_currency[currency] = (cohort.asserted_cost_by_currency[currency] ?? 0) + cost;
    cohorts.set(k, cohort);
  }
  return {
    schema_version: 'orchestra.audr_workflow.prototype.v1', local_only: true,
    validation: 'supported-projection-only; not AUDR conformance certification',
    claims: 'descriptive harness assertions only; completeness, quality and savings unverified',
    accounting: { input_records: records.length, active_operations: active.length, ...accounting,
      captures: capturesByKey.size, joined_captures: linkedCaptures.size, unjoined_captures: capturesByKey.size - linkedCaptures.size },
    cohorts: [...cohorts.values()].map(c => {
      const currencies = Object.keys(c.asserted_cost_by_currency);
      return { ...c, descriptive_cost_per_reported_resolved_run: !c.blocked && c.reported_resolved_runs > 0 && currencies.length === 1
        ? { currency: currencies[0], amount: c.asserted_cost_by_currency[currencies[0]] / c.reported_resolved_runs } : null };
    }), workflows,
  };
}
