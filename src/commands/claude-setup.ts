import { checkClaudeSetup, ClaudeSetupCheckError } from "../claude-setup-check.js";
import { confirm, input, select } from "@inquirer/prompts";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { stripVTControlCharacters } from "node:util";
import { globalConfigDir } from "../config/paths.js";
import { readCredentials, type Credentials } from "../config/credentials.js";
import { listProjects, resolveProject } from "../internal/projects.js";
import { chooseCodingProject } from "../onboarding/coding-project.js";
import { chooseCodingWorkload } from "../onboarding/coding-workload.js";
import { listWorkloads } from "../internal/workloads.js";
import { request, resolveAuth, UnderstudyApiError } from "../internal/http.js";
import { runAction } from "../internal/output.js";
import { nativeClaudeHookStatus, repairNativeClaude, refreshNativeClaudeModels, claudeUpdateCommand, hasNativeClaudeSetup, checkClaudeVersion, enableNativeClaude, readNativeState, removeNativeClaude, storedNativeCredential } from "../claude-native.js";

interface Options { org?: string; project?: string; workload?: string; environment?: string; model?: string; yes?: boolean; verify?: boolean }
async function choose(message: string, supplied: string | undefined, choices: { name: string; value: string }[]) {
  if (supplied) {
    if (!choices.some(choice => choice.value === supplied)) throw new Error(`${message}: selection is not available.`);
    return supplied;
  }
  if (choices.length === 1) return choices[0]!.value;
  if (!choices.length) throw new Error(`${message}: no available choices. Configure this in Orchestra first.`);
  if (!process.stdin.isTTY) throw new Error(`${message}: supply the corresponding option in noninteractive mode.`);
  return select({ message, choices });
}

const updateGuidance = "Native/npm install: claude update. Homebrew: brew upgrade claude-code (or claude-code@latest if installed). WinGet: winget upgrade Anthropic.ClaudeCode. For managed installs, ask your administrator. Then run orchestra claude-setup again.";

export async function prepareClaudeVersion(deps = {
  check: checkClaudeVersion,
  interactive: Boolean(process.stdin.isTTY),
  choose: () => select({ message: "Claude Code needs attention", choices: [
    { name: `Run ${[claudeUpdateCommand().command, ...claudeUpdateCommand().args].join(" ")}, then check again`, value: "update" },
    { name: "Check again (I updated Claude separately)", value: "retry" },
    { name: "Skip gateway setup for now", value: "skip" },
  ] }),
  update: () => new Promise<boolean>(resolve => {
    const update = claudeUpdateCommand();
    const child = spawn(update.command, update.args, { stdio: "inherit" });
    child.on("error", () => resolve(false));
    child.on("close", code => resolve(code === 0));
  }),
  write: (message: string) => { process.stderr.write(message + "\n"); },
}): Promise<string | undefined> {
  for (;;) {
    try { return deps.check(); } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check Claude Code.";
      if (!deps.interactive) throw new Error(`${message} ${updateGuidance} No gateway settings were changed.`);
      deps.write(`${message}\n${updateGuidance}\nGateway setup has not changed your Claude settings.`);
    }
    const action = await deps.choose();
    if (action === "skip") {
      deps.write("Gateway setup skipped. Run orchestra claude-setup when ready.");
      return;
    }
    if (action === "update" && !await deps.update()) deps.write("Claude update did not complete. Use the installation-specific instructions above, then check again or skip.");
  }
}

const OrganizationIdentityResponseSchema = z.object({ organization: z.object({ id: z.string(), name: z.string() }) });

