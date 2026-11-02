import { confirm, select } from "@inquirer/prompts";
import { request, UnderstudyApiError } from "../internal/http.js";
import type { ResolvedProject } from "../internal/projects.js";
import { WorkloadSchema, type Workload } from "../internal/workloads.js";

const CLAUDE_WORKLOAD = "claude-code";
export async function chooseCodingWorkload(project: ResolvedProject, workloads: Workload[], supplied?: string, deps = {
  interactive: Boolean(process.stdin.isTTY),
  select: (choices: { name: string; value: string }[]) => select({ message: "Workload for Claude Code", choices }),
  confirm: () => confirm({ message: "Create claude-code in this project for Claude sessions and their cost/capture reports?", default: false }),
  capture: () => confirm({ message: "Enable model request/response capture for session reports (recommended)? Payloads are stored under your organization's capture policy.", default: true }),
  create: async (capture: boolean) => (await request({
    orgId: project.auth.orgId,
    url: `/admin/v1/orgs/${encodeURIComponent(project.auth.orgId)}/projects/${encodeURIComponent(project.projectId)}/workloads`,
    method: "POST", body: { name: CLAUDE_WORKLOAD, capture_enabled: capture },
  }, WorkloadSchema)).data,
}): Promise<Workload | undefined> {
  if (supplied) {
    const existing = workloads.find(workload => workload.name === supplied);
    if (!existing) throw new Error("Workload: selection is not available.");
    return existing;
  }
  if (!deps.interactive) throw new Error("Supply --workload in noninteractive mode. Run orchestra claude-setup interactively to create a Claude Code workload.");
  const recommended = workloads.find(workload => workload.name === CLAUDE_WORKLOAD);
  const choice = await deps.select([
    recommended
      ? { name: "Use claude-code (recommended for Claude sessions)", value: CLAUDE_WORKLOAD }
      : { name: "Create claude-code (recommended for Claude sessions)", value: "__create__" },
    ...workloads.filter(workload => workload.name !== CLAUDE_WORKLOAD).map(workload => ({ name: `Use existing: ${workload.name}`, value: workload.name })),
  ]);
  if (choice !== "__create__") return workloads.find(workload => workload.name === choice);
  if (!await deps.confirm()) return;
  const capture = await deps.capture();
  try { return await deps.create(capture); } catch (error) {
    if (error instanceof UnderstudyApiError && error.status === 409) throw new Error("The claude-code workload was just created. Run orchestra claude-setup again to select it.");
    if (error instanceof UnderstudyApiError && error.status === 403) throw new Error("You cannot create workloads in this project. Ask an administrator to create claude-code, or rerun setup and choose an existing workload.");
    throw error;
  }
}
