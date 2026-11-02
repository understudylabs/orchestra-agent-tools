import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { request, UnderstudyApiError } from "./internal/http.js";
import { resolveProject } from "./internal/projects.js";
import { resolveWorkload } from "./internal/workloads.js";
import { CallCostResponseSchema, CoverageSchema, TokenCountsSchema } from "./internal/reporting-contracts.js";
import { ClaudeSessionSchema } from "./commands/claude.js";
import { exportCapturesByRequestIds } from "./commands/captures.js";
import { verifySessionCapture } from "./claude-reconciliation.js";

// Customer request-log wire subset; unknown fields never enter the report.
const SessionRequestSchema = z.object({
  request_id: z.string().uuid(), ts: z.string(), project_id: z.string(), workload_id: z.string(),
  request_environment: z.enum(["test", "production"]), status_code: z.number().int(),
  outcome: z.string(), tokens: TokenCountsSchema,
  capture_state: z.enum(["expected", "disabled", "unknown"]),
});
const SessionPageSchema = z.object({
  org_id: z.string(), window_start: z.string(), window_end: z.string(), snapshot_watermark: z.string(),
  filters: z.object({ session_id: z.string(), project_id: z.string(), workload_id: z.string(), request_environment: z.string() }),
  calls: z.array(SessionRequestSchema), next_cursor: z.string().nullable(), coverage: CoverageSchema,
});
type Session = z.infer<typeof ClaudeSessionSchema>;
interface Scope { org: string; projectId: string; workloadId: string; sessionId: string; environment: string; startedAt: string }

