import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { globalConfigDir } from "./config/paths.js";
import { ClaudeNativeConfigSchema, storedNativeCredential, writeNativeJson, type ClaudeNativeConfig } from "./claude-native.js";

const Document = z.record(z.string(), z.unknown());
const Metadata = z.object({ entries: z.array(z.object({ id: z.string().uuid(), name: z.string() }).passthrough()), appliedId: z.string().uuid().optional() }).passthrough();
const State = z.object({ config: ClaudeNativeConfigSchema, id: z.string().uuid(), previous: z.string().uuid().optional(), profile: Document });
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function desktopPaths(home = homedir(), root = globalConfigDir()) {
  const library = join(home, "Library", "Application Support", "Claude-3p", "configLibrary");
  return { library, metadata: join(library, "_meta.json"), state: join(root, "claude-desktop.json"), lock: join(root, "claude-desktop.lock") };
}
export type DesktopPaths = ReturnType<typeof desktopPaths>;
function regular(path: string) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Desktop configuration is a symlink. Configure its owner directly.");
}
function locked<T>(paths: DesktopPaths, action: () => T): T {
  regular(paths.library); regular(paths.metadata); regular(paths.state);
  mkdirSync(join(paths.state, ".."), { recursive: true, mode: 0o700 });
  try { mkdirSync(paths.lock, { mode: 0o700 }); } catch { throw new Error("Another Desktop setup is running, or its lock needs recovery. Quit Claude and inspect the Orchestra Desktop lock before retrying."); }
  try { return action(); } finally { rmSync(paths.lock, { recursive: true }); }
}
export function desktopProfile(config: ClaudeNativeConfig, models: string[], cli: string, node = process.execPath) {
  const url = new URL(config.gateway_url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Desktop requires an HTTPS gateway without URL credentials.");
  if (!models.length || models.some(model => !/^claude-[a-z0-9.-]+$/.test(model))) throw new Error("Desktop currently supports validated Claude model IDs only. Non-Claude Desktop models remain experimental.");
  return {
    inferenceProvider: "gateway", inferenceGatewayBaseUrl: config.gateway_url,
    inferenceGatewayAuthScheme: "bearer", inferenceCredentialKind: "helper-script",
    inferenceCredentialHelper: node, inferenceCredentialHelperArgs: [cli, "claude-desktop", "credential"],
    inferenceCredentialHelperTtlSec: 300, inferenceCredentialHelperTimeoutSec: 10,
    inferenceCredentialHelperSilentRefreshEnabled: true, modelDiscoveryEnabled: false,
    inferenceModels: models.map(name => ({ name })), deploymentDisplayName: "Orchestra",
    inferenceCustomHeaders: desktopHeaders(config),
  };
}
function desktopHeaders(config: ClaudeNativeConfig) {
  return { "x-understudy-environment": config.environment, "x-understudy-project": config.project,
    "x-understudy-workload": config.workload, "x-understudy-tags": JSON.stringify({ harness: "claude-desktop" }) };
}
export function desktopCredential(paths = desktopPaths()) {
  const state = State.parse(read(paths.state));
  return { token: storedNativeCredential(state.config), headers: desktopHeaders(state.config) };
}
export function desktopStatus(paths = desktopPaths()) {
  if (!existsSync(paths.state)) return { configured: false, verified: false };
  const state = State.parse(read(paths.state));
  const meta = Metadata.parse(read(paths.metadata));
  const file = join(paths.library, `${state.id}.json`);
  let credentialAvailable = false;
  try { storedNativeCredential(state.config); credentialAvailable = true; } catch { /* Status reports recovery without exposing credential errors. */ }
  const helperAvailable = typeof state.profile.inferenceCredentialHelper === "string" && existsSync(state.profile.inferenceCredentialHelper)
    && Array.isArray(state.profile.inferenceCredentialHelperArgs) && typeof state.profile.inferenceCredentialHelperArgs[0] === "string" && existsSync(state.profile.inferenceCredentialHelperArgs[0]);
  return { configured: true, verified: false, credentialAvailable, helperAvailable, active: meta.appliedId === state.id,
    drift: !existsSync(file) || !same(read(file), state.profile), config: state.config };
}
export function installDesktop(config: ClaudeNativeConfig, models: string[], cli: string, paths = desktopPaths()) {
  const profile = desktopProfile(config, models, cli);
  return locked(paths, () => {
    if (!existsSync(paths.metadata)) throw new Error("Open Claude Desktop, enable Developer Mode, and open Configure Third-Party Inference once. Quit Claude, then retry.");
    const meta = Metadata.parse(read(paths.metadata));
    const old = existsSync(paths.state) ? State.parse(read(paths.state)) : undefined;
    const id = old?.id ?? randomUUID();
    const file = join(paths.library, `${id}.json`); regular(file);
    if (old && existsSync(file) && !same(read(file), old.profile)) throw new Error("The Orchestra Desktop profile was edited outside setup. Preserve those changes before reconfiguring.");
    // Save ownership before activation so interrupted setup can be removed safely.
    const state = { config, id, previous: old?.previous ?? meta.appliedId, profile };
    writeNativeJson(paths.state, state);
    writeNativeJson(file, profile);
    const entries = meta.entries.filter(entry => entry.id !== id);
    writeNativeJson(paths.metadata, { ...meta, entries: [...entries, { id, name: "Orchestra" }], appliedId: id });
    return desktopStatus(paths);
  });
}
export function removeDesktop(paths = desktopPaths()) {
  return locked(paths, () => {
    if (!existsSync(paths.state)) return;
    const state = State.parse(read(paths.state));
    const meta = Metadata.parse(read(paths.metadata));
    const file = join(paths.library, `${state.id}.json`); regular(file);
    if (existsSync(file) && !same(read(file), state.profile)) throw new Error("The Orchestra Desktop profile has user edits; removal stopped to preserve them.");
    const entries = meta.entries.filter(entry => entry.id !== state.id);
    const next = { ...meta, entries };
    if (meta.appliedId === state.id) {
      if (state.previous && entries.some(entry => entry.id === state.previous)) next.appliedId = state.previous;
      else delete next.appliedId;
    }
    writeNativeJson(paths.metadata, next);
    rmSync(file, { force: true }); rmSync(paths.state);
  });
}
