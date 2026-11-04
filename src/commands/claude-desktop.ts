import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readCredentials } from "../config/credentials.js";
import { ClaudeNativeConfigSchema, hasNativeClaudeSetup, repairNativeClaude } from "../claude-native.js";
import { desktopCredential, desktopStatus, installDesktop, removeDesktop } from "../claude-desktop.js";
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
export function registerClaudeDesktopCommand(program: Command) {
  const root = program.command("claude-desktop").description("Configure a separate, reversible Claude Desktop gateway profile (macOS)");
  root.command("setup").requiredOption("--org <id>").requiredOption("--project <slug>")
    .requiredOption("--workload <name>").requiredOption("--model <id...>", "Claude model IDs available to this organization")
    .option("--environment <name>", "test or production", "test").option("--yes", "Confirm persistent Desktop routing")
    .action(async function (this: Command, opts) { await runAction(this, async () => {
      requireQuit();
      if (!opts.yes) throw new Error("This routes future Desktop model requests and responses through Orchestra under the selected scope and capture policy. Pass --yes to configure; remove with orchestra claude-desktop remove.");
      if (process.env.UNDERSTUDY_API_KEY || process.env.UNDERSTUDY_GATEWAY_URL) throw new Error("Unset UNDERSTUDY_API_KEY and UNDERSTUDY_GATEWAY_URL for Desktop setup; it validates the saved sign-in used by the credential helper.");
      const entry = readCredentials()?.orgs[opts.org];
      if (!entry) throw new Error("Sign in with orchestra login before configuring Desktop.");
      const config = ClaudeNativeConfigSchema.parse({ version: 1, org: opts.org, project: opts.project, workload: opts.workload, environment: opts.environment, gateway_url: entry.gateway_url });
      const project = await resolveProject({ org: config.org, project: config.project });
      if (!(await listWorkloads(project)).some(workload => workload.name === config.workload)) throw new Error("The selected workload is not available in this project.");
      const catalog = (await request({ orgId: config.org, url: `/admin/v1/orgs/${encodeURIComponent(config.org)}/models` }, z.object({ models: z.array(z.object({ id: z.string() })) }))).data.models;
      if (opts.model.some((id: string) => !catalog.some(model => model.id === id))) throw new Error("A selected model is not available to this organization.");
      const cli = fileURLToPath(new URL("../bin.js", import.meta.url));
      if (hasNativeClaudeSetup()) repairNativeClaude(cli);
      const result = installDesktop(config, opts.model, cli);
      emitResult(this, "Configured, not yet verified. Open Claude Desktop → Code, choose a test folder, and send a small request. Confirm its scope and capture in Orchestra. Remove with orchestra claude-desktop remove (quit Desktop first).", result);
    }); });
  root.command("status").action(async function (this: Command) { await runAction(this, async () => { const result = desktopStatus(); emitResult(this, JSON.stringify(result, null, 2), result); }); });
  root.command("remove").action(async function (this: Command) { await runAction(this, async () => { requireQuit(); removeDesktop(); emitResult(this, "Removed Orchestra's Desktop profile. Restart Claude to use the previous profile. Terminal setup is unchanged.", { removed: true }); }); });
  root.command("credential", { hidden: true }).description("Desktop credential-helper protocol; do not run in a terminal")
    .action(() => {
      // Keep credential output out of generic error and telemetry paths.
      try { process.stdout.write(JSON.stringify(desktopCredential()) + "\n"); }
      catch { process.stderr.write("Orchestra Desktop credentials unavailable. Run orchestra login, then reconfigure Desktop.\n"); process.exitCode = 1; }
    });
}
