import { statSync } from "node:fs";
import { resolve } from "node:path";

import kleur from "kleur";

import type { StartTarget } from "./agents.js";

export interface StartChoice {
  value: string;
  name: string;
  description: string;
}

/** Everything `runStart` touches outside itself, so tests can drive it. */
export interface StartDeps {
  cwd: string;
  home: string;
  targets: StartTarget[];
  prompt: string;
  choose(message: string, choices: StartChoice[]): Promise<string>;
  askFolder(message: string, fallback: string): Promise<string>;
  copy(text: string): boolean;
  openApp(app: string, folder?: string): boolean;
  run(command: string, args: string[], cwd: string): Promise<number>;
  print(line: string): void;
}

export interface StartResult {
  target: string;
  project: string;
  copied: boolean;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * "Where do you want to start?" — the last screen of `orchestra init` and the
 * whole of `orchestra start`. One question, then only the steps for the
 * answer: terminal agents start here with the prompt, desktop apps get the
 * prompt on the clipboard and are opened, anything else gets the prompt.
 */
export async function runStart(deps: StartDeps): Promise<StartResult> {
  let project = deps.cwd;
  if (resolve(project) === resolve(deps.home)) {
    deps.print(kleur.gray("You're in your home folder. Onboarding works best inside a project."));
    const answer = await deps.askFolder("Project folder (Enter to stay here):", deps.home);
    project = resolve(answer || deps.home);
  }

  const target = await deps.choose(
    "Where do you want to start?",
    deps.targets.map((candidate) => ({ value: candidate.id, name: candidate.label, description: candidate.hint })),
  );
  const chosen = deps.targets.find((candidate) => candidate.id === target);
  if (!chosen || chosen.kind === "later") {
    deps.print(`Run ${kleur.cyan("orchestra start")} any time to come back here.`);
    return { target: "later", project, copied: false };
  }

  if (chosen.kind === "terminal") {
    deps.print(kleur.gray(`Starting ${chosen.label} in ${project}…`));
    const status = await deps.run(chosen.command, chosen.args(deps.prompt), project);
    if (status !== 0) deps.print(kleur.yellow(`${chosen.label} exited with status ${status}.`));
    return { target: chosen.id, project, copied: false };
  }

  const copied = deps.copy(deps.prompt);
  deps.print(copied ? `${kleur.green("✓")} Prompt copied to your clipboard:` : "Copy this prompt:");
  deps.print(`    ${kleur.bold(deps.prompt)}`);
  if (chosen.kind === "app") {
    const opened = deps.openApp(chosen.app, chosen.opensFolder && isDirectory(project) ? project : undefined);
    if (!opened) deps.print(kleur.gray(`Open ${chosen.label} yourself, then:`));
  }
  deps.print(`In ${chosen.kind === "app" ? chosen.label : "your coding agent"}:`);
  chosen.steps(project).forEach((step, index) => deps.print(`  ${index + 1}. ${step}`));
  return { target: chosen.id, project, copied };
}
