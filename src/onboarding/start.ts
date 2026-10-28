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
  openUrl(url: string): boolean;
  run(command: string, args: string[], cwd: string): Promise<number>;
  print(line: string): void;
  /** Terminal width, for the prompt box. */
  columns?: number;
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
  const where = chosen.kind === "app" ? chosen.label : "your coding agent";
  let steps = chosen.steps(project);
  if (chosen.kind === "app") {
    const folder = isDirectory(project) ? project : undefined;
    if (chosen.link && folder && deps.openUrl(chosen.link.url(folder, deps.prompt))) {
      deps.print(`${kleur.green("✓")} Opened a new ${chosen.label} chat in ${folder} with the prompt filled in.`);
      steps = chosen.link.steps;
    } else if (!deps.openApp(chosen.app, chosen.opensFolder ? folder : undefined)) {
      deps.print(kleur.gray(`Open ${chosen.label} yourself.`));
    }
  }
  promptBox(deps.prompt, copied ? "Prompt · copied to your clipboard" : "Prompt · copy this", deps.columns).forEach((line) =>
    deps.print(line),
  );
  deps.print(`In ${where}:`);
  steps.forEach((step, index) => deps.print(`  ${index + 1}. ${step}`));
  return { target: chosen.id, project, copied };
}

/** Breaks `text` into lines of at most `width` characters, at spaces where it can. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest; ) {
      const room = line ? width - line.length - 1 : width;
      if (rest.length <= room) {
        line = line ? `${line} ${rest}` : rest;
        rest = "";
      } else if (line) {
        lines.push(line);
        line = "";
      } else {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The prompt in a box, so it stands apart from the steps. The clipboard is the
 * main way to copy it; the box is what to select when the copy failed.
 */
export function promptBox(prompt: string, title: string, columns?: number): string[] {
  // A terminal without a size reports 0 columns.
  const inner = Math.max(20, Math.min(76, (columns || 80) - 8));
  const lines = wrap(prompt, inner);
  const width = Math.max(title.length + 2, ...lines.map((line) => line.length));
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, width - title.length - 1))}╮`;
  return [
    kleur.gray(top),
    ...lines.map((line) => `${kleur.gray("│")} ${kleur.bold(line.padEnd(width))} ${kleur.gray("│")}`),
    kleur.gray(`╰${"─".repeat(width + 2)}╯`),
  ];
}
