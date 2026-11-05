import { confirm, select, checkbox } from "@inquirer/prompts";
import { accessibleOrganization, organizationChoices } from "./claude-setup.js";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readCredentials } from "../config/credentials.js";
import { ClaudeNativeConfigSchema, hasNativeClaudeSetup, repairNativeClaude } from "../claude-native.js";
import { desktopCredential, desktopPaths, desktopStatus, installDesktop, removeDesktop } from "../claude-desktop.js";
import { resolveProject } from "../internal/projects.js";
import { listWorkloads } from "../internal/workloads.js";
import { request } from "../internal/http.js";
import { emitResult, runAction } from "../internal/output.js";

function requireQuit() {
  if (process.platform !== "darwin") throw new Error("Desktop setup is currently validated on macOS only.");
  try { execFileSync("/usr/bin/pgrep", ["-x", "Claude"], { stdio: "ignore" }); }
  catch (error) { if ((error as { status?: number }).status === 1) return; throw new Error("Could not check whether Claude is running."); }
  throw new Error("Quit Claude Desktop before changing its profile, then retry.");
}
interface DesktopOptions { org?: string; project?: string; workload?: string; model?: string[]; environment?: string; yes?: boolean }
export async function setupClaudeDesktop(opts: DesktopOptions = {}) {
  requireQuit();
  if (!existsSync(desktopPaths().metadata)) throw new Error("Initialize Desktop once: open Claude → Help → Troubleshooting → Enable Developer Mode → Developer → Configure Third-Party Inference. Then quit Claude and run orchestra claude-desktop setup again. No settings were changed.");
  const interactive = Boolean(process.stdin.isTTY);
  if (!interactive && (!opts.org || !opts.project || !opts.workload || !opts.model?.length || !opts.yes)) {
    throw new Error("Noninteractive Desktop setup requires --org, --project, --workload, --model and --yes. Run orchestra claude-desktop setup in a terminal for guided setup.");
  }
  if (process.env.UNDERSTUDY_API_KEY || process.env.UNDERSTUDY_GATEWAY_URL) throw new Error("Unset UNDERSTUDY_API_KEY and UNDERSTUDY_GATEWAY_URL for Desktop setup; it validates the saved sign-in used by the credential helper.");
  let credentials = readCredentials();
  if (!credentials || !Object.keys(credentials.orgs).length) throw new Error("Run orchestra login, then orchestra claude-desktop setup to continue.");
  const accessible = await accessibleOrganization(await organizationChoices(credentials), opts.org);
  if (!accessible) return;
  credentials = readCredentials();
  const entry = credentials?.orgs[accessible.org];
  if (!entry) throw new Error("Saved sign-in is no longer available. Run orchestra login and retry.");
  const pick = async (message: string, supplied: string | undefined, choices: { name: string; value: string }[]) => {
    if (supplied) {
      if (!choices.some(choice => choice.value === supplied)) throw new Error(`${message}: selection is not available.`);
      return supplied;
    }
    if (!choices.length) throw new Error(`${message}: none available. Create one in Orchestra, then rerun orchestra claude-desktop setup.`);
    if (choices.length === 1) return choices[0]!.value;
    return select({ message, choices });
  };
  const projectSlug = await pick("Desktop project", opts.project, accessible.projects.map(project => ({ name: `${project.name ?? project.slug} (${project.slug})`, value: project.slug })));
  const project = await resolveProject({ org: accessible.org, project: projectSlug });
  const workloads = await listWorkloads(project);
  const workload = await pick("Desktop workload", opts.workload, workloads.map(workload => ({ name: `${workload.name} · capture ${workload.capture_enabled === true ? "enabled" : workload.capture_enabled === false ? "disabled" : "unknown"}`, value: workload.name })));
  const catalog = (await request({ orgId: accessible.org, url: `/admin/v1/orgs/${encodeURIComponent(accessible.org)}/models` }, z.object({ models: z.array(z.object({ id: z.string() })) }))).data.models.filter(model => /^claude-[a-z0-9.-]+$/.test(model.id));
  if (!catalog.length) throw new Error("No supported Claude models are available to this organization. Desktop open-model support is still experimental.");
  const models = opts.model ?? await checkbox({ message: "Models to show in Desktop (select at least one)", choices: catalog.map(model => ({ name: model.id, value: model.id })), required: true });
  if (!models.length || models.some(id => !catalog.some(model => model.id === id))) throw new Error("A selected model is not available for Desktop in this organization.");
  const environment = opts.environment ?? (interactive ? await select({ message: "Desktop traffic", choices: [{ name: "Test (recommended for the Desktop pilot)", value: "test" }, { name: "Production (everyday coding)", value: "production" }] }) : "test");
  const config = ClaudeNativeConfigSchema.parse({ version: 1, org: accessible.org, project: projectSlug, workload, environment, gateway_url: entry.gateway_url });
  if (!opts.yes) {
    process.stdout.write(`\n${accessible.name} / ${projectSlug} / ${workload} (${environment})\nModels: ${models.join(", ")}\nFuture Desktop requests and responses use this scope and its capture policy. Desktop uses a separate local workspace; claude.ai conversations remain in the original mode. Remove with orchestra claude-desktop remove.\n`);
    if (!await confirm({ message: "Use Orchestra for future Claude Desktop sessions?", default: true })) return;
  }
  const cli = fileURLToPath(new URL("../bin.js", import.meta.url));
  if (hasNativeClaudeSetup()) repairNativeClaude(cli);
  const result = installDesktop(config, models, cli);
  process.stdout.write("Configured, not yet verified.\nNext: open Claude Desktop → Code, choose a test folder, and send a small request. Verify its scope and capture in Orchestra.\nManage this setup: orchestra claude-desktop\n");
  if (interactive && await confirm({ message: "Open Claude Desktop now?", default: true })) execFileSync("/usr/bin/open", ["-a", "Claude"], { stdio: "ignore" });
  return result;
}
export function desktopStatusText(result: ReturnType<typeof desktopStatus>) {
  if (!result.configured) return "Claude Desktop: not configured.\nNext: orchestra claude-desktop setup";
  const issues = [...(!result.active ? ["another profile is selected"] : []), ...(result.drift ? ["profile has edits"] : []), ...(!result.credentialAvailable ? ["saved credential is missing or changed"] : []), ...(!result.helperAvailable ? ["credential helper is missing"] : [])];
  return `Claude Desktop: ${issues.length ? "needs attention — " + issues.join("; ") : "configured"}\n${result.config!.org} / ${result.config!.project} / ${result.config!.workload} (${result.config!.environment})\n${!result.credentialAvailable ? "Next: orchestra login, then orchestra claude-desktop setup" : issues.length ? "Next: orchestra claude-desktop setup; preserve any profile edits before reconfiguring" : "Next: open Desktop → Code and send a test request. Configuration checks do not verify inference or capture."}\nRemove: orchestra claude-desktop remove (quit Desktop first)`;
}
export async function manageClaudeDesktop() {
  const status = desktopStatus();
  process.stdout.write(desktopStatusText(status) + "\n");
  if (!process.stdin.isTTY) return;
  const action = await select({ message: "Claude Desktop", choices: [
    { value: "setup", name: status.configured ? "Reconfigure Desktop" : "Set up Desktop through Orchestra" },
    ...(status.configured ? [{ value: "open", name: "Open Claude Desktop" }, { value: "remove", name: "Remove Orchestra from Desktop" }] : []),
    { value: "exit", name: "Exit" },
  ] });
  if (action === "setup") await setupClaudeDesktop();
  if (action === "open") execFileSync("/usr/bin/open", ["-a", "Claude"], { stdio: "ignore" });
  if (action === "remove" && await confirm({ message: "Restore the previous Desktop profile? Terminal setup stays unchanged.", default: false })) {
    requireQuit(); removeDesktop(); process.stdout.write("Removed. Restart Claude Desktop to use the previous profile.\n");
  }
}
export function registerClaudeDesktopCommand(program: Command) {
  const root = program.command("claude-desktop").description("Set up, inspect or remove the Claude Desktop gateway profile (macOS)")
    .action(async function (this: Command) { await runAction(this, manageClaudeDesktop); });
  root.command("setup").option("--org <id>").option("--project <slug>")
    .option("--workload <name>").option("--model <id...>", "Claude model IDs available to this organization")
    .option("--environment <name>", "test or production").option("--yes", "Confirm persistent Desktop routing")
    .action(async function (this: Command, opts: DesktopOptions) { await runAction(this, async () => { await setupClaudeDesktop(opts); }); });
  root.command("status").action(async function (this: Command) { await runAction(this, async () => { const result = desktopStatus(); emitResult(this, desktopStatusText(result), result); }); });
  root.command("remove").action(async function (this: Command) { await runAction(this, async () => { requireQuit(); removeDesktop(); emitResult(this, "Removed Orchestra's Desktop profile. Restart Claude to use the previous profile. Terminal setup is unchanged.", { removed: true }); }); });
  root.command("credential", { hidden: true }).description("Desktop credential-helper protocol; do not run in a terminal")
    .action(() => {
      // Keep credential output out of generic error and telemetry paths.
      try { process.stdout.write(JSON.stringify(desktopCredential()) + "\n"); }
      catch { process.stderr.write("Orchestra Desktop credentials unavailable. Run orchestra login, then reconfigure Desktop.\n"); process.exitCode = 1; }
    });
}
