import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { globalConfigDir } from "../config/paths.js";
import { runAction } from "../internal/output.js";
import { accountClaudeSession } from "../claude-accounting.js";
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
  if (!session.repository || !session.branch || !session.base_commit) throw new Error("Session has no complete GitHub branch attribution.");
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

export function resolveClaudePullRequest(session: z.infer<typeof ClaudeSessionSchema>, number?: string) {
  if (!session.repository || !session.branch || !session.base_commit) throw new Error("Session has no complete GitHub branch attribution.");
  if (number !== undefined && !/^[1-9][0-9]*$/.test(number)) throw new Error("--pr must be a positive pull request number.");
  if (number === undefined) {
    const candidates = z.array(z.object({ number: z.number().int().positive() })).parse(JSON.parse(execFileSync("gh", ["pr", "list", "--repo", session.repository, "--head", session.branch, "--state", "all", "--limit", "2", "--json", "number"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })));
    if (candidates.length !== 1) throw new Error(candidates.length ? "Multiple PRs match this branch; select --pr explicitly." : "No PR matches this session branch yet.");
    number = String(candidates[0]!.number);
  }
  const fields = Object.keys(PullRequestSchema.shape).join(",");
  const raw = execFileSync("gh", ["pr", "view", number, "--repo", session.repository, "--json", fields], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const linkage = verifyClaudePullRequest(session, JSON.parse(raw));
  const comparison = execFileSync("gh", ["api", `repos/${session.repository}/compare/${session.base_commit}...${linkage.head_commit}`, "--jq", ".status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (comparison !== "ahead" && comparison !== "identical") throw new Error("PR head does not descend from the session base commit.");
  return linkage;
}

export function registerClaudeSessionCommand(program: Command): void {
  const command = program.command("claude-session").description("Inspect and link Orchestra-managed Claude sessions.");
  command.command("show <session-id>").action(async function (this: Command, id: string) {
    await runAction(this, async () => {
      process.stdout.write(JSON.stringify(readSession(id), null, 2) + "\n");
    });
  });
  command.command("account <session-id>")
    .description("Account for gateway session requests without transcripts, including failed and background calls")
    .option("--pr <number>", "Resolve a specific PR instead of discovering by branch")
    .option("--out <directory>", "Private capture export directory")
    .option("--include-payload", "Download and verify request/response captures")
    .option("--yes", "Confirm local payload export")
    .action(async function (this: Command, id: string, opts: { pr?: string; out?: string; includePayload?: boolean; yes?: boolean }) {
      await runAction(this, async () => {
        if ((opts.out || opts.includePayload || opts.yes) && !(opts.out && opts.includePayload && opts.yes)) throw new Error("Capture verification requires --out, --include-payload and --yes together.");
        const session = readSession(id);
        const accounting = await accountClaudeSession(session, opts.out);
        let pullRequest: ReturnType<typeof resolveClaudePullRequest> | null = null;
        let linkageGap: string | null = null;
        try { pullRequest = resolveClaudePullRequest(session, opts.pr); }
        catch { linkageGap = "PR linkage is unavailable or ambiguous. Run claude-session link with an explicit --pr to diagnose."; }
        const report = { ...accounting, pull_request: pullRequest, linkage_gap: linkageGap };
        if (pullRequest) writePrivateText(join(globalConfigDir(), "claude-sessions", `${id}.pr.json`), JSON.stringify(pullRequest, null, 2) + "\n");
        writePrivateText(join(globalConfigDir(), "claude-sessions", `${id}.accounting.json`), JSON.stringify(report, null, 2) + "\n");
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
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
    .option("--pr <number>", "Pull request number; otherwise discover the unique PR for the branch")
    .action(async function (this: Command, id: string, opts: { pr?: string }) {
      await runAction(this, async () => {
        const session = readSession(id);
        const linkage = resolveClaudePullRequest(session, opts.pr);
        writePrivateText(join(globalConfigDir(), "claude-sessions", `${session.session_id}.pr.json`), JSON.stringify(linkage, null, 2) + "\n");
        process.stdout.write(JSON.stringify(linkage, null, 2) + "\n");
      });
    });
}

function readSession(id: string) {
  z.string().uuid().parse(id);
  return ClaudeSessionSchema.parse(JSON.parse(readFileSync(join(globalConfigDir(), "claude-sessions", `${id}.json`), "utf8")));
}
