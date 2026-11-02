import { confirm, select } from "@inquirer/prompts";
import { Command } from "commander";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { globalConfigDir } from "../config/paths.js";
import { readCredentials } from "../config/credentials.js";
import { listProjects, resolveProject } from "../internal/projects.js";
import { listWorkloads } from "../internal/workloads.js";
import { request, resolveAuth } from "../internal/http.js";
import { runAction } from "../internal/output.js";
import { checkClaudeVersion, enableNativeClaude, readNativeState, removeNativeClaude, storedNativeCredential } from "../claude-native.js";

interface Options { org?: string; project?: string; workload?: string; environment?: string; model?: string; yes?: boolean }
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

export async function setupNativeClaude(opts: Options = {}) {
  const version = checkClaudeVersion();
  const credentials = readCredentials();
  if (!credentials || !Object.keys(credentials.orgs).length) throw new Error("Sign in first with orchestra login, then run orchestra claude-setup.");
  if (process.env.UNDERSTUDY_API_KEY || process.env.UNDERSTUDY_GATEWAY_URL) throw new Error("Unset shell credential/gateway overrides; persistent setup uses your saved organization credential.");
  const org = await choose("Organization", opts.org, Object.keys(credentials.orgs).map(value => ({ name: value, value })));
  const auth = resolveAuth(org);
  const projects = await listProjects(auth);
  const project = await choose("Project", opts.project, projects.map(p => ({ name: p.name ?? p.slug, value: p.slug })));
  const resolved = await resolveProject({ org, project });
  const workloads = await listWorkloads(resolved);
  const workload = await choose("Workload", opts.workload, workloads.map(w => ({ name: w.name, value: w.name })));
  const environment = z.enum(["test", "production"]).parse(await choose("Traffic environment", opts.environment, [{ name: "Test", value: "test" }, { name: "Production", value: "production" }]));
  const catalog = (await request({ orgId: org, url: `/admin/v1/orgs/${org}/models` }, z.object({ models: z.array(z.object({ id: z.string(), display_name: z.string().optional() })) }))).data.models;
  // The initial native integration is validated with Claude models only.
  const models = catalog.filter(m => m.id.startsWith("claude-"));
  const model = await choose("Claude model", opts.model, models.map(m => ({ name: m.display_name ?? m.id, value: m.id })));
  const capture = workloads.find(w => w.name === workload)?.capture_enabled;
  process.stdout.write(`\n${version}\nDefault: ${org} / ${project} / ${workload} (${environment})\nModel: ${model}\n\nNormal claude launches will send model requests, responses, and repository/branch metadata through Orchestra.\nWorkload capture: ${capture === true ? "enabled" : capture === false ? "disabled" : "unknown"}. Retention follows workspace policy; this wizard does not verify retention.\nExisting settings are backed up privately. Remove with: orchestra claude-setup remove\n`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error("Use --yes to enable this persistent default after reviewing the routing and capture scope.");
    if (!await confirm({ message: "Use Orchestra by default for Claude Code?", default: false })) return;
  }
  const result = enableNativeClaude({ version: 1, org, project, workload, environment, model, gateway_url: auth.gatewayUrl, harness_version: version }, fileURLToPath(new URL("../bin.js", import.meta.url)));
  process.stdout.write(result.next + "\n");
}

export function registerClaudeSetupCommand(program: Command) {
  const command = program.command("claude-setup").description("Configure normal Claude Code launches through Orchestra; reversible user-level setup.")
    .option("--org <id>").option("--project <slug>").option("--workload <name>")
    .option("--environment <environment>", "test or production").option("--model <id>")
    .option("--yes", "Confirm persistent routing and capture scope")
    .action(async function (this: Command, opts: Options) { await runAction(this, () => setupNativeClaude(opts)); });
  command.command("status").description("Check saved defaults, credentials, and settings drift without inference").action(async function (this: Command) {
    await runAction(this, async () => {
      const state = readNativeState(); storedNativeCredential(state.config);
      const current = JSON.parse(readFileSync(state.settings_path, "utf8"));
      const drift: string[] = [];
      for (const [key, value] of Object.entries(state.installed)) {
        if (key === "env") {
          for (const [name, expected] of Object.entries(value as Record<string, unknown>)) if (current.env?.[name] !== expected) drift.push(`env.${name}`);
        } else if (current[key] !== value) drift.push(key);
      }
      process.stdout.write(JSON.stringify({ enabled: true, claude: checkClaudeVersion(), defaults: state.config, settings_drift: drift, limits: "Local terminal integration. Project/managed settings, shell overrides, --bare/--safe-mode, or disabled mods can prevent it. Run a smoke session to verify routing.", remove: "orchestra claude-setup remove" }, null, 2) + "\n");
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
