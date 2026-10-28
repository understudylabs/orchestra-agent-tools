import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MIN_NODE, nodeUpdateHint, nodeVersionOk, nodeVersionProblem } from "../dist/node-version.js";

const INSTALL_SH = resolve("install.sh");

describe("Node version", () => {
  it("is the same minimum in package.json, the CLI and the installer", () => {
    const engines = JSON.parse(readFileSync("package.json", "utf8")).engines.node;
    assert.equal(engines, `>=${MIN_NODE}`);
    assert.match(readFileSync(INSTALL_SH, "utf8"), new RegExp(`^MIN_NODE="${MIN_NODE.replace(/\./g, "\\.")}"`, "m"));
  });

  it("compares versions part by part", () => {
    assert.equal(nodeVersionOk("22.19.0"), true);
    assert.equal(nodeVersionOk("v22.23.0"), true);
    assert.equal(nodeVersionOk("24.0.0"), true);
    assert.equal(nodeVersionOk("22.18.9"), false);
    assert.equal(nodeVersionOk("22.5.0"), false);
    assert.equal(nodeVersionOk("20.11.1"), false);
  });

  it("suggests the update for how Node was installed", () => {
    assert.match(nodeUpdateHint("/Users/me/.nvm/versions/node/v20.11.1/bin/node", {}, "darwin"), /^nvm install 22/);
    assert.match(nodeUpdateHint("/opt/homebrew/Cellar/node/20.1.0/bin/node", {}, "darwin"), /^brew upgrade node$/);
    assert.match(nodeUpdateHint("/home/me/.volta/tools/image/node/20/bin/node", {}, "linux"), /^volta install node@22$/);
    assert.match(nodeUpdateHint("/usr/local/bin/node", {}, "darwin"), /nodejs\.org.*brew install node/);
    assert.match(nodeUpdateHint("/usr/bin/node", {}, "linux"), /nodejs\.org\/en\/download/);
  });

  it("says nothing on a new enough Node and names version and fix otherwise", () => {
    assert.equal(nodeVersionProblem("22.19.0", "/usr/bin/node", {}, "linux"), null);
    const problem = nodeVersionProblem("20.11.1", "/Users/me/.nvm/versions/node/v20.11.1/bin/node", {}, "darwin");
    assert.match(problem, /needs Node 22\.19\.0 or newer; this is Node 20\.11\.1/);
    assert.match(problem, /Update: nvm install 22/);
  });

  it("stops the CLI with one message, not a stack trace, on an old Node", () => {
    // Fake the version before the entry point loads, as Node 20 would report it.
    const result = spawnSync(
      process.execPath,
      ["-e", 'Object.defineProperty(process.versions, "node", { value: "20.11.1" }); process.argv = [process.argv[0], "orchestra", "--version"]; import("./dist/bin.js")'],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^orchestra: Orchestra needs Node 22\.19\.0 or newer; this is Node 20\.11\.1\./);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  it("lists the prerequisites in orchestra doctor", () => {
    const result = spawnSync(process.execPath, ["dist/bin.js", "doctor"], { encoding: "utf8" });
    const report = JSON.parse(result.stdout);
    assert.equal(report.prerequisites.node.required, MIN_NODE);
    assert.equal(report.prerequisites.node.ok, true);
    assert.equal(typeof report.prerequisites.git, "boolean");
    assert.deepEqual(Object.keys(report.prerequisites.coding_agents), ["claude_code", "codex", "cursor"]);
  });
});

describe("install.sh prerequisites", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orchestra-prereqs-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function stub(dir, name, body) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
    return dir;
  }

  // A node that reports `version`, with npm beside it.
  function fakeNode(dir, version) {
    stub(dir, "node", `[ "$1" = -p ] && echo ${version}`);
    stub(dir, "npm", "exit 0");
    return dir;
  }

  function install(pathDirs, args = []) {
    const lab = join(root, "lab");
    const result = spawnSync("bash", [INSTALL_SH, "--lab", lab, ...args], {
      encoding: "utf8",
      input: "",
      // A new session has no terminal, so the installer cannot prompt even
      // when the tests run from one.
      detached: true,
      env: {
        HOME: join(root, "home"),
        PATH: [...pathDirs, "/usr/bin", "/bin"].join(":"),
        UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        BREW_CALLS: join(root, "brew-calls.txt"),
      },
    });
    return { ...result, lab };
  }

  const brewCalls = () => (existsSync(join(root, "brew-calls.txt")) ? readFileSync(join(root, "brew-calls.txt"), "utf8") : "");

  const systemHasNode = spawnSync("bash", ["-c", "command -v node"], { env: { PATH: "/usr/bin:/bin" } }).status === 0;

  it("stops before installing anything when Node is missing", { skip: systemHasNode && "/usr/bin has a node" }, () => {
    const result = install([]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /Before you install/);
    assert.match(result.stdout, /Node\.js is not installed\. Orchestra needs Node 22\.19\.0 or newer\./);
    assert.match(result.stdout, /Fix: install Node 22 from https:\/\/nodejs\.org/);
    assert.match(result.stdout, /Nothing was installed/);
    assert.equal(existsSync(result.lab), false);
  });

  it("names the version and the version-manager fix for an old Node", () => {
    const nvm = fakeNode(join(root, ".nvm", "versions", "node", "v20.11.1", "bin"), "20.11.1");
    const result = install([nvm]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /Node 20\.11\.1 is too old\. Orchestra needs Node 22\.19\.0 or newer\./);
    assert.match(result.stdout, /Fix: nvm install 22 && nvm alias default 22/);
    assert.equal(existsSync(result.lab), false);
  });

  it("reports every problem at once", () => {
    const bin = stub(join(root, "win"), "uname", "echo MINGW64_NT-10.0");
    const result = install([bin, fakeNode(join(root, "old"), "18.20.0")]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /runs on macOS and Linux; this is MINGW64_NT-10\.0/);
    assert.match(result.stdout, /Fix: On Windows, run the installer inside WSL/);
    assert.match(result.stdout, /Node 18\.20\.0 is too old/);
  });

  it("never installs Node for a script or --yes, only says how", () => {
    const brew = stub(join(root, "brew"), "brew", 'echo "brew $*" >> "$BREW_CALLS"');
    const old = fakeNode(join(root, "old"), "20.11.1");
    for (const args of [[], ["--yes"], ["--non-interactive"]]) {
      const result = install([old, brew], args);
      assert.equal(result.status, 1, `${args}: ${result.stdout}`);
      assert.match(result.stdout, /Node 20\.11\.1 is too old/);
    }
    assert.equal(brewCalls(), "");
  });

  // At a real terminal: the only place the Homebrew offer can appear.
  function installAtTerminal(pathDirs, args, answer) {
    const driver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execve("/bin/bash", ["bash"] + sys.argv[1:], os.environ.copy())
out = b""; answered = False; deadline = time.time() + 30
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if not ready:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not answered and b"[Y/n]" in out:
        os.write(fd, os.environ["ANSWER"].encode()); answered = True
    if b"Nothing was installed" in out or b"Turn AI spend" in out:
        break
try:
    os.kill(pid, 9)
except OSError:
    pass
sys.stdout.write(out.decode("utf-8", "replace"))
`;
    const result = spawnSync("python3", ["-c", driver, INSTALL_SH, "--lab", join(root, "lab"), ...args], {
      encoding: "utf8",
      env: {
        HOME: join(root, "home"),
        PATH: [...pathDirs, "/usr/bin", "/bin"].join(":"),
        TERM: "xterm-256color",
        UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        BREW_CALLS: join(root, "brew-calls.txt"),
        ANSWER: answer,
      },
      timeout: 45_000,
    });
    return { ...result, stdout: stripVTControlCharacters(result.stdout ?? "") };
  }

  const hasPty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;

  it("offers brew to a person at a terminal, and runs it only on yes", {
    skip: (!hasPty && "needs python3 with pty") || (systemHasNode && "/usr/bin has a node"),
  }, () => {
    const brew = stub(join(root, "brew"), "brew", 'echo "brew $*" >> "$BREW_CALLS"');

    const declined = installAtTerminal([brew], [], "n\r");
    assert.match(declined.stdout, /Run brew install node now\? \[Y\/n\]/);
    assert.match(declined.stdout, /Fix: brew install node/);
    assert.equal(brewCalls(), "");

    const yes = installAtTerminal([brew], ["--yes"], "\r");
    assert.doesNotMatch(yes.stdout, /\[Y\/n\]/);
    assert.equal(brewCalls(), "", "--yes must not install Node");

    installAtTerminal([brew], [], "\r");
    assert.equal(brewCalls(), "brew install node\n");
  });

  it("passes a new enough Node through", () => {
    const result = install([fakeNode(join(root, "new"), "22.19.0")], ["--only-step", "3", "--no-claude", "--non-interactive", "--agents", "claude-code"]);
    assert.doesNotMatch(result.stdout, /Before you install/);
  });
});
