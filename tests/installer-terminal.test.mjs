import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

// These tests need a real terminal: the bug they guard against only shows up
// when a program is handed a terminal, not a pipe. Python's pty module gives
// one on macOS and Linux.
const hasPty = process.platform !== "win32" && spawnSync("python3", ["-c", "import pty"]).status === 0;
const INSTALL_SH = resolve("install.sh");

// Runs `bash -c <command>` on a fresh pseudo-terminal and returns its output.
function runInTerminal(command, env, timeoutSeconds = 60) {
  const driver = `
import os, pty, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execve("/bin/bash", ["bash", "-c", sys.argv[1]], os.environ.copy())
out = b""
deadline = time.time() + float(sys.argv[2])
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
os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
`;
  return spawnSync("python3", ["-c", driver, command, String(timeoutSeconds)], {
    encoding: "utf8",
    env,
    timeout: (timeoutSeconds + 10) * 1000,
  });
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

// A probe that reports how its stdin and stdout reach the terminal: through
// the real device, or through the /dev/tty alias that Bun programs such as
// Claude Code cannot use on macOS.
const PROBE = `
const fs = require("fs");
const alias = fs.statSync("/dev/tty").rdev;
const fds = [0, 1, 2].map((fd) => {
  const stat = fs.fstatSync(fd);
  return { fd, tty: require("tty").isatty(fd), alias: stat.rdev === alias };
});
fs.writeFileSync(process.env.PROBE_OUT, JSON.stringify({ argv: process.argv.slice(2), fds }));
`;

describe("install.sh terminal hand-off", { skip: !hasPty && "needs python3 with pty" }, () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orchestra-terminal-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // macOS bash 3.2 cannot `source <(...)`, so load the function with eval.
  const terminalDevice = `eval "$(sed -n '/^terminal_device() {/,/^}/p' ${JSON.stringify(INSTALL_SH)})"; terminal_device`;

  it("finds the terminal's real device instead of the /dev/tty alias", () => {
    const result = runInTerminal(`${terminalDevice}; [ -c "$(terminal_device)" ] && echo CHAR_DEVICE`, process.env, 15);
    assert.equal(result.status, 0, result.stderr);
    const device = result.stdout.split(/\r?\n/)[0].trim();
    assert.match(device, /^\/dev\/(ttys\d+|pts\/\d+)$/, result.stdout);
    assert.match(result.stdout, /CHAR_DEVICE/);
  });

  it("falls back to /dev/tty when there is no terminal", () => {
    const result = spawnSync("bash", ["-c", terminalDevice], { encoding: "utf8", detached: true, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.stdout.trim(), "/dev/tty", result.stderr);
  });

  it("never hands an interactive program the /dev/tty alias", () => {
    const script = readFileSync(INSTALL_SH, "utf8");
    assert.doesNotMatch(script, /<\/dev\/tty >\/dev\/tty 2>&1/);
    const commands = [/^\s*if orchestra login --email/, /^\s*codex "\$INITIAL_CLAUDE_PROMPT"/, /^\s*claude \$\{permission_args/, /^\s*exec "\$ORCHESTRA_BIN" init/];
    for (const launch of commands) {
      const line = script.split("\n").find((text) => launch.test(text));
      assert.ok(line, `missing launch ${launch}`);
      assert.match(line, /<"\$terminal" >"\$terminal" 2>&1/, line);
    }
  });

  it("gives orchestra init the real terminal device when curl | bash hands off", () => {
    const sandbox = join(root, "sb");
    const bin = join(sandbox, "bin");
    const prefix = join(sandbox, "prefix");
    const pkg = join(prefix, "lib", "node_modules", "@orchestraai", "agent-tools");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(sandbox, "home"), { recursive: true });
    mkdirSync(join(sandbox, "project"), { recursive: true });
    writeFileSync(join(sandbox, "probe.js"), PROBE);

    // npm: a registry that serves 0.8.0 and an install that drops in the stub CLI.
    writeExecutable(join(bin, "npm"), `#!/bin/bash
case "$*" in
  "root -g") echo "${prefix}/lib/node_modules" ;;
  "prefix -g") echo "${prefix}" ;;
  "view @orchestraai/agent-tools@latest version") echo 0.8.0 ;;
  "view @orchestraai/agent-tools@0.8.0 deprecated") ;;
  "view @orchestraai/agent-tools@0.8.0 bin --json") echo '{"orchestra":"dist/bin.js"}' ;;
  "install -g --ignore-scripts @orchestraai/agent-tools@0.8.0")
    mkdir -p "${pkg}" "${prefix}/bin"
    cp "${join(bin, "orchestra.stub")}" "${prefix}/bin/orchestra" ;;
  *) exit 1 ;;
esac
`);
    // orchestra: lists an init command, and init records how it got the terminal.
    writeExecutable(join(bin, "orchestra.stub"), `#!/bin/bash
case "$1" in
  --version) echo 0.8.0 ;;
  --help) printf 'Commands:\\n  init [options]  Guided setup\\n' ;;
  init) exec node "${join(sandbox, "probe.js")}" "$@" ;;
esac
`);

    const env = {
      HOME: join(sandbox, "home"),
      PATH: `${join(prefix, "bin")}:${bin}:${process.env.PATH}`,
      TERM: "xterm-256color",
      PROBE_OUT: join(sandbox, "probe.json"),
      UNDERSTUDY_INSTALL_LOG_DIR: join(sandbox, "logs"),
      DO_NOT_TRACK: "1",
    };
    const run = `cd ${JSON.stringify(join(sandbox, "project"))} && cat ${JSON.stringify(INSTALL_SH)} | bash -s -- --lab ${JSON.stringify(join(sandbox, "lab"))}`;
    const result = runInTerminal(run, env, 90);

    assert.ok(existsSync(env.PROBE_OUT), `orchestra init never ran:\n${result.stdout}\n${result.stderr}`);
    const probe = JSON.parse(readFileSync(env.PROBE_OUT, "utf8"));
    assert.deepEqual(probe.argv, ["init"]);
    for (const fd of probe.fds) {
      assert.equal(fd.tty, true, `fd ${fd.fd} is not a terminal`);
      assert.equal(fd.alias, false, `fd ${fd.fd} is the /dev/tty alias; Bun programs crash on it`);
    }
  });
});
