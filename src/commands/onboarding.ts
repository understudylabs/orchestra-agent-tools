import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { globalConfigDir } from "../config/paths.js";
import { ClaudeSessionSchema } from "./claude.js";

import { checkbox, confirm, input, select } from "@inquirer/prompts";
import { Command } from "commander";
import kleur from "kleur";

import { setupNativeClaude } from "./claude-setup.js";
import { readNativeState, removeNativeClaude } from "../claude-native.js";
import { readCredentials } from "../config/credentials.js";
import { runAction } from "../internal/output.js";
import { readCliVersion } from "../internal/version.js";
import { startTargets, systemAgentProbe } from "../onboarding/agents.js";
import { AGENT_NAMES, runInit, type AttentionItem, type InitPrompts, type SetupChoice } from "../onboarding/init.js";
import { localModelLabStarted, onboardingPrompt } from "../onboarding/prompt.js";
import { runStart, type StartDeps } from "../onboarding/start.js";

function copyToClipboard(text: string): boolean {
  const candidates: [string, string[]][] =
    process.platform === "darwin" ? [["pbcopy", []]] : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]]];
  return candidates.some(([command, args]) => spawnSync(command, args, { input: text }).status === 0);
}

function openApp(app: string, folder?: string): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("open", ["-a", app, ...(folder ? [folder] : [])], { stdio: "ignore" }).status === 0;
}

function openUrl(url: string): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync("open", [url], { stdio: "ignore" }).status === 0;
}

function runInTerminal(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("close", (code) => done(code ?? 1));
    child.on("error", () => done(1));
  });
}

function systemStartDeps(prompt: string): StartDeps {
  return {
    cwd: process.cwd(),
    home: homedir(),
    targets: startTargets(systemAgentProbe()),
    prompt,
    choose: (message, choices) => select({ message, choices, pageSize: choices.length }),
    askFolder: (message, fallback) =>
      input({
        message,
        default: fallback,
        validate: (value) => {
          try {
            return statSync(resolve(value.replace(/^~(?=$|\/)/, homedir()))).isDirectory() || "That isn't a folder.";
          } catch {
            return "That folder doesn't exist.";
          }
        },
      }).then((value) => value.replace(/^~(?=$|\/)/, homedir())),
    copy: copyToClipboard,
    openApp,
    openUrl,
    run: runInTerminal,
    print: (line) => process.stdout.write(`  ${line}\n`),
    columns: process.stdout.columns,
  };
}

const systemInitPrompts: InitPrompts = {
  setup: (localModelsDefault, labAvailable) => {
    const choices: { value: SetupChoice; name: string; description: string }[] = [
      { value: "gateway", name: "Use Claude Code through Orchestra", description: "Set up normal claude launches once; reversible" },
      { value: "plugin", name: "Account + coding-agent plugin", description: "Recommended · about a minute" },
      { value: "choose", name: "Choose coding agents…", description: "Pick which agents get the plugin" },
      { value: "cli", name: "Just the CLI", description: "Already installed; skip the rest" },
    ];
    if (labAvailable) {
      choices.splice(1, 0, {
        value: "lab",
        name: "Account + plugin + local model lab",
        description: "Orchestra 2B (about 3.6 GB) downloads in the background",
      });
    }
    return select<SetupChoice>({
      message: "What do you want to set up?",
      default: localModelsDefault && labAvailable ? "lab" : "plugin",
      choices,
    });
  },
  agents: () =>
    checkbox({
      message: "Which coding agents should get the plugin?",
      choices: [
        { value: "claude-code", name: AGENT_NAMES["claude-code"], checked: true },
        { value: "codex", name: AGENT_NAMES.codex, checked: true },
        { value: "cursor", name: AGENT_NAMES.cursor, checked: true },
        { value: "devin", name: AGENT_NAMES.devin },
        { value: "opencode", name: `${AGENT_NAMES.opencode} (deprecated)` },
        { value: "hermes", name: `${AGENT_NAMES.hermes} (deprecated)` },
      ],
    }),
  email: (suggested) =>
    input({
      message: "Email for your Orchestra account (s to skip):",
      default: suggested || undefined,
    }),
  confirm: (message) => confirm({ message, default: true }),
};

function printAttention(items: AttentionItem[]): void {
  if (!items.length) return;
  process.stdout.write(`\n  ${kleur.yellow().bold("Needs attention")}\n`);
  for (const item of items) {
    process.stdout.write(`  ${kleur.yellow("!")} ${item.message}\n`);
    if (item.fix) process.stdout.write(`      ${kleur.cyan(item.fix)}\n`);
  }
}

/** Ctrl-C in a prompt ends the screen quietly instead of with a stack trace. */
async function quietOnExit(cmd: Command, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      process.stdout.write(`\n  ${kleur.gray("Stopped. Run `orchestra init` or `orchestra start` any time.")}\n`);
      process.exitCode = 130;
      return;
    }
    await runAction(cmd, async () => { throw error; });
  }
}

