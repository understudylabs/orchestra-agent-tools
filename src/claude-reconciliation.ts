import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { request } from "./internal/http.js";
import { CallCostResponseSchema } from "./internal/reporting-contracts.js";
import { resolveProject } from "./internal/projects.js";
import { resolveWorkload } from "./internal/workloads.js";
import { exportCapturesByRequestIds } from "./commands/captures.js";
import { ClaudeSessionSchema } from "./commands/claude.js";

const tokenKeys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
const UsageSchema = z.object(Object.fromEntries(tokenKeys.map(key => [key, z.number().int().nonnegative()])));
const emptyUsage = () => Object.fromEntries(tokenKeys.map(key => [key, 0]));
type Session = z.infer<typeof ClaudeSessionSchema>;

export function readClaudeEvidence(files: string[], sessionId: string) {
  const messageIds = new Set<string>();
  const results = new Set<string>();
  const usage = emptyUsage();
  for (const file of files) {
    let resultFound = false;
    for (const line of readFileSync(file, "utf8").split("\n").filter(line => line.trim())) {
      let row;
      try { row = JSON.parse(line); } catch { throw new Error("Invalid transcript JSON; raw content omitted."); }
      if (row.session_id !== sessionId) throw new Error("Transcript contains a different or missing session ID.");
      if (row.type === "assistant") {
        messageIds.add(z.string().min(1).max(256).parse(row.message?.id));
      }
      if (row.type === "result") {
        if (row.is_error || row.subtype !== "success") throw new Error("Transcript contains an unsuccessful result; reconcile failures separately.");
        const id = z.string().min(1).parse(row.uuid);
        if (results.has(id)) throw new Error("Repeated transcript result would double-count usage.");
        results.add(id);
        const parsed = UsageSchema.parse(row.usage);
        for (const key of tokenKeys) usage[key]! += parsed[key]!;
        resultFound = true;
      }
    }
    if (!resultFound) throw new Error("Each transcript must contain a completed result.");
  }
  if (!messageIds.size) throw new Error("No assistant message IDs to reconcile.");
  return { messageIds: [...messageIds], usage, results: results.size };
}

export function verifySessionCapture(value: unknown, session: Session, requestId: string): void {
  const capture = z.object({ request_id: z.string(), request_environment: z.string(), tags: z.record(z.string(), z.string()), customer_request_body: z.unknown(), response_body: z.unknown() }).parse(value);
  if (capture.request_id !== requestId || capture.request_environment !== session.environment) throw new Error("Capture identity or environment mismatch.");
  const expected = { run_id: session.session_id, repository: session.repository, branch: session.branch, base_commit: session.base_commit, harness: "claude-code" };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (capture.tags[key] !== expectedValue) throw new Error(`Capture attribution mismatch: ${key}.`);
  }
  if (!capture.customer_request_body || !capture.response_body) throw new Error("Capture is missing request or response content.");
}

export async function reconcileClaudeSession(session: Session, transcripts: string[], out: string) {
  const evidence = readClaudeEvidence(transcripts, session.session_id);
  const project = await resolveProject({ org: session.org, project: session.project });
  if (project.auth.gatewayUrl !== session.gateway_url) throw new Error("Gateway changed since session launch.");
  const workload = await resolveWorkload(project, session.workload);
  const costs = [];
  const seen = new Set<string>();
  const usage = emptyUsage();
  for (const id of evidence.messageIds) {
    const res = await request({ url: `/admin/v1/orgs/${encodeURIComponent(session.org)}/calls/${encodeURIComponent(id)}/cost`, orgId: session.org }, CallCostResponseSchema);
    const cost = res.data;
    if (cost.org_id !== session.org || cost.project_id !== project.projectId || cost.workload_id !== workload.id) throw new Error("Cost record scope mismatch.");
    if (seen.has(cost.request_id)) throw new Error("Multiple message IDs resolved to one request; refusing ambiguous attribution.");
    seen.add(cost.request_id);
    if (cost.pricing_status !== "priced" || cost.coverage.data_completeness !== 1 || cost.coverage.known_gaps.length) throw new Error("Pricing is incomplete; retry after gateway pricing catches up.");
    if (!Number.isFinite(cost.customer_cost_usd) || cost.customer_cost_usd < 0) throw new Error("Invalid customer cost.");
    for (const key of tokenKeys) usage[key]! += cost.tokens[key];
    costs.push({ request_id: cost.request_id, customer_cost_usd: cost.customer_cost_usd });
  }
  for (const key of tokenKeys) {
    if (usage[key] !== evidence.usage[key]) throw new Error(`Gateway and transcript usage differ for ${key}; reconciliation is incomplete.`);
  }
  const batch = await exportCapturesByRequestIds({ requestIds: [...seen], outputDirectory: out, includePayload: true, concurrency: 4, retries: 2, resume: false, orgId: session.org, projectId: project.projectId, workloadId: workload.id });
  if (!batch.ok) throw new Error("Capture export is incomplete.");
  for (const id of seen) {
    let capture;
    try { capture = JSON.parse(readFileSync(join(out, `${encodeURIComponent(id)}.payload.json`), "utf8")); }
    catch { throw new Error("Cannot read exported capture JSON; raw content omitted."); }
    verifySessionCapture(capture, session, id);
  }
  return { session_id: session.session_id, verified_at: new Date().toISOString(), requests: seen.size, verified_captures: seen.size, tokens: usage, customer_cost_usd: costs.reduce((sum, row) => sum + row.customer_cost_usd, 0), costs, scope: "successful requests represented in the supplied completed Claude stream-json transcripts", limitation: "Does not enumerate background traffic, failures, or omitted invocations; compare gateway session inventory before claiming full-session coverage." };
}
