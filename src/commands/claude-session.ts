import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { globalConfigDir } from "../config/paths.js";
import { runAction } from "../internal/output.js";
import { reconcileClaudeSession } from "../claude-reconciliation.js";
import { writePrivateText } from "./captures.js";
import { ClaudeSessionSchema } from "./claude.js";

const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefName: z.string(),
  headRefOid: z.string().regex(/^[a-f0-9]{40}$/),
  headRepository: z.object({ name: z.string() }).nullable(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  mergedAt: z.string().nullable(),
  mergeCommit: z.object({ oid: z.string().regex(/^[a-f0-9]{40}$/) }).nullable(),
});

export function verifyClaudePullRequest(session: z.infer<typeof ClaudeSessionSchema>, value: unknown) {
  const pr = PullRequestSchema.parse(value);
  const headRepository = `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`;
  if (headRepository !== session.repository || pr.headRefName !== session.branch) {
    throw new Error("Pull request head does not match the session repository and branch.");
  }
  if (pr.url !== `https://github.com/${session.repository}/pull/${pr.number}`) {
    throw new Error("Pull request URL does not match the session repository.");
  }
  if (pr.state === "MERGED" && (!pr.mergedAt || !pr.mergeCommit)) {
    throw new Error("Merged pull request is missing merge evidence.");
  }
  if (pr.mergedAt && Date.parse(pr.mergedAt) < Date.parse(session.created_at)) {
    throw new Error("Pull request was merged before this session started.");
  }
  return {
    session_id: session.session_id,
    repository: session.repository,
    branch: session.branch,
    base_commit: session.base_commit,
    head_commit: pr.headRefOid,
    pull_request: pr.url,
    state: pr.state,
    merged_at: pr.mergedAt,
    merge_commit: pr.mergeCommit?.oid ?? null,
    verified_at: new Date().toISOString(),
    attribution: "explicit-session-branch" as const,
  };
}

export function registerClaudeSessionCommand(program: Command): void {
  const command = program.command("claude-session").description("Inspect and link Orchestra-managed Claude sessions.");
  command.command("show <session-id>").action(async function (this: Command, id: string) {
    await runAction(this, async () => {
      process.stdout.write(JSON.stringify(readSession(id), null, 2) + "\n");
    });
  });
  command.command("reconcile <session-id>")
    .requiredOption("--transcript <files...>", "Completed Claude stream-json outputs, including resume invocations")
    .requiredOption("--out <directory>", "Private capture export directory")
    .option("--include-payload", "Download request/response payloads for verification")
    .option("--yes", "Confirm local payload export")
    .action(async function (this: Command, id: string, opts: { transcript: string[]; out: string; includePayload?: boolean; yes?: boolean }) {
      await runAction(this, async () => {
        if (!opts.includePayload || !opts.yes) throw new Error("Capture verification requires --include-payload --yes.");
        const session = readSession(id);
        const report = await reconcileClaudeSession(session, opts.transcript, opts.out);
        writePrivateText(join(globalConfigDir(), "claude-sessions", `${id}.reconciliation.json`), JSON.stringify(report, null, 2) + "\n");
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      });
    });
  command.command("link <session-id>")
    .requiredOption("--pr <number>", "Pull request number in the session repository")
    .action(async function (this: Command, id: string, opts: { pr: string }) {
      await runAction(this, async () => {
        const session = readSession(id);
        if (!/^[1-9][0-9]*$/.test(opts.pr)) throw new Error("--pr must be a positive pull request number.");
        const fields = Object.keys(PullRequestSchema.shape).join(",");
        const raw = execFileSync("gh", ["pr", "view", opts.pr, "--repo", session.repository, "--json", fields], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const linkage = verifyClaudePullRequest(session, JSON.parse(raw));
        const comparison = execFileSync("gh", ["api", `repos/${session.repository}/compare/${session.base_commit}...${linkage.head_commit}`, "--jq", ".status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (comparison !== "ahead" && comparison !== "identical") throw new Error("PR head does not descend from the session base commit.");
        writePrivateText(join(globalConfigDir(), "claude-sessions", `${session.session_id}.pr.json`), JSON.stringify(linkage, null, 2) + "\n");
        process.stdout.write(JSON.stringify(linkage, null, 2) + "\n");
      });
    });
}

function readSession(id: string) {
  z.string().uuid().parse(id);
  return ClaudeSessionSchema.parse(JSON.parse(readFileSync(join(globalConfigDir(), "claude-sessions", `${id}.json`), "utf8")));
}