export function registerOnboardingCommands(program: Command): void {
  program
    .command("init")
    .description("Guided setup: sign in, add the Orchestra plugin to your coding agents, and start onboarding.")
    .option("--agents <list>", "Coding agents to add the plugin to (auto, claude-code, codex, cursor, devin, …); skips the menu.")
    .option("--local-models", "Also start the local model lab (Apple Silicon).")
    .option("--skip-login", "Do not ask to sign in.")
    .option("--advanced", "Choose which coding agents get the plugin.")
    .option("--lower-anthropic-bill", "Focus onboarding on lowering an Anthropic bill.")
    .option("--no-start", "Finish without the start screen.")
    .action(async function (this: Command, opts: { agents?: string; localModels?: boolean; skipLogin?: boolean; advanced?: boolean; lowerAnthropicBill?: boolean; start: boolean }) {
      await quietOnExit(this, async () => {
        // The installer has just shown its banner; standalone runs get a header.
        if (process.env.ORCHESTRA_INIT_FROM_INSTALLER !== "1") {
          process.stdout.write(`\n  ${kleur.bold("orchestra")} ${kleur.gray("· Turn AI spend into AI you own.")}\n\n`);
        }
        const outcome = await runInit(opts, systemInitPrompts, readCliVersion());
        printAttention(outcome.attention);
        if (outcome.choice === "gateway") { await setupNativeClaude({ start: opts.start }); return; }
        if (outcome.choice === "cli" || !opts.start) {
          process.stdout.write(`\n  Run ${kleur.cyan("orchestra start")} when you're ready to start onboarding in a coding agent.\n`);
          return;
        }
        process.stdout.write("\n");
        await runStart(
          systemStartDeps(
            onboardingPrompt({ signedIn: outcome.signedIn, labStarted: outcome.labStarted, lowerAnthropicBill: opts.lowerAnthropicBill }),
          ),
        );
      });
    });

  program
    .command("start")
    .description("Start Orchestra onboarding in a coding agent: open Claude Code or Codex here, or copy the prompt for a desktop app.")
    .option("--lower-anthropic-bill", "Focus onboarding on lowering an Anthropic bill.")
    .action(async function (this: Command, opts: { lowerAnthropicBill?: boolean }) {
      await quietOnExit(this, async () => {
        let configured = false;
        try {
          const { config } = readNativeState(); configured = true;
          process.stdout.write(`\nClaude Code · Use /model to choose a model\n${config.org} / ${config.project} / ${config.workload} (${config.environment})\nRun claude normally; this menu is optional.\n\n`);
        } catch { /* First setup remains available. */ }
        const action = await select({ message: "Orchestra", choices: [
          ...(configured ? [
            { value: "launch", name: "Start Claude Code" },
            { value: "resume", name: "Resume Claude Code" },
            { value: "status", name: "Check Claude gateway setup" },
            { value: "report", name: "View a session cost and capture report" },
            { value: "remove", name: "Remove Claude gateway default" },
          ] : [{ value: "setup", name: "Set up Claude Code through Orchestra" }]),
          { value: "plugin", name: "Start plugin onboarding in a coding agent" },
          { value: "exit", name: "Exit" },
        ] });
        if (action === "exit") return;
        if (action === "setup") { await setupNativeClaude(); return; }
        if (action === "launch" || action === "resume") {
          process.exitCode = await runInTerminal("claude", action === "resume" ? ["--resume"] : [], process.cwd()); return;
        }
        if (action === "remove") {
          if (await confirm({ message: "Restore previous Claude settings?", default: false })) process.stdout.write(JSON.stringify(removeNativeClaude(), null, 2) + "\n");
          return;
        }
        if (action === "report") {
          const dir = join(globalConfigDir(), "claude-sessions");
          const sessions = existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
            try { return [ClaudeSessionSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")))]; } catch { return []; }
          }).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
          if (!sessions.length) { process.stdout.write("No sessions yet. Run claude to start one.\n"); return; }
          const id = await select({ message: "Session report", choices: sessions.map(s => ({ value: s.session_id, name: `${s.created_at} · ${s.repository ?? "No GitHub remote"} · ${s.branch ?? "No branch"} · ${s.session_id.slice(0, 8)}` })) });
          process.exitCode = await runInTerminal(process.execPath, [process.argv[1]!, "claude-session", "account", id], process.cwd()); return;
        }
        if (action === "status") {
          process.exitCode = await runInTerminal(process.execPath, [process.argv[1]!, "claude-setup", action], process.cwd()); return;
        }
        await runStart(
          systemStartDeps(
            onboardingPrompt({
              signedIn: Boolean(readCredentials()),
              labStarted: localModelLabStarted(),
              lowerAnthropicBill: opts.lowerAnthropicBill,
            }),
          ),
        );
      });
    });
}