export async function collectSessionRequests(scope: Scope, pageRequest: (cursor: string | null) => Promise<unknown>) {
  const calls: z.infer<typeof SessionRequestSchema>[] = [];
  const seenRequests = new Set<string>(); const seenCursors = new Set<string>();
  const gaps = new Set<string>();
  let cursor: string | null = null;
  let snapshot: { window_start: string; window_end: string; snapshot_watermark: string } | undefined;
  let previous: { ts: string; request_id: string } | undefined;
  do {
    const page = SessionPageSchema.parse(await pageRequest(cursor));
    if (page.org_id !== scope.org || page.filters.session_id !== scope.sessionId || page.filters.project_id !== scope.projectId || page.filters.workload_id !== scope.workloadId || page.filters.request_environment !== scope.environment) throw new Error("Session inventory scope mismatch.");
    const anchors = { window_start: page.window_start, window_end: page.window_end, snapshot_watermark: page.snapshot_watermark };
    if (Object.values(anchors).some(value => !Number.isFinite(Date.parse(value)))) throw new Error("Invalid inventory timeline.");
    if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(anchors)) throw new Error("Inventory snapshot changed during pagination.");
    snapshot ??= anchors;
    if (Date.parse(scope.startedAt) < Date.parse(page.window_start)) throw new Error("Session starts before the inventory window; this command supports sessions within the last seven days.");
    for (const gap of page.coverage.known_gaps) gaps.add(gap);
    if (page.coverage.data_completeness < 1) gaps.add("Some gateway request metadata is incomplete.");
    for (const call of page.calls) {
      if (call.project_id !== scope.projectId || call.workload_id !== scope.workloadId || call.request_environment !== scope.environment) throw new Error("Request scope mismatch.");
      const at = Date.parse(call.ts);
      if (!Number.isFinite(at) || at < Date.parse(page.window_start) || at >= Date.parse(page.window_end)) throw new Error("Request falls outside inventory window.");
      if (seenRequests.has(call.request_id) || (previous && (at > Date.parse(previous.ts) || (at === Date.parse(previous.ts) && call.request_id >= previous.request_id)))) throw new Error("Repeated or unordered request in inventory.");
      previous = call; seenRequests.add(call.request_id); calls.push(call);
      if (calls.length > 100_000) throw new Error("Session exceeds 100000 requests; no partial report was returned.");
    }
    cursor = page.next_cursor;
    if (cursor !== null) {
      if (!cursor || seenCursors.has(cursor) || page.calls.length === 0) throw new Error("Invalid inventory continuation cursor.");
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  return { calls, snapshot: snapshot!, known_gaps: [...gaps] };
}

export async function accountClaudeSession(session: Session, captureDirectory?: string) {
  const project = await resolveProject({ org: session.org, project: session.project });
  if (project.auth.gatewayUrl !== session.gateway_url) throw new Error("Gateway changed since session launch.");
  const workload = await resolveWorkload(project, session.workload);
  const inventory = await collectSessionRequests({ org: session.org, projectId: project.projectId, workloadId: workload.id, sessionId: session.session_id, environment: session.environment, startedAt: session.created_at }, async cursor => {
    const params = new URLSearchParams({ session_id: session.session_id, project_id: project.projectId, workload_id: workload.id, request_environment: session.environment, window: "7d", limit: "100", include_rejection_details: "true" });
    if (cursor) params.set("cursor", cursor);
    return (await request({ orgId: session.org, url: `/admin/v1/orgs/${encodeURIComponent(session.org)}/request-logs?${params}` }, SessionPageSchema)).data;
  });
  const records = [];
  for (const call of inventory.calls) {
    let customerCost: number | null = null;
    let pricingStatus = "missing";
    try {
      const cost = (await request({ orgId: session.org, url: `/admin/v1/orgs/${encodeURIComponent(session.org)}/calls/${encodeURIComponent(call.request_id)}/cost` }, CallCostResponseSchema)).data;
      if (cost.org_id !== session.org || cost.project_id !== project.projectId || cost.workload_id !== workload.id || cost.request_id !== call.request_id) throw new Error("Cost record scope mismatch.");
      pricingStatus = cost.pricing_status;
      if (cost.pricing_status === "priced") {
        if (!Number.isFinite(cost.customer_cost_usd) || cost.customer_cost_usd < 0) throw new Error("Invalid customer cost.");
        customerCost = cost.customer_cost_usd;
      }
      if (cost.coverage.data_completeness < 1) inventory.known_gaps.push("Some cost metadata is incomplete.");
      for (const gap of cost.coverage.known_gaps) inventory.known_gaps.push(gap);
    } catch (error) {
      if (!(error instanceof UnderstudyApiError) || error.status !== 404) throw error;
    }
    records.push({ ...call, pricing_status: pricingStatus, customer_cost_usd: customerCost, capture_verification: captureDirectory && call.capture_state !== "expected" ? "not_captured" : "not_requested" });
  }
  if (captureDirectory && records.length) {
    const expected = records.filter(row => row.capture_state === "expected").map(row => row.request_id);
    if (expected.length) {
      const batch = await exportCapturesByRequestIds({ requestIds: expected, outputDirectory: captureDirectory, includePayload: true, concurrency: 4, retries: 2, resume: false, orgId: session.org, projectId: project.projectId, workloadId: workload.id });
      for (const row of records) {
        if (row.capture_state !== "expected") { row.capture_verification = "not_captured"; continue; }
        if (batch.failed_request_ids.includes(row.request_id)) { row.capture_verification = "missing"; continue; }
        let capture;
        try { capture = JSON.parse(readFileSync(join(captureDirectory, `${encodeURIComponent(row.request_id)}.payload.json`), "utf8")); }
        catch { throw new Error("Invalid capture JSON; raw content omitted."); }
        verifySessionCapture(capture, session, row.request_id);
        row.capture_verification = "verified";
      }
    }
  }
  const unpriced = records.filter(row => row.customer_cost_usd === null).map(row => row.request_id);
  const pricedCost = records.reduce((sum, row) => sum + (row.customer_cost_usd ?? 0), 0);
  return {
    session_id: session.session_id, snapshot: inventory.snapshot, requests: records.length,
    failed_requests: records.filter(row => row.status_code >= 400 || row.outcome === "error").length,
    priced_cost_usd: pricedCost, customer_cost_usd: unpriced.length || !records.length ? null : pricedCost,
    unpriced_request_ids: unpriced, uncaptured_request_ids: records.filter(row => row.capture_state !== "expected").map(row => row.request_id),
    known_gaps: [...new Set([...inventory.known_gaps, "Snapshot covers ingested requests carrying this session ID, including background calls; later arrivals and traffic without the ID require a fresh inventory or separate investigation."])],
    unmatched_requests: null, ambiguous_requests: null,
    attribution_note: "Session membership is explicit. Requests missing this session ID and shared/reused IDs cannot be quantified from this filtered inventory alone.",
    records,
  };
}
