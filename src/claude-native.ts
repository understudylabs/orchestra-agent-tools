import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, accessSync, constants, realpathSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { globalConfigDir, samePath } from "./config/paths.js";
import { readCredentials } from "./config/credentials.js";
import { ClaudeSessionSchema, claudeEnvironment, repositoryFromRemote } from "./commands/claude.js";

import { configureClaudeShell, removeClaudeShell, validateClaudeShell } from "./claude-terminal.js";

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
export const claudeSettingsPath = () => join(globalConfigDir(), "claude-terminal-settings.json");
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
  modelMigration: z.object({ before: z.string(), installed: z.string() }).optional(),
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
  // Desktop owns its account or third-party credentials and attribution.
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT') || '').startsWith('claude-desktop')) return;
  // Refuse network inference until both credentials and attribution are initialized.
  await $.env.set('ANTHROPIC_BASE_URL', '${BLOCKED_GATEWAY}');
  await $.env.set('ANTHROPIC_API_KEY', 'orchestra-initialization-required');
  const result = await $.process.run(command, {
    stdin: JSON.stringify({ session_id: await $.session.id() }), timeoutMs: 10000,
  });
  if (result.exitCode !== 0) throw new Error('Run orchestra claude-setup status to diagnose or orchestra claude-setup remove to restore your settings.');
  const env = JSON.parse(result.stdout);
  await $.env.set('ANTHROPIC_CUSTOM_HEADERS', env.ANTHROPIC_CUSTOM_HEADERS);
  // Keep the startup bearer-auth mode: switching to API-key auth here can trigger Claude's login gate.
  await $.env.set('ANTHROPIC_AUTH_TOKEN', env.ANTHROPIC_API_KEY);
  await $.env.set('ANTHROPIC_API_KEY', '');
  await $.env.set('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL);
}
export function register(on) {
  on('session.start', async ($, e, next) => {
    try { await apply($); } catch { $.ui.log('Orchestra setup needs attention. Run orchestra claude-setup status. Inference is blocked until setup succeeds.'); }
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    try { await apply($); } catch {
      const answer = 'Orchestra could not initialize this session. Run orchestra claude-setup status. If the repository, branch, or scope changed, start a new Claude session.';
      $.ui.log(answer);
      // A missing result makes Claude skip the hook and retry the blocked URL.
      // Answer the step without calling inference, preserving its pinned identity.
      yield { kind: 'text', index: 0, text: answer };
      yield { kind: 'stop', stopReason: 'end_turn', usage: null };
      return { turnId: e.turnId, index: e.index, answer, toolUses: [] };
    }
    return yield* next(e);
  });
}
`;
}

const deepSeekModel = "deepseek-v4.1-flash-1017";
const codingModelOption = {
  ANTHROPIC_CUSTOM_MODEL_OPTION: `${deepSeekModel}[1m]`,
  ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: "Orchestra Flash",
  ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION: "Fast coding through Orchestra",
};

function scopedDeepSeek(env: Document): string {
  return Object.hasOwn(env, "CLAUDE_CODE_MAX_CONTEXT_TOKENS") ? deepSeekModel : codingModelOption.ANTHROPIC_CUSTOM_MODEL_OPTION;
}

function pickerDefaults(env: Document): Document {
  // Claude has one custom-option slot; never take over a user's existing entry.
  const existing = Object.keys(codingModelOption).some(key => Object.hasOwn(env, key));
  return !existing ? { ...codingModelOption, ANTHROPIC_CUSTOM_MODEL_OPTION: scopedDeepSeek(env) } : {};
}

function compactionDefaults(settings: Document): Document {
  if (Object.hasOwn(settings, "autoCompactWindow") || Object.hasOwn(object(settings.env ?? {}), "CLAUDE_CODE_AUTO_COMPACT_WINDOW")) return {};
  const models = object(settings.modelSettings ?? {});
  const model = object(models[deepSeekModel] ?? {});
  // Per-model settings avoid imposing DeepSeek's policy on Claude models.
  return Object.hasOwn(model, "autoCompactWindow") ? {} : {
    [deepSeekModel]: { autoCompactWindow: 786432 },
  };
}

function mergeModelSettings(current: unknown, additions: Document): Document {
  const models = { ...object(current ?? {}) };
  for (const [id, values] of Object.entries(additions)) models[id] = { ...object(models[id] ?? {}), ...object(values) };
  return models;
}

export function refreshNativeClaudeModels() {
  const state = readNativeState();
  if (lstatSync(state.settings_path).isSymbolicLink()) throw new Error("Claude settings is a symlink. Configure its owner directly.");
  const current = readJson(state.settings_path);
  const env = object(current.env ?? {});
  const owned = object(state.installed.env ?? {});
  let migrated = false;
  const contextKey = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
  if (Object.hasOwn(owned, contextKey) && same(env[contextKey], owned[contextKey])) {
    const before = object(state.before.env ?? {});
    if (Object.hasOwn(before, contextKey)) env[contextKey] = before[contextKey]; else delete env[contextKey];
    delete owned[contextKey];
    migrated = true;
  }
  if (current.model === deepSeekModel && scopedDeepSeek(env) !== deepSeekModel) {
    const scoped = codingModelOption.ANTHROPIC_CUSTOM_MODEL_OPTION;
    if (state.installed.model === current.model) state.installed.model = scoped;
    else state.modelMigration = { before: deepSeekModel, installed: scoped };
    current.model = scoped;
    migrated = true;
  }
  if (scopedDeepSeek(env) !== deepSeekModel && env.ANTHROPIC_CUSTOM_MODEL_OPTION === deepSeekModel && owned.ANTHROPIC_CUSTOM_MODEL_OPTION === deepSeekModel) {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = codingModelOption.ANTHROPIC_CUSTOM_MODEL_OPTION;
    owned.ANTHROPIC_CUSTOM_MODEL_OPTION = codingModelOption.ANTHROPIC_CUSTOM_MODEL_OPTION;
    migrated = true;
  }
  const optionKey = "ANTHROPIC_CUSTOM_MODEL_OPTION";
  if ([deepSeekModel, `${deepSeekModel}[1m]`].includes(String(env[optionKey])) && same(env[optionKey], owned[optionKey])) {
    for (const key of ["ANTHROPIC_CUSTOM_MODEL_OPTION_NAME", "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"] as const) {
      if (Object.hasOwn(owned, key) && same(env[key], owned[key]) && env[key] !== codingModelOption[key]) {
        env[key] = codingModelOption[key];
        owned[key] = codingModelOption[key];
        migrated = true;
      }
    }
  }
  const additions = pickerDefaults(env);
  const modelDefaults = compactionDefaults(current);
  if (!migrated && !Object.keys(additions).length && !Object.keys(modelDefaults).length) return { changed: false, next: "Existing custom model option preserved. Select DeepSeek explicitly with /model deepseek-v4.1-flash-1017[1m]." };
  state.installed.env = { ...owned, ...additions };
  if (Object.keys(modelDefaults).length) state.installed.modelSettings = mergeModelSettings(state.installed.modelSettings, modelDefaults);
  writeNativeJson(statePath(), state);
  writeNativeJson(state.settings_path, { ...current, env: { ...env, ...additions }, ...(Object.keys(modelDefaults).length ? { modelSettings: mergeModelSettings(current.modelSettings, modelDefaults) } : {}) });
  return { changed: true, next: "Restart Claude, then select Orchestra Flash in /model. Your selected model is preserved; DeepSeek uses its scoped context hint. Managed model restrictions still apply." };
}

export function enableNativeClaude(value: ClaudeNativeConfig, cli: string, node = process.execPath) {
  const config = ClaudeNativeConfigSchema.parse(value);
  const url = new URL(config.gateway_url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Persistent gateway must be HTTPS without embedded credentials, query, or fragment.");
  storedNativeCredential(config);
  validateClaudeShell();
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
  const modelDefaults = compactionDefaults(before);
  const installed = {
    ...(Object.keys(modelDefaults).length ? { modelSettings: modelDefaults } : {}),
    env: {
      ...pickerDefaults(env),
      ANTHROPIC_BASE_URL: BLOCKED_GATEWAY,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "orchestra-initialization-required",
      ANTHROPIC_CUSTOM_HEADERS: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_PLUGIN_DIRS: plugins + plugin,
    },
    ...(config.model ? { model: config.model === deepSeekModel ? scopedDeepSeek(env) : config.model } : before.model === deepSeekModel ? { model: scopedDeepSeek(env) } : {}),
  };
  for (const [file, value] of Object.entries(nativePluginManifests)) writeNativeJson(join(plugin, file), value);
  writeFileSync(join(plugin, "hooks", "register.js"), nativeModSource([node, resolve(cli), "claude-native-env"]), { mode: 0o600 });
  // Save recovery state first: interruption before settings write remains safely removable.
  writeNativeJson(statePath(), { config, settings_path: settingsPath, before, installed, onboarding: { path: onboardingPath, before: profile.hasCompletedOnboarding } });
  writeNativeJson(settingsPath, { ...before, ...installed, ...(Object.keys(modelDefaults).length ? { modelSettings: mergeModelSettings(before.modelSettings, modelDefaults) } : {}), env: { ...env, ...installed.env } });
  writeNativeJson(onboardingPath, { ...profile, hasCompletedOnboarding: true });
  configureClaudeShell(resolve(cli), node);
  return { enabled: true, settings_path: settingsPath, next: "Orchestra is enabled for future Claude Code sessions. Open a new terminal, then run claude normally in any repository. In this terminal, run orchestra claude-native-launch. To restore previous settings: orchestra claude-setup remove, then restart Claude." };
}

const nativePluginManifests = {
  ".claude-plugin/plugin.json": { name: "orchestra-gateway", version: "0.1.0", author: { name: "Orchestra" }, license: "MIT", description: "Persistent Orchestra gateway and session attribution" },
  "hooks/hooks.json": { modules: ["./register.js"] },
};

export function nativeClaudeHookStatus(): "current" | "missing" | "outdated_or_modified" {
  const plugin = join(globalConfigDir(), "claude-native-mod");
  for (const [file, expected] of Object.entries(nativePluginManifests)) {
    const manifest = join(plugin, file);
    if (!existsSync(manifest)) return "missing";
    if (lstatSync(manifest).isSymbolicLink()) return "outdated_or_modified";
    try { if (!same(readJson(manifest), expected)) return "outdated_or_modified"; }
    catch { return "outdated_or_modified"; }
  }
  const path = join(plugin, "hooks", "register.js");
  if (!existsSync(path)) return "missing";
  if (lstatSync(path).isSymbolicLink()) return "outdated_or_modified";
  const source = readFileSync(path, "utf8");
  const match = /^const command = (.+);$/m.exec(source);
  if (!match) return "outdated_or_modified";
  try {
    const command = z.array(z.string()).parse(JSON.parse(match[1]!));
    return source === nativeModSource(command) ? "current" : "outdated_or_modified";
  } catch { return "outdated_or_modified"; }
}

export function repairNativeClaude(cli: string, node = process.execPath) {
  if (!samePath(readNativeState().settings_path, claudeSettingsPath())) {
    const legacy = readNativeState();
    storedNativeCredential(legacy.config);
    checkClaudeVersion();
    validateClaudeShell();
    const current = readJson(legacy.settings_path);
    const backup = mkdtempSync(join(globalConfigDir(), "claude-shared-migration-"));
    writeNativeJson(join(backup, "settings.json"), current);
    writeNativeJson(join(backup, "state.json"), legacy);
    removeNativeClaude();
    const shared = readJson(legacy.settings_path);
    const sharedEnv = object(shared.env ?? {});
    const terminalEnv: Document = {};
    for (const key of Object.keys(sharedEnv)) {
      if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_USE_")) {
        terminalEnv[key] = sharedEnv[key]; delete sharedEnv[key];
      }
    }
    writeNativeJson(claudeSettingsPath(), { env: terminalEnv, ...(shared.model ? { model: shared.model } : {}) });
    delete shared.model;
    writeNativeJson(legacy.settings_path, { ...shared, env: sharedEnv });
    const result = enableNativeClaude(legacy.config, cli, node);
    return { repaired: true, preserved_user_edits: [], next: result.next };
  }
  const state = readNativeState();
  storedNativeCredential(state.config);
  checkClaudeVersion();
  configureClaudeShell(resolve(cli), node);
  const plugin = join(globalConfigDir(), "claude-native-mod");
  const profilePath = state.onboarding?.path ?? join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json");
  for (const path of [state.settings_path, profilePath, plugin, join(plugin, ".claude-plugin"), ...Object.keys(nativePluginManifests).map(file => join(plugin, file)), join(plugin, "hooks"), join(plugin, "hooks", "register.js")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Claude integration contains a symlink. Configure its owner directly.");
  }
  if (!existsSync(state.settings_path)) throw new Error("Claude settings are missing. Reconfigure Orchestra to restore routing.");
  const current = readJson(state.settings_path);
  const env = object(current.env ?? {});
  const installed = object(state.installed.env ?? {});
  const profile = readJson(profilePath);
  if (profile.hasCompletedOnboarding !== undefined && typeof profile.hasCompletedOnboarding !== "boolean") throw new Error("Claude onboarding state is invalid.");
  const preserved: string[] = [];
  for (const [key, value] of Object.entries({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "orchestra-initialization-required" })) {
    if (same(env[key], installed[key])) { env[key] = value; installed[key] = value; }
    else preserved.push(`env.${key}`);
  }
  const migrateOnboarding = !state.onboarding;
  if (migrateOnboarding) state.onboarding = { path: profilePath, before: profile.hasCompletedOnboarding as boolean | undefined };
  else if (profile.hasCompletedOnboarding !== true) preserved.push("profile.hasCompletedOnboarding");
  state.installed.env = installed;
  // Retain the original uninstall snapshot across every repair.
  writeNativeJson(statePath(), state);
  writeNativeJson(state.settings_path, { ...current, env });
  if (migrateOnboarding) writeNativeJson(profilePath, { ...profile, hasCompletedOnboarding: true });
  mkdirSync(join(plugin, "hooks"), { recursive: true, mode: 0o700 });
  for (const [file, value] of Object.entries(nativePluginManifests)) writeNativeJson(join(plugin, file), value);
  const temp = mkdtempSync(join(plugin, "hooks", ".orchestra-repair-"));
  try {
    writeFileSync(join(temp, "register.js"), nativeModSource([node, resolve(cli), "claude-native-env"]), { mode: 0o600 });
    renameSync(join(temp, "register.js"), join(plugin, "hooks", "register.js"));
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return { repaired: true, preserved_user_edits: preserved, next: "Restart Claude to load the updated Orchestra integration. Routing and model choices are unchanged. Run orchestra claude-setup status to inspect configuration; inference and capture still require a smoke test." };
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
    } else if (key === "modelSettings") {
      const models = object(current.modelSettings ?? {});
      const original = object(state.before.modelSettings ?? {});
      for (const [id, values] of Object.entries(object(installed))) {
        const row = object(models[id] ?? {});
        const before = object(original[id] ?? {});
        for (const [field, expected] of Object.entries(object(values))) {
          if (same(row[field], expected)) {
            if (Object.hasOwn(before, field)) row[field] = before[field]; else delete row[field];
          } else preserved.push(`modelSettings.${id}.${field}`);
        }
        if (Object.keys(row).length || Object.hasOwn(original, id)) models[id] = row; else delete models[id];
      }
      if (Object.keys(models).length || Object.hasOwn(state.before, "modelSettings")) current.modelSettings = models; else delete current.modelSettings;
    } else if (same(current[key], installed)) {
      if (Object.hasOwn(state.before, key)) current[key] = state.before[key]; else delete current[key];
    } else preserved.push(key);
  }
  if (state.modelMigration && current.model === state.modelMigration.installed) current.model = state.modelMigration.before;
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
  removeClaudeShell();
  writeNativeJson(state.settings_path, current);
  rmSync(statePath());
  // Keep the inert mod files for running sessions; new sessions no longer load them.
  return { enabled: false, preserved_user_edits: preserved, next: "Restart Claude to use your restored settings." };
}

export function nativeClaudeEnvironment(id: string, cwd = process.cwd()) {
  z.string().uuid().parse(id);
  const saved = readNativeState().config;
  // Only the child session launched by setup is test traffic; the saved default stays unchanged.
  const config = process.env.UNDERSTUDY_CLAUDE_SETUP_TEST_SESSION === id ? { ...saved, environment: "test" as const } : saved;
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

export async function launchNativeClaude(args: string[]) {
  if (!hasNativeClaudeSetup()) {
    const child = spawn("claude", args, { stdio: "inherit" });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
    return;
  }
  const state = readNativeState();
  if (!samePath(state.settings_path, claudeSettingsPath())) throw new Error("Run orchestra claude-setup repair to isolate terminal settings from Desktop.");
  if (!existsSync(state.settings_path)) throw new Error("Orchestra terminal settings are missing. Run orchestra claude-setup repair before launching.");
  const settings = readJson(state.settings_path);
  const env = { ...process.env, ...object(settings.env ?? {}) } as NodeJS.ProcessEnv;
  const child = spawn("claude", ["--settings", state.settings_path, ...args], { env, stdio: "inherit" });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
}
