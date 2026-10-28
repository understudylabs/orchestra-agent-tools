import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Where a person can start onboarding. Terminal agents are started here with
 * the prompt as their first message; desktop apps cannot take one, so the
 * prompt is copied and the app is opened (or brought forward) instead.
 */
export type StartTarget =
  | {
      id: string;
      label: string;
      hint: string;
      kind: "terminal";
      command: string;
      /** Arguments that make the CLI open with `prompt` as its first message. */
      args: (prompt: string) => string[];
    }
  | {
      id: string;
      label: string;
      hint: string;
      kind: "app";
      /** macOS app name for `open -a`. */
      app: string;
      /** Whether `open -a <app> <folder>` opens the project (editors do). */
      opensFolder: boolean;
      steps: (project: string) => string[];
      /**
       * A link that opens a new chat in the project with the prompt already in
       * the composer, and the steps left after it opens.
       */
      link?: { url: (project: string, prompt: string) => string; steps: string[] };
    }
  | { id: "other"; label: string; hint: string; kind: "paste"; steps: (project: string) => string[] }
  | { id: "later"; label: string; hint: string; kind: "later" };

export interface AgentProbe {
  platform: NodeJS.Platform;
  /** True when an executable with this name is on PATH. */
  hasCommand(name: string): boolean;
  /** True when a macOS app bundle with this name is installed. */
  hasApp(name: string): boolean;
}

export function systemAgentProbe(env: NodeJS.ProcessEnv = process.env): AgentProbe {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  return {
    platform: process.platform,
    hasCommand: (name) => dirs.some((dir) => existsSync(join(dir, name))),
    hasApp: (name) =>
      [join("/Applications", `${name}.app`), join(homedir(), "Applications", `${name}.app`)].some((path) =>
        existsSync(path),
      ),
  };
}

/**
 * The start choices for this machine, most direct first: Claude Code in the
 * terminal, then the desktop apps, then the Codex CLI, then anything else.
 */
export function startTargets(probe: AgentProbe): StartTarget[] {
  const mac = probe.platform === "darwin";
  const targets: StartTarget[] = [];
  if (probe.hasCommand("claude")) {
    targets.push({
      id: "claude-code",
      label: "Claude Code",
      hint: "opens here with Orchestra ready",
      kind: "terminal",
      command: "claude",
      args: (prompt) => [prompt],
    });
  }
  if (mac && probe.hasApp("Claude")) {
    targets.push({
      id: "claude-desktop",
      label: "Claude desktop",
      hint: "copies the prompt and opens the app",
      kind: "app",
      app: "Claude",
      opensFolder: false,
      steps: (project) => [`Open Code and choose ${project}`, "Paste the prompt into a new session"],
    });
  }
  // The Codex desktop app became part of ChatGPT.app on 2026-07-09 (the
  // earlier chat-only app was renamed ChatGPT Classic); a Codex.app that
  // never took that update still works the same way.
  const codexApp = mac ? (probe.hasApp("ChatGPT") ? "ChatGPT" : probe.hasApp("Codex") ? "Codex" : null) : null;
  if (codexApp) {
    targets.push({
      id: "codex-app",
      label: codexApp === "ChatGPT" ? "ChatGPT · Codex" : "Codex",
      hint: "opens a new chat with the prompt",
      kind: "app",
      app: codexApp,
      opensFolder: false,
      steps: (project) => [
        ...(codexApp === "ChatGPT" ? ["Switch to Codex"] : []),
        "Enable orchestra under Plugins if you haven't yet",
        `Open ${project} and paste the prompt into a new thread`,
      ],
      // codex://new opens a new Codex chat in `path` with `prompt` in the
      // composer, unsent; ChatGPT.app keeps the scheme from the Codex app.
      link: {
        url: (project, prompt) =>
          `codex://new?path=${encodeURIComponent(project)}&prompt=${encodeURIComponent(prompt)}`,
        steps: ["Enable orchestra under Plugins if you haven't yet", "Press Enter in the new chat to send the prompt"],
      },
    });
  }
  if (mac && probe.hasApp("Cursor")) {
    targets.push({
      id: "cursor",
      label: "Cursor",
      hint: "copies the prompt and opens your project",
      kind: "app",
      app: "Cursor",
      opensFolder: true,
      steps: () => ["Run Developer: Reload Window", "Paste the prompt into a new Agent chat"],
    });
  }
  if (probe.hasCommand("codex")) {
    targets.push({
      id: "codex-cli",
      label: targets.some((target) => target.id === "codex-app") ? "Codex (terminal)" : "Codex",
      hint: "opens here with the prompt",
      kind: "terminal",
      command: "codex",
      args: (prompt) => [prompt],
    });
  }
  targets.push({
    id: "other",
    label: "Another app",
    hint: "copies the prompt",
    kind: "paste",
    steps: (project) => [`Open ${project} in your coding agent`, "Paste the prompt into a new chat"],
  });
  targets.push({ id: "later", label: "Later", hint: "run `orchestra start` any time", kind: "later" });
  return targets;
}
