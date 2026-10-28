import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import kleur from "kleur";

import { readCredentials } from "../config/credentials.js";
import { globalConfigDir } from "../config/paths.js";
import { packagePath } from "../internal/package-root.js";
import { Checklist } from "./checklist.js";
import { installStateDir } from "./prompt.js";

export const LOCAL_MODEL_ID = "gemma-4-e2b-it-qat-mlx-vlm-understudy";

export const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
  devin: "Devin",
  opencode: "OpenCode",
  hermes: "Hermes",
};

export function labDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.UNDERSTUDY_LAB ?? join(globalConfigDir(), "agent-tools");
}

export interface AdapterResult {
  name: string;
  status: string;
  reason: string;
}

/** install.sh writes one `name|status|reason` line per agent it considered. */
export function readAdapterResults(stateDir: string): AdapterResult[] {
  const file = join(stateDir, "adapter-results.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", status = "", ...rest] = line.split("|");
      return { name, status, reason: rest.join("|") };
    });
}

export interface AttentionItem {
  message: string;
  fix: string;
}

/** install.sh writes one `message<TAB>fix` line per problem the person should see. */
export function readAttention(stateDir: string): AttentionItem[] {
  const file = join(stateDir, "attention.txt");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [message = "", fix = ""] = line.split("\t");
      return { message, fix };
    });
}

export function installedAgentsLine(results: AdapterResult[]): string | null {
  const names = results.filter((result) => result.status === "installed").map((result) => AGENT_NAMES[result.name] ?? result.name);
  return names.length ? `Plugin installed: ${names.join(", ")}` : null;
}

export function localModelsSupported(platform = process.platform, arch = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}

