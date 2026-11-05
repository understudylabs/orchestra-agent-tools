import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { globalConfigDir, samePath } from "../config/paths.js";
import { resolveOrganizationAuth } from "../internal/projects.js";
import { repositoryFromRemote } from "./claude.js";
import { runAction } from "../internal/output.js";

const Header = z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/);
export const CodexSessionSchema = z.object({
  version: z.literal(1), session_id: z.string().uuid(), root: z.string(),
  org: Header, project: Header, workload: Header, environment: z.enum(["test", "production"]),
  repository: Header.optional(), branch: Header.optional(), base_commit: Header.optional(),
  model: Header, gateway_url: z.string().url(),
});
type Session = z.infer<typeof CodexSessionSchema>;
interface Options { org?: string; project?: string; workload?: string; environment?: string; model?: string; resume?: string }

export function validateCodexArgs(args: string[]) {
  const flags = /^(?:--(?:config|profile|model|cd|oss|local-provider|enable|disable|ephemeral|ignore-user-config)|-[cpmC])(?:=|$)/;
  if (args.some(arg => flags.test(arg) || /^-[cpmC].+/.test(arg)) || args.some(arg => ["resume", "fork", "login", "logout", "cloud"].includes(arg))) {
    throw new Error("Use Orchestra's --model and --resume options. Codex configuration, provider, directory and session overrides are not supported by this launcher.");
  }
}
function codexSettings(session: Session): [string, string][] {
  const url = new URL(session.gateway_url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Codex requires an HTTPS gateway without URL credentials, query or fragment.");
  const base = session.gateway_url.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  const headers = { "x-understudy-project": session.project, "x-understudy-workload": session.workload,
    "x-understudy-environment": session.environment, "x-understudy-session-id": session.session_id,
    "x-understudy-tags": JSON.stringify({ harness: "codex", run_id: session.session_id, repository: session.repository, branch: session.branch, base_commit: session.base_commit }) };
  return Object.entries({
    model: session.model, model_provider: "orchestra", "features.enable_request_compression": false,
    "shell_environment_policy.exclude": ["UNDERSTUDY_API_KEY"],
    "model_providers.orchestra.name": "Orchestra", "model_providers.orchestra.base_url": base,
    "model_providers.orchestra.env_key": "UNDERSTUDY_API_KEY", "model_providers.orchestra.wire_api": "responses",
    "model_providers.orchestra.requires_openai_auth": false, "model_providers.orchestra.supports_websockets": false,
    ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [`model_providers.orchestra.http_headers.${JSON.stringify(key)}`, value])),
  }).map(([key, value]) => [key, JSON.stringify(value)]);
}
export function codexConfig(session: Session): string {
  return codexSettings(session).map(([key, value]) => `${key} = ${value}\n`).join("");
}
export function codexOverrides(session: Session): string[] {
  // Command-line values outrank repository config as well as the isolated home.
  return codexSettings(session).flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}
export function codexEnvironment(env: NodeJS.ProcessEnv, home: string, token: string): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const name of Object.keys(next)) if (/^(?:OPENAI_|CODEX_|UNDERSTUDY_)/.test(name)) delete next[name];
  return { ...next, CODEX_HOME: home, UNDERSTUDY_API_KEY: token };
}
export function codexArguments(args: string[], resume: boolean): string[] {
  if (!resume) return args;
  return args[0] === "exec" ? ["exec", "resume", "--last", ...args.slice(1)] : ["resume", "--last", ...args];
}
function attribution(): { repository?: string; branch?: string; base_commit?: string } {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    return { repository: repositoryFromRemote(git("remote", "get-url", "origin")), branch: git("symbolic-ref", "--short", "HEAD"), base_commit: git("rev-parse", "HEAD") };
  } catch { return {}; }
}
export async function launchCodex(args: string[], opts: Options): Promise<void> {
  validateCodexArgs(args);
  const root = resolve(process.cwd());
  const sessions = join(globalConfigDir(), "codex-sessions");
  let session: Session;
  if (opts.resume) {
    const id = z.string().uuid().parse(opts.resume);
    session = CodexSessionSchema.parse(JSON.parse(readFileSync(join(sessions, id, "session.json"), "utf8")));
    const current = attribution();
    if (session.repository !== current.repository || session.branch !== current.branch) throw new Error("Resume from the original repository and branch.");
    if (!samePath(root, session.root)) throw new Error("Resume from the original directory.");
    for (const field of ["org", "project", "workload", "environment", "model"] as const) {
      if (opts[field] !== undefined && opts[field] !== session[field]) throw new Error(`Cannot change ${field} on resume.`);
    }
  } else {
    const auth = resolveOrganizationAuth(opts.org);
    session = CodexSessionSchema.parse({ version: 1, session_id: randomUUID(), root, ...attribution(), org: auth.orgId,
      project: opts.project, workload: opts.workload, environment: opts.environment, model: opts.model, gateway_url: auth.gatewayUrl });
  }
  const auth = resolveOrganizationAuth(session.org);
  if (auth.gatewayUrl !== session.gateway_url) throw new Error("Gateway changed since this session was created.");
  const config = codexConfig(session);
  const dir = join(sessions, session.session_id), home = join(dir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(dir, "launch.lock");
  try { closeSync(openSync(lock, "wx", 0o600)); }
  catch { throw new Error("This Orchestra Codex session is already running or has a stale launch.lock. Confirm Codex stopped before removing the lock."); }
  try {
    if (!opts.resume) writeFileSync(join(dir, "session.json"), JSON.stringify(session) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
    process.stderr.write(`Orchestra Codex session: ${session.session_id}\nResume: orchestra codex --resume ${session.session_id}\nUses a separate Codex home; your normal Codex configuration is unchanged.\n`);
    const child = spawn("codex", [...codexOverrides(session), ...codexArguments(args, Boolean(opts.resume))], { cwd: root, env: codexEnvironment(process.env, home, auth.token), stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new Error("Could not launch Codex. Install Codex CLI and retry.")));
      child.once("close", code => resolve(code ?? 1));
    });
  } finally { unlinkSync(lock); }
}
export function registerCodexCommand(program: Command) {
  program.command("codex").description("Run an isolated Codex session through Orchestra's native Responses gateway.")
    .option("--org <id>", "Organization credential")
    .option("--project <slug>", "Gateway project (required for new sessions)")
    .option("--workload <name>", "Gateway workload (required for new sessions)")
    .option("--environment <environment>", "test or production (required for new sessions)")
    .option("--model <id>", "Native OpenAI model (required for new sessions)")
    .option("--resume <session-id>", "Resume an Orchestra-managed Codex session")
    .argument("[args...]", "Codex arguments after --; use exec for noninteractive runs")
    .action(async function (this: Command, args: string[], opts: Options) { await runAction(this, () => launchCodex(args, opts)); });
}
