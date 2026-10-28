import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { startTargets } from "../dist/onboarding/agents.js";
import { Checklist } from "../dist/onboarding/checklist.js";
import { installedAgentsLine, readAdapterResults, readAttention } from "../dist/onboarding/init.js";
import { onboardingPrompt } from "../dist/onboarding/prompt.js";
import { runStart } from "../dist/onboarding/start.js";

const probe = ({ platform = "darwin", commands = [], apps = [] } = {}) => ({
  platform,
  hasCommand: (name) => commands.includes(name),
  hasApp: (name) => apps.includes(name),
});

let root;

describe("onboarding start targets", () => {
  it("orders Claude Code first, then desktop apps, then the Codex CLI", () => {
    const targets = startTargets(probe({ commands: ["claude", "codex"], apps: ["Claude", "ChatGPT", "Cursor"] }));
    assert.deepEqual(
      targets.map((target) => [target.id, target.label]),
      [
        ["claude-code", "Claude Code"],
        ["claude-desktop", "Claude desktop"],
        ["codex-app", "ChatGPT · Codex"],
        ["cursor", "Cursor"],
        ["codex-cli", "Codex (terminal)"],
        ["other", "Another app"],
        ["later", "Later"],
      ],
    );
    const codex = targets.find((target) => target.id === "codex-app");
    assert.equal(codex.app, "ChatGPT");
    assert.match(codex.steps("/p")[0], /Switch to Codex/);
  });

  it("uses a pre-merge Codex.app and labels the CLI plainly without an app", () => {
    let targets = startTargets(probe({ apps: ["Codex"] }));
    assert.equal(targets.find((target) => target.id === "codex-app").app, "Codex");
    targets = startTargets(probe({ commands: ["codex"] }));
    assert.equal(targets.find((target) => target.id === "codex-cli").label, "Codex");
  });

  it("offers no desktop apps off macOS", () => {
    const targets = startTargets(probe({ platform: "linux", commands: ["claude"], apps: ["Claude", "ChatGPT", "Cursor"] }));
    assert.deepEqual(targets.map((target) => target.id), ["claude-code", "other", "later"]);
  });
});