export async function organizationChoices(credentials: Credentials, lookup = async (id: string) => {
  const entry = credentials.orgs[id]!;
  const { data } = await request({
    orgId: id,
    url: `${entry.gateway_url.replace(/\/+$/, "")}/admin/v1/orgs/${encodeURIComponent(id)}/identity`,
    headers: { Authorization: `Bearer ${entry.api_key}` },
    signal: AbortSignal.timeout(6_000),
  }, OrganizationIdentityResponseSchema);
  if (data.organization.id !== id) throw new Error("Organization identity mismatch");
  return data.organization.name;
}) {
  return Promise.all(Object.keys(credentials.orgs).map(async value => {
    try {
      const label = stripVTControlCharacters(await lookup(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
      return { name: label ? `${label} (${value})` : value, value };
    } catch {
      return { name: `${value} (name unavailable)`, value };
    }
  }));
}

async function signInForClaudeSetup(org: string) {
    const credentials = readCredentials();
    const email = (await input({ message: "Email for your Orchestra account (leave blank to cancel):", default: credentials?.email })).trim();
    if (!email) return false;
    const gateway = credentials?.orgs[org]?.gateway_url;
    return new Promise<boolean>(resolve => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../bin.js", import.meta.url)), "login", "--email", email, ...(gateway ? ["--gateway-url", gateway] : [])], { stdio: "inherit" });
      child.on("error", () => resolve(false));
      child.on("close", code => resolve(code === 0));
    });
  }

export async function accessibleOrganization(choices: { name: string; value: string }[], supplied?: string, deps = {
  interactive: Boolean(process.stdin.isTTY),
  pick: (available: { name: string; value: string }[]) => select({ message: "Organization", choices: available }),
  load: (org: string) => listProjects(resolveAuth(org)),
  recover: (another: boolean) => select({ message: "Organization access needs attention", choices: [
    { name: "Sign in again and continue setup (recommended)", value: "login" },
    ...(another ? [{ name: "Choose another organization", value: "another" }] : []),
    { name: "Skip gateway setup for now", value: "skip" },
  ] }),
  login: signInForClaudeSetup,
  reload: async () => {
    const credentials = readCredentials();
    return credentials ? organizationChoices(credentials) : [];
  },
  write: (message: string) => { process.stderr.write(message + "\n"); },
}) {
  let available = choices;
  let selected = supplied;
  let refreshed = false;
  for (;;) {
    if (selected && !available.some(choice => choice.value === selected)) throw new Error("Organization: selection is not available.");
    if (!selected) {
      if (!deps.interactive && available.length !== 1) throw new Error("Supply --org in noninteractive mode.");
      selected = available.length === 1 ? available[0]!.value : await deps.pick(available);
    }
    try { return { org: selected, name: available.find(choice => choice.value === selected)!.name, projects: await deps.load(selected) }; } catch (error) {
      if (!(error instanceof UnderstudyApiError) || ![401, 403].includes(error.status)) throw error;
      const label = available.find(choice => choice.value === selected)?.name ?? selected;
      const reason = refreshed
        ? "Sign-in completed, but this account still cannot access that organization. Check that you used the invited email, or ask your workspace administrator to confirm access."
        : "Its saved credential may have expired, been revoked, or lack organization access.";
      const message = `Cannot access ${label}. ${reason} Request ID: ${error.requestId || "unavailable"}.`;
      if (!deps.interactive) throw new UnderstudyApiError({ status: error.status, errorType: error.errorType, requestId: error.requestId, message: `${message} In a terminal, run orchestra login --email <email>, then orchestra claude-setup.` });
      deps.write(message);
      const remaining = available.filter(choice => choice.value !== selected);
      const action = await deps.recover(remaining.length > 0);
      if (action === "login") {
        if (!await deps.login(selected)) {
          deps.write("Sign-in did not complete. Setup stopped; run orchestra claude-setup when ready.");
          return;
        }
        refreshed = true;
        available = await deps.reload();
        if (!available.length) {
          deps.write("Sign-in did not provide organization access. Ask your workspace administrator to confirm membership, then run orchestra claude-setup.");
          return;
        }
        selected = supplied;
      } else if (action === "another") {
        available = remaining;
        selected = undefined;
      } else return;
    }
  }
}

export async function existingClaudeSetup(deps = {
  exists: hasNativeClaudeSetup,
  read: readNativeState,
  interactive: Boolean(process.stdin.isTTY),
  select: () => select({ message: "Claude Code already uses Orchestra", choices: [
    { name: "Update integration, keep current setup (recommended)", value: "repair" },
    { name: "Keep current setup without updating", value: "keep" },
    { name: "Add DeepSeek to the model picker", value: "models" },
    { name: "Remove current setup and configure again", value: "reconfigure" },
    { name: "Remove Orchestra from Claude Code", value: "remove" },
  ] }),
  confirm: (reconfigure: boolean) => confirm({ message: reconfigure
    ? "Restore previous Claude settings before configuring again? If you cancel the new setup, Orchestra stays disabled."
    : "Remove Orchestra and restore previous Claude settings?", default: false }),
  repair: () => repairNativeClaude(fileURLToPath(new URL("../bin.js", import.meta.url))),
  remove: removeNativeClaude,
  write: (message: string) => { process.stdout.write(message + "\n"); },
}): Promise<boolean> {
  if (!deps.exists()) return true;
  const state = deps.read();
  deps.write(`Orchestra is already configured: ${state.config.org} / ${state.config.project} / ${state.config.workload} (${state.config.environment}).\nRun claude normally. Check health: orchestra claude-setup status. Remove: orchestra claude-setup remove.`);
  if (!deps.interactive) throw new Error("Setup is already configured; nothing changed. Run orchestra claude-setup interactively to keep, remove, or reconfigure it.");
  const action = await deps.select();
  if (action === "repair") { deps.write(JSON.stringify(deps.repair(), null, 2)); return false; }
  if (action === "models") { deps.write(refreshNativeClaudeModels().next); return false; }
  if (action === "keep" || !await deps.confirm(action === "reconfigure")) return false;
  const removed = deps.remove();
  deps.write(removed.next);
  if (removed.preserved_user_edits.length) deps.write(`Preserved your changes: ${removed.preserved_user_edits.join(", ")}`);
  return action === "reconfigure";
}

export async function setupNativeClaude(opts: Options = {}) {
  if (!await existingClaudeSetup()) return;
  const version = await prepareClaudeVersion();
  if (!version) return;
  let credentials = readCredentials();
  if (!credentials || !Object.keys(credentials.orgs).length) throw new Error("Sign in first with orchestra login, then run orchestra claude-setup.");
  if (process.env.UNDERSTUDY_API_KEY || process.env.UNDERSTUDY_GATEWAY_URL) throw new Error("Unset shell credential/gateway overrides; persistent setup uses your saved organization credential.");
  const organizations = await organizationChoices(credentials);
  const accessible = await accessibleOrganization(organizations, opts.org);
  if (!accessible) return;
  const { org, projects } = accessible;
  const organizationLabel = accessible.name;
  credentials = readCredentials();
  if (!credentials) throw new Error("Saved sign-in is no longer available. Run orchestra claude-setup again.");
  const auth = resolveAuth(org);
  const project = await chooseCodingProject(org, credentials, projects, opts.project);
  if (!project) return;
  const resolved = await resolveProject({ org, project });
  const workloads = await listWorkloads(resolved);
  const selectedWorkload = await chooseCodingWorkload(resolved, workloads, opts.workload);
  if (!selectedWorkload) return;
  const workload = selectedWorkload.name;
  const environment = z.enum(["test", "production"]).parse(await choose("How will you use Claude Code?", opts.environment, [{ name: "Everyday coding (Production — recommended)", value: "production" }, { name: "Setup checks and experiments (Test)", value: "test" }]));
  const model = opts.model;
  if (model) {
    const catalog = (await request({ orgId: org, url: `/admin/v1/orgs/${org}/models` }, z.object({ models: z.array(z.object({ id: z.string() })) }))).data.models;
    if (!catalog.some(candidate => candidate.id === model && candidate.id.startsWith("claude-"))) throw new Error("The requested Claude model is not available in this organization.");
  }
  const capture = selectedWorkload.capture_enabled;
  process.stdout.write(`\n${version}\nDefault: ${organizationLabel} / ${project} / ${workload} (${environment})\nModel: ${model ?? "Use Claude’s current/default model; switch with /model"}\n\nThis user-level setup applies to future claude sessions across repositories. Model requests, responses, and repository/branch metadata will go through Orchestra.\nWorkload capture: ${capture === true ? "enabled" : capture === false ? "disabled" : "unknown"}. Retention follows workspace policy; this wizard does not verify retention.\nExisting settings are backed up privately. Remove with: orchestra claude-setup remove\n`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error("Use --yes to enable this persistent default after reviewing the routing and capture scope.");
    if (!await confirm({ message: "Use Orchestra for future Claude Code sessions?", default: true })) return;
  }
  const result = enableNativeClaude({ version: 1, org, project, workload, environment, model, gateway_url: auth.gatewayUrl, harness_version: version }, fileURLToPath(new URL("../bin.js", import.meta.url)));
  process.stdout.write(result.next + "\n");
  if (!opts.verify) {
    if (!process.stdin.isTTY || !await confirm({ message: "Verify setup with a small billable Claude request? Uses a fixed prompt, no tools or repository files, and test traffic.", default: true })) {
      process.stdout.write("Configured, but not verified. Run orchestra claude-setup verify before relying on this setup.\n");
      return;
    }
  }
  const outcome = await verifyClaudeSetup();
  if (outcome === "change") {
    removeNativeClaude();
    await setupNativeClaude();
  }
}

export async function verifyClaudeSetup(deps = {
  check: checkClaudeSetup,
  interactive: Boolean(process.stdin.isTTY),
  recover: () => select({ message: "Claude setup check failed", choices: [
    { name: "Retry the check", value: "retry" },
    { name: "Sign in again, then retry", value: "login" },
    { name: "Change organization, project or workload", value: "change" },
    { name: "Remove Orchestra and restore previous settings", value: "restore" },
    { name: "Keep configuration without verification", value: "keep" },
  ] }),
  login: () => signInForClaudeSetup(readNativeState().config.org),
  remove: removeNativeClaude,
  write: (message: string) => { process.stdout.write(message + "\n"); },
}) {
  for (;;) {
    deps.write("Checking Claude through Orchestra with a small billable test request…");
    try {
      const result = await deps.check();
      deps.write(`Ready: Claude responded through the configured integration. Capture has not been verified. Check session: ${result.session_id}.`);
      return "verified";
    } catch (error) {
      if (error instanceof ClaudeSetupCheckError) deps.write(error.message);
      deps.write("Claude did not complete the setup check. Configuration is not verified. Check access, model availability and connection before retrying.");
      if (!deps.interactive) throw new Error("Claude setup check failed; run orchestra claude-setup verify interactively for recovery.");
    }
    const action = await deps.recover();
    if (action === "retry") continue;
    if (action === "login") { if (await deps.login()) continue; return "unverified"; }
    if (action === "restore") { deps.write(deps.remove().next); return "restored"; }
    if (action === "change") return "change";
    return "unverified";
  }
}

export function registerClaudeSetupCommand(program: Command) {
  const command = program.command("claude-setup").description("Configure normal Claude Code launches through Orchestra; reversible user-level setup.")
    .option("--org <id>").option("--project <slug>").option("--workload <name>")
    .option("--environment <environment>", "test or production").option("--model <id>", "Optional starting Claude model; /model remains available")
    .option("--verify", "Run a small billable Claude setup check after configuration")
    .option("--yes", "Confirm persistent routing and capture scope")
    .action(async function (this: Command, opts: Options) { await runAction(this, () => setupNativeClaude(opts)); });
  command.command("verify").description("Send a small billable test request through the installed Claude integration").action(async function (this: Command) {
    await runAction(this, async () => {
      const outcome = await verifyClaudeSetup();
      if (outcome === "change") { removeNativeClaude(); await setupNativeClaude(); }
    });
  });
  command.command("repair").description("Update the installed integration while preserving routing and user settings").action(async function (this: Command) {
    await runAction(this, async () => { process.stdout.write(JSON.stringify(repairNativeClaude(fileURLToPath(new URL("../bin.js", import.meta.url))), null, 2) + "\n"); });
  });
  command.command("models").description("Add the DeepSeek picker option without changing routing or the default model").action(async function (this: Command) {
    await runAction(this, async () => { process.stdout.write(JSON.stringify(refreshNativeClaudeModels(), null, 2) + "\n"); });
  });
  command.command("status").description("Check saved defaults, credentials, and settings drift without inference").action(async function (this: Command) {
    await runAction(this, async () => {
      const state = readNativeState(); storedNativeCredential(state.config);
      const current = JSON.parse(readFileSync(state.settings_path, "utf8"));
      const drift: string[] = [];
      for (const [key, value] of Object.entries(state.installed)) {
        // /model intentionally updates this setting after an explicit starting model.
        if (key === "model") continue;
        if (key === "env") {
          for (const [name, expected] of Object.entries(value as Record<string, unknown>)) if (current.env?.[name] !== expected) drift.push(`env.${name}`);
        } else if (key === "modelSettings") {
          // Users can tune compaction and effort without invalidating gateway routing.
          continue;
        } else if (current[key] !== value) drift.push(key);
      }
      const hook = nativeClaudeHookStatus();
      if (hook !== "current") drift.push("native_hook");
      process.stdout.write(JSON.stringify({ enabled: true, hook, verification: { configuration: drift.length ? "needs_attention" : "configured", inference: "not_checked", capture: "not_checked" }, repair: "orchestra claude-setup repair", claude: checkClaudeVersion(), defaults: state.config, settings_drift: drift, limits: "Local terminal integration. Project/managed settings, shell overrides, --bare/--safe-mode, or disabled mods can prevent it. Run a smoke session to verify routing.", remove: "orchestra claude-setup remove" }, null, 2) + "\n");
      if (drift.length) process.exitCode = 1;
    });
  });
  command.command("remove").description("Restore only Orchestra-owned settings; preserve subsequent user edits").action(async function (this: Command) {
    await runAction(this, async () => { process.stdout.write(JSON.stringify(removeNativeClaude(), null, 2) + "\n"); });
  });
  command.command("sessions").description("List local session IDs for resume and accounting").action(async function (this: Command) {
    await runAction(this, async () => {
      const dir = join(globalConfigDir(), "claude-sessions");
      const sessions = existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
        const s = JSON.parse(readFileSync(join(dir, name), "utf8"));
        return { session_id: s.session_id, created_at: s.created_at, repository: s.repository, branch: s.branch };
      }).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
      process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    });
  });
}