function hasCommand(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

export function suggestedEmail(): string {
  const email = readCredentials()?.email ?? spawnSync("git", ["config", "--get", "user.email"], { encoding: "utf8" }).stdout?.trim() ?? "";
  return /@(users\.)?noreply\.github\.com$|^noreply@github\.com$/i.test(email) ? "" : email;
}

export type SetupChoice = "plugin" | "lab" | "choose" | "cli";

export interface InitOptions {
  agents?: string;
  localModels?: boolean;
  skipLogin?: boolean;
  advanced?: boolean;
  lowerAnthropicBill?: boolean;
}

export interface InitPrompts {
  setup(localModelsDefault: boolean, labAvailable: boolean): Promise<SetupChoice>;
  agents(): Promise<string[]>;
  email(suggested: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}

export interface InitOutcome {
  choice: SetupChoice;
  signedIn: boolean;
  labStarted: boolean;
  attention: AttentionItem[];
  installed: string[];
}

/**
 * The guided part of the install: what to set up, then a checklist of the
 * CLI, the sign-in, the coding-agent plugin and, if chosen, the local model
 * lab. Anything that needs the person afterwards is returned in `attention`
 * rather than printed mid-run.
 */
export async function runInit(options: InitOptions, prompts: InitPrompts, version: string): Promise<InitOutcome> {
  const labAvailable = localModelsSupported();
  let choice: SetupChoice = options.localModels && labAvailable ? "lab" : "plugin";
  let agents = options.agents ?? "auto";
  if (!options.agents) {
    choice = options.advanced ? "choose" : await prompts.setup(Boolean(options.localModels), labAvailable);
    if (choice === "choose") agents = (await prompts.agents()).join(",") || "none";
  }
  const attention: AttentionItem[] = [];
  if (choice === "cli") {
    process.stdout.write(`  ${kleur.green("✓")} Orchestra CLI ${version}\n`);
    return { choice, signedIn: Boolean(readCredentials()), labStarted: false, attention, installed: [] };
  }

  const wantLab = choice === "lab" || Boolean(options.localModels && labAvailable);
  // Read before the checklist draws: a warning about the file (e.g. its mode)
  // must print above the live lines, not through them.
  const credentials = readCredentials();
  const steps = [
    { id: "cli", label: `Orchestra CLI ${version}` },
    ...(options.skipLogin ? [] : [{ id: "signin", label: "Sign in to Orchestra" }]),
    { id: "plugin", label: "Plugin for your coding agents" },
    ...(wantLab ? [{ id: "lab", label: "Local model lab (Orchestra 2B, about 3.6 GB)" }] : []),
  ];
  const list = new Checklist(steps);
  list.done("cli");

  let signedIn = Boolean(credentials);
  if (!options.skipLogin) {
    if (credentials) {
      list.done("signin", credentials.email ? `Signed in as ${credentials.email}` : "Signed in to Orchestra");
    } else {
      list.start("signin", "Sign in to Orchestra");
      list.pause();
      const email = (await prompts.email(suggestedEmail())).trim();
      if (email && email.toLowerCase() !== "s") {
        // The CLI's own sign-in: emails a one-time code and asks for it here.
        spawnSync(process.execPath, [process.argv[1] ?? "", "login", "--email", email], { stdio: "inherit" });
      }
      signedIn = Boolean(readCredentials());
      list.resume();
      if (signedIn) list.done("signin", `Signed in as ${email}`);
      else list.skip("signin", "Not signed in — run `orchestra login` any time");
    }
  }

  list.start("plugin", "Adding the plugin to your coding agents");
  const stateDir = installStateDir();
  mkdirSync(stateDir, { recursive: true });
  rmSync(join(stateDir, "adapter-results.txt"), { force: true });
  rmSync(join(stateDir, "attention.txt"), { force: true });
  await new Promise<void>((resolve) => {
    const child = spawn(
      "bash",
      [packagePath("install.sh"), "--only-step", "2", "--non-interactive", "--no-launch-agent", "--agents", agents, "--lab", labDir()],
      { stdio: "ignore", env: { ...process.env, UNDERSTUDY_INSTALL_OUTPUT: "verbose" } },
    );
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  const results = readAdapterResults(stateDir);
  attention.push(...readAttention(stateDir));
  for (const result of results.filter((candidate) => candidate.status === "failed")) {
    attention.push({ message: `The ${AGENT_NAMES[result.name] ?? result.name} plugin did not install: ${result.reason}.`, fix: "" });
  }
  const installedLine = installedAgentsLine(results);
  if (installedLine) list.done("plugin", installedLine);
  else if (agents === "none") list.skip("plugin", "No coding-agent plugin selected");
  else list.fail("plugin", "No coding-agent plugin was installed");

  let labStarted = false;
  if (wantLab) {
    list.start("lab");
    labStarted = await startLocalModelLab(list, prompts, attention);
    if (labStarted) list.done("lab", "Local model lab: Orchestra 2B downloading in the background");
    else list.skip("lab", "Local model lab not started");
  }
  list.close();

  return {
    choice,
    signedIn,
    labStarted,
    attention,
    installed: results.filter((result) => result.status === "installed").map((result) => result.name),
  };
}

/**
 * Starts the managed MLX runtime install (needs uv; Homebrew is used only
 * after a yes) and the Orchestra 2B download as detached background jobs, and
 * records them in local-model-lab.json for the onboarding skill.
 */
async function startLocalModelLab(list: Checklist, prompts: InitPrompts, attention: AttentionItem[]): Promise<boolean> {
  const cli = [process.argv[1] ?? ""];
  const logDir = join(labDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const background = (args: string[], log: string) => {
    const fd = openSync(log, "a", 0o600);
    const child = spawn(process.execPath, [...cli, ...args], { detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return child.pid ?? null;
  };

  let uv = hasCommand("uv");
  if (!uv && hasCommand("brew")) {
    list.pause();
    if (await prompts.confirm("The MLX runtime needs uv. Install it with Homebrew (brew install uv)?")) {
      uv = spawnSync("brew", ["install", "uv"], { stdio: "inherit" }).status === 0;
    }
    list.resume();
  }
  let runtime: { log: string; pid: number | null } | null = null;
  if (uv) {
    const log = join(logDir, `mlx-runtime-${stamp}.log`);
    runtime = { log, pid: background(["models", "runtime", "install"], log) };
  } else {
    attention.push({
      message: "uv is not installed, so the MLX runtime was not set up. Install uv, then run:",
      fix: "brew install uv && orchestra models runtime install",
    });
  }
  const pullLog = join(logDir, `model-pull-${stamp}.log`);
  const pull = { log: pullLog, pid: background(["models", "pull", LOCAL_MODEL_ID], pullLog) };
  const stateDir = installStateDir();
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "local-model-lab.json"),
    `${JSON.stringify({ model: LOCAL_MODEL_ID, started_at: new Date().toISOString(), runtime, pull }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return true;
}