describe("onboarding prompt", () => {
  it("matches the installer's handoff prompt", () => {
    const script = readFileSync("install.sh", "utf8");
    const base = onboardingPrompt({ signedIn: true, labStarted: false });
    assert.equal(base, "Use the Orchestra onboarding skill for this project.");
    assert.ok(script.includes(`INITIAL_CLAUDE_PROMPT="${base}"`));
    const signedOut = onboardingPrompt({ signedIn: false, labStarted: true }).slice(base.length);
    assert.ok(script.includes(signedOut.split(" The installer")[0].trim().replace(/`/g, "\\`")));
    assert.match(signedOut, /The installer started the local model lab in the background\.$/);
  });
});

describe("runStart", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orchestra-start-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function deps(overrides = {}) {
    const calls = { printed: [], ran: [], copied: [], opened: [], asked: [] };
    const value = {
      cwd: root,
      home: join(root, "home"),
      targets: startTargets(probe({ commands: ["claude", "codex"], apps: ["ChatGPT", "Cursor"] })),
      prompt: "Use the Orchestra onboarding skill for this project.",
      choose: async () => "claude-code",
      askFolder: async (message, fallback) => {
        calls.asked.push(message);
        return fallback;
      },
      copy: (text) => {
        calls.copied.push(text);
        return true;
      },
      openApp: (app, folder) => {
        calls.opened.push([app, folder]);
        return true;
      },
      run: async (command, args, cwd) => {
        calls.ran.push([command, args, cwd]);
        return 0;
      },
      print: (line) => calls.printed.push(line),
      ...overrides,
    };
    return { value, calls };
  }

  it("starts a terminal agent in the project with the prompt as its first message", async () => {
    const { value, calls } = deps();
    const result = await runStart(value);
    assert.equal(result.target, "claude-code");
    assert.deepEqual(calls.ran, [["claude", ["Use the Orchestra onboarding skill for this project."], root]]);
    assert.deepEqual(calls.copied, []);
  });

  it("copies the prompt, opens the app, and shows only that app's steps", async () => {
    const { value, calls } = deps({ choose: async () => "codex-app" });
    const result = await runStart(value);
    assert.equal(result.copied, true);
    assert.deepEqual(calls.copied, [value.prompt]);
    assert.deepEqual(calls.opened, [["ChatGPT", undefined]]);
    const text = calls.printed.join("\n");
    assert.match(text, /Switch to Codex/);
    assert.doesNotMatch(text, /Reload Window/);
    assert.deepEqual(calls.ran, []);
  });

  it("opens Cursor on the project folder", async () => {
    const { value, calls } = deps({ choose: async () => "cursor" });
    await runStart(value);
    assert.deepEqual(calls.opened, [["Cursor", root]]);
  });

  it("asks for a project folder when started from the home folder", async () => {
    const project = join(root, "app");
    mkdirSync(project);
    const { value, calls } = deps({ cwd: join(root, "home"), askFolder: async (message) => (calls.asked.push(message), project) });
    const result = await runStart(value);
    assert.equal(calls.asked.length, 1);
    assert.equal(result.project, project);
    assert.equal(calls.ran[0][2], project);
  });

  it("points at orchestra start for later", async () => {
    const { value, calls } = deps({ choose: async () => "later" });
    const result = await runStart(value);
    assert.equal(result.target, "later");
    assert.match(calls.printed.join("\n"), /orchestra start/);
    assert.deepEqual([calls.ran, calls.copied, calls.opened], [[], [], []]);
  });
});

describe("installer results for orchestra init", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orchestra-init-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads the agent results and attention items install.sh writes", () => {
    const home = join(root, "home");
    const skillRoot = join(home, ".config", "opencode", "skills");
    mkdirSync(join(skillRoot, "onboard"), { recursive: true });
    const lab = join(root, "lab");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--no-launch-agent", "--agents", "cursor,opencode", "--lab", lab],
      {
        cwd: process.cwd(),
        input: readFileSync("install.sh", "utf8"),
        encoding: "utf8",
        env: { ...process.env, CI: "1", UNDERSTUDY_INSTALL_FROM_CWD: "1", HOME: home, UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs") },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const stateDir = join(lab, "install-state");
    const results = readAdapterResults(stateDir);
    assert.deepEqual(
      results.filter((entry) => entry.status === "installed").map((entry) => entry.name),
      ["cursor", "opencode"],
    );
    assert.equal(installedAgentsLine(results), "Plugin installed: Cursor, OpenCode");
    const attention = readAttention(stateDir);
    assert.ok(attention.some((item) => /OpenCode support is deprecated/.test(item.message)));
    assert.ok(attention.some((item) => /1 OpenCode skills already exist/.test(item.message) && /mkdir -p/.test(item.fix)));
  });

  it("treats missing files as no results", () => {
    assert.deepEqual(readAdapterResults(root), []);
    assert.deepEqual(readAttention(root), []);
    assert.equal(installedAgentsLine([]), null);
    writeFileSync(join(root, "adapter-results.txt"), "codex|skipped|not selected or not detected\n");
    assert.equal(installedAgentsLine(readAdapterResults(root)), null);
  });
});

describe("Checklist", () => {
  it("prints one plain line per finished step without a TTY", () => {
    let text = "";
    const list = new Checklist(
      [
        { id: "cli", label: "Orchestra CLI 0.7.0" },
        { id: "signin", label: "Sign in" },
        { id: "plugin", label: "Plugin" },
      ],
      { write: (chunk) => (text += chunk), isTTY: false },
    );
    list.done("cli");
    list.start("signin");
    list.skip("signin", "Not signed in");
    list.fail("plugin", "No plugin installed");
    list.close();
    assert.equal(text.split("\n").filter(Boolean).length, 3);
    assert.match(text, /✓ Orchestra CLI 0\.7\.0/);
    assert.match(text, /– Not signed in/);
    assert.match(text, /✗ No plugin installed/);
  });

  it("redraws only the live steps and clears them for a prompt", () => {
    let text = "";
    const list = new Checklist(
      [
        { id: "cli", label: "Orchestra CLI" },
        { id: "signin", label: "Sign in" },
        { id: "plugin", label: "Plugin" },
      ],
      { write: (chunk) => (text += chunk), isTTY: true },
    );
    list.done("cli");
    assert.equal((text.match(/✓ Orchestra CLI/g) ?? []).length, 1);
    list.pause();
    assert.ok(text.endsWith("\x1b[2F\x1b[J"), JSON.stringify(text.slice(-20)));
    list.resume();
    list.done("signin");
    list.done("plugin");
    list.close();
    // Finished steps are written once each, never redrawn.
    assert.equal((text.match(/✓ Orchestra CLI/g) ?? []).length, 1);
    assert.equal((text.match(/✓ Sign in/g) ?? []).length, 1);
  });
});
