import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, accessSync, constants, realpathSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { globalConfigDir, samePath } from "./config/paths.js";
import { readCredentials } from "./config/credentials.js";
import { ClaudeSessionSchema, claudeEnvironment, repositoryFromRemote } from "./commands/claude.js";

export const BLOCKED_GATEWAY = "http://127.0.0.1:1";
const Header = z.string().min(1).max(256).regex(/^[\x20-\x7e]+$/);
export const ClaudeNativeConfigSchema = z.object({
  version: z.literal(1), org: Header, project: Header, workload: Header,
  environment: z.enum(["test", "production"]), gateway_url: z.string().url(), model: Header.optional(), harness_version: z.string().optional(),
});
export type ClaudeNativeConfig = z.infer<typeof ClaudeNativeConfigSchema>;
type Document = Record<string, unknown>;
const object = (value: unknown): Document => z.record(z.string(), z.unknown()).parse(value);
const statePath = () => join(globalConfigDir(), "claude-native.json");
export const claudeSettingsPath = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
const readJson = (path: string): Document => existsSync(path) ? object(JSON.parse(readFileSync(path, "utf8"))) : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function writeNativeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(dirname(path), ".orchestra-write-"));
  try {
    writeFileSync(join(temp, "data"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(join(temp, "data"), path);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

const StateSchema = z.object({
  config: ClaudeNativeConfigSchema, settings_path: z.string(),
  onboarding: z.object({ path: z.string(), before: z.boolean().optional() }).optional(),
  before: z.record(z.string(), z.unknown()), installed: z.record(z.string(), z.unknown()),
});
export const hasNativeClaudeSetup = () => existsSync(statePath());
export function readNativeState() {
  if (!existsSync(statePath())) throw new Error("Claude integration is not enabled. Run orchestra claude-setup.");
  return StateSchema.parse(readJson(statePath()));
}

export function storedNativeCredential(config: ClaudeNativeConfig): string {
  // Persistent setup is bound to a stored org credential, never an ambient shell API key.
  const entry = readCredentials()?.orgs[config.org];
  if (!entry || entry.gateway_url !== config.gateway_url) throw new Error("Claude credential is missing or its gateway changed. Sign in and run orchestra claude-setup again.");
  return entry.api_key;
}

export function claudeUpdateCommand(searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath.split(delimiter)) {
    const executable = join(directory || ".", "claude");
    try { accessSync(executable, constants.X_OK); } catch { continue; }
    const target = realpathSync(executable);
    const cask = /[/\\]Caskroom[/\\](claude-code(?:@latest)?)[/\\]/.exec(target)?.[1];
    return cask ? { command: "brew", args: ["upgrade", cask] } : { command: "claude", args: ["update"] };
  }
  return { command: "claude", args: ["update"] };
}

export function checkClaudeVersion(): string {
  let version: string;
  try {
    version = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("Could not run claude --version. Install Claude Code or fix PATH, then retry. https://code.claude.com/docs/en/setup");
  }
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 309)))) {
    throw new Error(`Detected Claude Code ${version || "unknown"}. Persistent Orchestra setup requires 2.1.309 or later.`);
  }
  return version;
}

export function nativeModSource(command: string[]): string {
  return `const command = ${JSON.stringify(command)};
async function apply($) {
  // Refuse network inference until both credentials and attribution are initialized.
  await $.env.set('ANTHROPIC_BASE_URL', '${BLOCKED_GATEWAY}');
  await $.env.set('ANTHROPIC_API_KEY', 'orchestra-initialization-required');
  const result = await $.process.run(command, {
    stdin: JSON.stringify({ session_id: await $.session.id() }), timeoutMs: 10000,
  });
  if (result.exitCode !== 0) throw new Error('Run orchestra claude-setup status to diagnose or orchestra claude-setup remove to restore your settings.');
  const env = JSON.parse(result.stdout);
  await $.env.set('ANTHROPIC_CUSTOM_HEADERS', env.ANTHROPIC_CUSTOM_HEADERS);
  await $.env.set('ANTHROPIC_AUTH_TOKEN', '');
  await $.env.set('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY);
  await $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL);
}
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { await apply($); } catch { $.ui.log('Orchestra setup needs attention. Run orchestra claude-setup status. Inference is blocked until setup succeeds.'); }
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    try { await apply($); } catch { $.ui.log('Orchestra could not initialize this session. Run orchestra claude-setup status.'); return; }
    return yield* next(e);
  });
}
`;
}

