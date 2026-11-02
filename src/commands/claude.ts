import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { z } from "zod";

import { globalConfigDir, samePath } from "../config/paths.js";
import { resolveOrganizationAuth } from "../internal/projects.js";
import { runAction } from "../internal/output.js";

const HeaderValue = z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/);
export const ClaudeSessionSchema = z.object({
  version: z.literal(1),
  session_id: z.string().uuid(),
  traceparent: z.string().regex(/^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-01$/).optional(),
  created_at: z.string().datetime(),
  root: z.string(),
  repository: HeaderValue.nullable(),
  branch: HeaderValue.nullable(),
  base_commit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
  org: HeaderValue,
  project: HeaderValue,
  workload: HeaderValue,
  environment: z.enum(["test", "production"]),
  gateway_url: z.string().url(),
  harness_version: z.string().optional(),
});
type Session = z.infer<typeof ClaudeSessionSchema>;
interface Options {
  org?: string;
  project?: string;
  workload?: string;
  environment?: string;
  resume?: string;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function repositoryFromRemote(remote: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error("Attribution requires an origin on github.com without embedded credentials.");
  return match[1]!;
}

export function validateClaudeArgs(args: string[]): void {
  const forbidden = /^(?:--(?:session-id|resume|continue|fork-session|no-session-persistence|settings|setting-sources|worktree|background|bg|cloud|remote|teleport)|-[rcw])(?:=|$)/;
  if (args.some((arg) => forbidden.test(arg) || /^-[rcw]/.test(arg))) {
    throw new Error("Use orchestra claude --resume <session-id>; Claude session and settings overrides are not supported.");
  }
}

export function claudeSessionTags(session: Session): Record<string, string> {
  return Object.fromEntries(Object.entries({ harness: "claude-code", harness_version: session.harness_version,
    run_id: session.session_id, repository: session.repository, branch: session.branch, base_commit: session.base_commit,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function claudeEnvironment(env: NodeJS.ProcessEnv, session: Session, token: string): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_)/.test(key)) delete result[key];
  }
  result.ANTHROPIC_BASE_URL = session.gateway_url;
  result.ANTHROPIC_API_KEY = token;
  result.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  result.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  result.ANTHROPIC_CUSTOM_HEADERS = [
    `x-understudy-environment: ${session.environment}`,
    `x-understudy-project: ${session.project}`,
    `x-understudy-workload: ${session.workload}`,
    `x-understudy-session-id: ${session.session_id}`,
    ...(session.traceparent ? [`traceparent: ${session.traceparent}`] : []),
    `x-understudy-tags: ${JSON.stringify(claudeSessionTags(session))}`,
  ].join("\n");
  return result;
}

export function registerClaudeCommand(program: Command): void {
  program.command("claude")
    .description("Run Claude Code through Orchestra with persistent Git attribution.")
    .option("--org <id>", "Organization credential")
    .option("--project <slug>", "Gateway project slug (required for a new session)")
    .option("--workload <name>", "Gateway workload (required for a new session)")
    .option("--environment <environment>", "test or production (required for a new session)")
    .option("--resume <session-id>", "Resume an Orchestra-managed Claude session")
    .argument("[args...]", "Claude options after --")
    .action(async function (this: Command, args: string[], opts: Options) {
      await runAction(this, () => launchClaude(args, opts));
    });
}

async function launchClaude(args: string[], opts: Options): Promise<void> {
  validateClaudeArgs(args);
  const root = git("rev-parse", "--show-toplevel");
  const branch = git("symbolic-ref", "--short", "HEAD");
  const repository = repositoryFromRemote(git("remote", "get-url", "origin"));
  const dir = join(globalConfigDir(), "claude-sessions");
  let session: Session;
  if (opts.resume) {
    const id = z.string().uuid().parse(opts.resume);
    session = ClaudeSessionSchema.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")));
    if (!samePath(session.root, root) || session.repository !== repository || session.branch !== branch) {
      throw new Error("Resume from the original repository worktree and branch to preserve attribution.");
    }
    for (const field of ["org", "project", "workload", "environment"] as const) {
      if (opts[field] !== undefined && opts[field] !== session[field]) throw new Error(`Cannot change ${field} on resume.`);
    }
  } else {
    const auth = resolveOrganizationAuth(opts.org);
    session = ClaudeSessionSchema.parse({ version: 1, session_id: randomUUID(), traceparent: `00-${randomUUID().replaceAll("-", "")}-${randomBytes(8).toString("hex")}-01`, created_at: new Date().toISOString(), root, repository, branch, base_commit: git("rev-parse", "HEAD"), org: auth.orgId, project: opts.project, workload: opts.workload, environment: opts.environment, gateway_url: auth.gatewayUrl });
  }
  const auth = resolveOrganizationAuth(session.org);
  if (auth.gatewayUrl !== session.gateway_url) throw new Error("Gateway changed since this session was created.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!opts.resume) writeFileSync(join(dir, `${session.session_id}.json`), JSON.stringify(session, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stderr.write(`Orchestra session ${session.session_id} (${session.repository}, ${session.branch})\n`);
  // Settings env blocks can overwrite routing and attribution after startup.
  // Keep this launch isolated without changing the user's saved settings.
  const lock = join(dir, `${session.session_id}.lock`);
  try {
    closeSync(openSync(lock, "wx", 0o600));
  } catch {
    throw new Error("Session is already running or has a stale lock. Confirm Claude has stopped before removing its .lock file in the Orchestra claude-sessions directory.");
  }
  try {
    const child = spawn("claude", ["--setting-sources", "", opts.resume ? "--resume" : "--session-id", session.session_id, ...args], { env: claudeEnvironment(process.env, session, auth.token), stdio: "inherit" });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
    process.exitCode = code;
  } finally {
    unlinkSync(lock);
  }
}