const codingModelOption = {
  ANTHROPIC_CUSTOM_MODEL_OPTION: "deepseek-v4.1-flash-1017",
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "DeepSeek V4.1 Flash 1017",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Through Orchestra",
};

function pickerDefaults(env: Document): Document {
  // Claude has one custom-option slot; never take over a user's existing entry.
  return Object.keys(codingModelOption).some(key => Object.hasOwn(env, key)) ? {} : codingModelOption;
}

export function refreshNativeClaudeModels() {
  const state = readNativeState();
  if (lstatSync(state.settings_path).isSymbolicLink()) throw new Error("Claude settings is a symlink. Configure its owner directly.");
  const current = readJson(state.settings_path);
  const env = object(current.env ?? {});
  const additions = pickerDefaults(env);
  if (!Object.keys(additions).length) return { changed: false, next: "Existing custom model option preserved. Select DeepSeek explicitly with /model deepseek-v4.1-flash-1017." };
  state.installed.env = { ...object(state.installed.env ?? {}), ...additions };
  writeNativeJson(statePath(), state);
  writeNativeJson(state.settings_path, { ...current, env: { ...env, ...additions } });
  return { changed: true, next: "Restart Claude, then select DeepSeek V4.1 Flash 1017 in /model. Your default model is unchanged. Managed model restrictions still apply." };
}

export function enableNativeClaude(value: ClaudeNativeConfig, cli: string, node = process.execPath) {
  const config = ClaudeNativeConfigSchema.parse(value);
  const url = new URL(config.gateway_url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Persistent gateway must be HTTPS without embedded credentials, query, or fragment.");
  storedNativeCredential(config);
  if (existsSync(statePath())) throw new Error("Claude integration is already enabled. Remove it before changing the default scope.");
  const settingsPath = claudeSettingsPath();
  if (existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink()) throw new Error("Claude settings is a symlink. Configure its owner directly before enabling Orchestra.");
  const before = readJson(settingsPath);
  const onboardingPath = join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
  if (existsSync(onboardingPath) && lstatSync(onboardingPath).isSymbolicLink()) throw new Error("Claude profile is a symlink. Configure its owner directly.");
  const profile = readJson(onboardingPath);
  if (profile.hasCompletedOnboarding !== undefined && typeof profile.hasCompletedOnboarding !== "boolean") throw new Error("Claude onboarding state is invalid.");
  if (before.disableAllHooks === true) throw new Error("Claude hooks/mods are disabled. Enable them before configuring Orchestra.");
  const env = object(before.env ?? {});
  const conflicts = Object.keys(process.env).filter(key => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_PLUGIN_DIRS$)/.test(key) && process.env[key]);
  if (conflicts.length) throw new Error(`Unset conflicting shell variables before setup: ${conflicts.join(", ")}`);
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_CODE_USE_") && env[key] && env[key] !== "0") throw new Error(`Remove conflicting provider setting env.${key} before setup.`);
  const plugin = join(globalConfigDir(), "claude-native-mod");
  const plugins = typeof env.CLAUDE_CODE_PLUGIN_DIRS === "string" && env.CLAUDE_CODE_PLUGIN_DIRS ? env.CLAUDE_CODE_PLUGIN_DIRS + (process.platform === "win32" ? ";" : ":") : "";
  const installed = {
    env: {
      ...pickerDefaults(env),
      ANTHROPIC_BASE_URL: BLOCKED_GATEWAY,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "orchestra-initialization-required",
      ANTHROPIC_CUSTOM_HEADERS: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_PLUGIN_DIRS: plugins + plugin,
    },
    ...(config.model ? { model: config.model } : {}),
  };
  writeNativeJson(join(plugin, ".claude-plugin", "plugin.json"), { name: "orchestra-gateway", version: "0.1.0", author: { name: "Orchestra" }, license: "MIT", description: "Persistent Orchestra gateway and session attribution" });
  writeNativeJson(join(plugin, "hooks", "hooks.json"), { modules: ["./register.js"] });
  writeFileSync(join(plugin, "hooks", "register.js"), nativeModSource([node, resolve(cli), "claude-native-env"]), { mode: 0o600 });
  // Save recovery state first: interruption before settings write remains safely removable.
  writeNativeJson(statePath(), { config, settings_path: settingsPath, before, installed, onboarding: { path: onboardingPath, before: profile.hasCompletedOnboarding } });
  writeNativeJson(settingsPath, { ...before, ...installed, env: { ...env, ...installed.env } });
  writeNativeJson(onboardingPath, { ...profile, hasCompletedOnboarding: true });
  return { enabled: true, settings_path: settingsPath, next: "Orchestra is enabled for future Claude Code sessions. Run claude normally in any repository. To restore previous settings: orchestra claude-setup remove, then restart Claude." };
}

export function removeNativeClaude() {
  const state = readNativeState();
  const current = readJson(state.settings_path);
  const preserved: string[] = [];
  for (const [key, installed] of Object.entries(state.installed)) {
    if (key === "env") {
      const env = object(current.env ?? {}); const original = object(state.before.env ?? {});
      for (const [name, value] of Object.entries(object(installed))) {
        if (same(env[name], value)) {
          if (Object.hasOwn(original, name)) env[name] = original[name]; else delete env[name];
        } else if (name === "CLAUDE_CODE_PLUGIN_DIRS" && typeof env[name] === "string") {
          const separator = process.platform === "win32" ? ";" : ":";
          env[name] = (env[name] as string).split(separator).filter(path => !samePath(path, join(globalConfigDir(), "claude-native-mod"))).join(separator);
        } else preserved.push(`env.${name}`);
      }
      if (Object.keys(env).length || Object.hasOwn(state.before, "env")) current.env = env; else delete current.env;
    } else if (same(current[key], installed)) {
      if (Object.hasOwn(state.before, key)) current[key] = state.before[key]; else delete current[key];
    } else preserved.push(key);
  }
  if (state.onboarding) {
    const path = state.onboarding.path;
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Claude profile is a symlink. Configure its owner directly.");
    const profile = readJson(path);
    if (profile.hasCompletedOnboarding === true) {
      if (state.onboarding.before === undefined) delete profile.hasCompletedOnboarding;
      else profile.hasCompletedOnboarding = state.onboarding.before;
      writeNativeJson(path, profile);
    }
  }
  writeNativeJson(state.settings_path, current);
  rmSync(statePath());
  // Keep the inert mod files for running sessions; new sessions no longer load them.
  return { enabled: false, preserved_user_edits: preserved, next: "Restart Claude to use your restored settings." };
}

export function nativeClaudeEnvironment(id: string, cwd = process.cwd()) {
  z.string().uuid().parse(id);
  const { config } = readNativeState();
  const token = storedNativeCredential(config);
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
  let root = resolve(cwd), repository: string | null = null, branch: string | null = null, base_commit: string | null = null;
  try { root = git("rev-parse", "--show-toplevel"); } catch { /* Non-repository sessions still have request accounting. */ }
  try { repository = repositoryFromRemote(git("remote", "get-url", "origin")); } catch { /* Unsupported remotes are not uploaded. */ }
  try { branch = git("symbolic-ref", "--short", "HEAD"); } catch { /* Detached HEAD has no branch attribution. */ }
  try { base_commit = git("rev-parse", "HEAD"); } catch { /* Empty repositories have no base commit. */ }
  const path = join(globalConfigDir(), "claude-sessions", `${id}.json`);
  let session;
  if (existsSync(path)) {
    session = ClaudeSessionSchema.parse(readJson(path));
    if (!samePath(session.root, root) || session.repository !== repository || session.branch !== branch) throw new Error("Session repository or branch changed. Start a new Claude session to preserve attribution.");
    for (const field of ["org", "project", "workload", "environment", "gateway_url"] as const) if (session[field] !== config[field]) throw new Error("Session scope changed. Start a new Claude session.");
  } else {
    session = ClaudeSessionSchema.parse({ ...config, version: 1, session_id: id, traceparent: `00-${randomUUID().replaceAll("-", "")}-${randomBytes(8).toString("hex")}-01`, created_at: new Date().toISOString(), root, repository, branch, base_commit });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(session, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  }
  return claudeEnvironment({}, session, token);
}
