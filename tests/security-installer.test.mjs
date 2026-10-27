import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

let root;

// A fake `npm` whose global root is an empty directory, so the installed
// package is never found and nothing on this machine leaks into the run.
function stubNpm(bin, npmRoot) {
  mkdirSync(bin, { recursive: true });
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(
    join(bin, "npm"),
    `#!/usr/bin/env bash\nif [[ "$*" == "root -g" ]]; then printf '%s\\n' "${npmRoot}"; exit 0; fi\nif [[ "$*" == "prefix -g" ]]; then printf '%s\\n' "${npmRoot}"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(join(bin, "npm"), 0o755);
}

function runInstaller(args, options) {
  const script = readFileSync("install.sh", "utf8");
  return spawnSync("bash", ["-s", "--", "--non-interactive", ...args], {
    cwd: process.cwd(),
    input: script,
    encoding: "utf8",
    ...options,
  });
}

// Mirrors hermes_yaml_python under the fake HOME the installer runs with:
// macOS's python3 only sees PyYAML through the real user's site-packages.
function hasYamlPython(home) {
  return ["python3", "python"].some(
    (py) => spawnSync(py, ["-c", "import yaml"], { stdio: "ignore", env: { ...process.env, HOME: home } }).status === 0,
  );
}

describe("install.sh security", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "understudy-installer-sec-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not install skills from the current directory unless opted in", () => {
    const home = join(root, "home");
    const bin = join(root, "bin");
    const project = join(root, "project");
    stubNpm(bin, join(root, "npm-root"));
    mkdirSync(join(project, "skills", "understudy"), { recursive: true });
    writeFileSync(join(project, "skills", "understudy", "SKILL.md"), "# planted\n");
    const args = ["--only-step", "2", "--agents", "opencode", "--no-launch-agent", "--lab", join(root, "lab")];
    const env = {
      ...process.env,
      CI: "1",
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
    };

    const planted = runInstaller(args, { cwd: project, env });
    assert.equal(planted.status, 3, planted.stderr || planted.stdout);
    assert.match(planted.stdout, /skills\/understudy\/SKILL\.md was not found/);
    assert.equal(existsSync(join(home, ".config", "opencode", "skills", "understudy")), false);

    const optedIn = runInstaller(args, { cwd: project, env: { ...env, UNDERSTUDY_INSTALL_FROM_CWD: "1" } });
    assert.equal(optedIn.status, 0, optedIn.stderr || optedIn.stdout);
    // bash reports the physical cwd, so compare resolved paths.
    assert.equal(
      readlinkSync(join(home, ".config", "opencode", "skills", "understudy")),
      realpathSync(join(project, "skills", "understudy")),
    );
  });

  it("refuses to delete a scratch checkout it did not create", () => {
    const home = join(root, "home");
    const bin = join(root, "bin");
    const checkout = join(root, "my-checkout");
    stubNpm(bin, join(root, "npm-root"));
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "work.txt"), "uncommitted\n");
    const args = ["--only-step", "1", "--no-agents", "--lab", join(root, "lab")];
    const env = {
      ...process.env,
      CI: "1",
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
    };

    const existing = runInstaller(args, { env: { ...env, UNDERSTUDY_INSTALL_SOURCE_DIR: checkout } });
    assert.equal(existing.status, 2, existing.stderr || existing.stdout);
    assert.match(existing.stdout, /was not created by this installer/);
    assert.equal(readFileSync(join(checkout, "work.txt"), "utf8"), "uncommitted\n");

    const asHome = runInstaller(args, { env: { ...env, UNDERSTUDY_INSTALL_SOURCE_DIR: home } });
    assert.equal(asHome.status, 2, asHome.stderr || asHome.stdout);
    assert.match(asHome.stdout, /Refusing to use .* as the scratch checkout/);
  });

  it("refuses an unowned default checkout and normalized home aliases", () => {
    const home = join(root, "home");
    const lab = join(root, "lab");
    const checkout = join(lab, "source", "orchestra-agent-tools");
    const bin = join(root, "bin");
    stubNpm(bin, join(root, "npm-root"));
    mkdirSync(checkout, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(checkout, "work.txt"), "keep me");
    const env = { ...process.env, CI: "1", HOME: home, PATH: `${bin}:${process.env.PATH}`, UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs") };
    const args = ["--only-step", "1", "--no-agents", "--lab", lab];
    const result = runInstaller(args, { env });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(readFileSync(join(checkout, "work.txt"), "utf8"), "keep me");
    // Even a marker must not authorize deleting HOME via dot segments.
    writeFileSync(join(home, ".understudy-installer-checkout"), "");
    const alias = runInstaller(args, { env: { ...env, UNDERSTUDY_INSTALL_SOURCE_DIR: `${home}/child/..` } });
    assert.equal(alias.status, 2, alias.stdout + alias.stderr);
    assert.equal(existsSync(home), true);
  });

  it("propagates failed noninteractive commands and stops later steps", () => {
    const script = readFileSync("install.sh", "utf8");
    const fn = script.slice(script.indexOf("run_logged() {"), script.indexOf("need() {"));
    const result = spawnSync("bash", ["-c", `set -e
FANCY=0
LOG_FILE="$1"
log() { :; }
redact_url() { printf '%s' "$*"; }
fail_line() { :; }
say() { :; }
${fn}
run_logged fail bash -c 'exit 23'
printf 'should not run'
`, "test", join(root, "failure.log")], { encoding: "utf8" });
    assert.equal(result.status, 23, result.stderr);
    assert.doesNotMatch(result.stdout, /should not run/);
  });

  it("requires an exact full commit pin", () => {
    const script = readFileSync("install.sh", "utf8");
    const start = script.indexOf('  if [ -n "$INSTALL_COMMIT" ]; then', script.indexOf("install_understudy_package()"));
    const block = script.slice(start, script.indexOf('  private_mkdir "$STATE_DIR"', start));
    const sha = "abcdef0123".repeat(4);
    for (const [pin, status] of [[sha, 0], [sha.toUpperCase(), 0], [sha.slice(0, 8), 1], ["0".repeat(40), 1]]) {
      const result = spawnSync("bash", ["-c", `package_commit="$1"; INSTALL_COMMIT="$2"; ok() { :; }; fail_line() { :; }; ${block}`, "test", sha, pin], { encoding: "utf8" });
      assert.equal(result.status, status, result.stderr);
    }
  });

  it("packs bundled runtime dependencies for an offline install", () => {
    const fixture = join(root, "package");
    const dependency = join(fixture, "node_modules", "synthetic-runtime-dep");
    const installed = join(root, "installed");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "synthetic-installer-fixture", version: "1.0.0", files: ["index.js"], dependencies: { "synthetic-runtime-dep": "^1.0.0" } }));
    writeFileSync(join(fixture, "index.js"), 'module.exports = require("synthetic-runtime-dep");');
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "synthetic-runtime-dep", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(dependency, "index.js"), 'module.exports = "locked runtime";');
    const script = readFileSync("install.sh", "utf8");
    const start = script.indexOf('  runtime_deps="$(node -p');
    const block = script.slice(start, script.indexOf('  # Only now', start));
    const packed = spawnSync("bash", ["-c", `set -e
INSTALL_SOURCE_DIR="$1"
STATE_DIR="$2"
run_logged() { shift; "$@"; }
${block}`, "test", fixture, root], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(root, "synthetic-installer-fixture-1.0.0.tgz");
    const result = spawnSync("npm", ["install", "--prefix", installed, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { encoding: "utf8", env: { ...process.env, npm_config_cache: join(root, "empty-cache") } });
    assert.equal(result.status, 0, result.stderr);
    const loaded = spawnSync(process.execPath, ["-e", 'console.log(require(process.argv[1]))', join(installed, "node_modules", "synthetic-installer-fixture")], { encoding: "utf8" });
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout.trim(), "locked runtime");
  });

  it("keeps install state and logs private and under --lab", () => {
    const home = join(root, "home");
    const lab = join(root, "lab");
    const logDir = join(root, "logs");
    const result = runInstaller(["--only-step", "3", "--no-claude", "--agents", "none", "--lab", lab], {
      env: { ...process.env, CI: "1", HOME: home, UNDERSTUDY_INSTALL_LOG_DIR: logDir },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(lab, "install-state", "step-3.done")), true);
    assert.equal(existsSync(join(home, ".understudy", "agent-tools")), false);
    assert.equal(statSync(logDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(lab, "install-state")).mode & 0o777, 0o700);
    const logs = readdirSync(logDir).filter((name) => name.startsWith("install-"));
    assert.equal(logs.length, 1);
    assert.equal(statSync(join(logDir, logs[0])).mode & 0o777, 0o600);
  });

  it("keeps a single credentials backup and does not reset again on --resume", () => {
    const home = join(root, "home");
    const lab = join(root, "lab");
    const understudyDir = join(home, ".understudy");
    const credentials = `${JSON.stringify({ api_key: "sk_demo", email: "demo@example.com", orgs: {} })}\n`;
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(join(understudyDir, "credentials.json"), credentials);
    writeFileSync(join(understudyDir, "credentials.json.bak-20240101T000000Z"), '{"api_key":"sk_old"}\n');
    const env = { ...process.env, CI: "1", HOME: home, UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs") };

    const reset = runInstaller(["--fresh-login", "--from-step", "3", "--no-claude", "--agents", "none", "--lab", lab], { env });
    assert.equal(reset.status, 0, reset.stderr || reset.stdout);
    assert.match(reset.stdout, /Signed out demo@example\.com/);
    const backups = readdirSync(understudyDir).filter((name) => name.startsWith("credentials.json.bak-"));
    assert.equal(backups.length, 1);
    assert.notEqual(backups[0], "credentials.json.bak-20240101T000000Z");
    assert.equal(existsSync(join(lab, "install-state", "login-reset.done")), true);

    // The agent signed the user back in; a --resume retry must not sign out again.
    writeFileSync(join(understudyDir, "credentials.json"), credentials);
    writeFileSync(join(lab, "install-state", "last-step"), "2\n");
    const resumed = runInstaller(["--fresh-login", "--resume", "--no-claude", "--agents", "none", "--lab", lab], { env });
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.match(resumed.stdout, /already reset earlier in this install/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), true);
    assert.equal(readdirSync(understudyDir).filter((name) => name.startsWith("credentials.json.bak-")).length, 1);
  });

  it("leaves an already registered Hermes config untouched", () => {
    const home = join(root, "home");
    const hermesHome = join(home, ".hermes");
    const config = join(hermesHome, "config.yaml");
    const stableLink = join(home, ".understudy", "skills");
    const original = `# my hermes config\nmodel: demo\nskills:\n  external_dirs:\n    - ${stableLink}\n`;
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(config, original);

    const result = runInstaller(["--only-step", "2", "--agents", "hermes", "--no-launch-agent", "--lab", join(root, "lab")], {
      env: {
        ...process.env,
        CI: "1",
        HOME: home,
        HERMES_HOME: hermesHome,
        UNDERSTUDY_INSTALL_FROM_CWD: "1",
        UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /already registered in .*config\.yaml/);
    assert.equal(readFileSync(config, "utf8"), original);
    assert.equal(readdirSync(hermesHome).some((name) => name.includes("understudy.bak")), false);
  });

  it("registers Hermes skills when the path only appears in a YAML comment", (t) => {
    const home = join(root, "home");
    const hermesHome = join(home, ".hermes");
    const config = join(hermesHome, "config.yaml");
    const stableLink = join(home, ".understudy", "skills");
    const original = `# previously: - ${stableLink}\nmodel: demo\n`;
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(config, original);
    if (!hasYamlPython(home)) {
      // Without PyYAML the installer falls back to the substring check by design.
      t.skip("no YAML-capable Python for this HOME");
      return;
    }

    const result = runInstaller(["--only-step", "2", "--agents", "hermes", "--no-launch-agent", "--lab", join(root, "lab")], {
      env: {
        ...process.env,
        CI: "1",
        HOME: home,
        HERMES_HOME: hermesHome,
        UNDERSTUDY_INSTALL_FROM_CWD: "1",
        UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Registered Orchestra skills in .*config\.yaml/);
    assert.match(readFileSync(config, "utf8"), /external_dirs/);
    assert.equal(readFileSync(`${config}.understudy.bak`, "utf8"), original);
  });

  it("does not glob-expand the adapter list and redacts credentials in source URLs", () => {
    const home = join(root, "home");
    const env = { ...process.env, CI: "1", HOME: home, UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs") };

    const glob = runInstaller(["--only-step", "2", "--agents", "*", "--lab", join(root, "lab")], { env });
    assert.equal(glob.status, 2);
    assert.match(glob.stdout, /Unknown agent adapter '\*'/);

    const redacted = runInstaller(["--only-step", "3", "--no-claude", "--agents", "none", "--lab", join(root, "lab")], {
      env: { ...env, UNDERSTUDY_INSTALL_PACKAGE: "https://x-access-token:s3cret@example.invalid/understudy.tgz" },
    });
    assert.equal(redacted.status, 0, redacted.stderr || redacted.stdout);
    assert.match(redacted.stdout, /Source: npm package https:\/\/<redacted>@example\.invalid\/understudy\.tgz/);
    assert.doesNotMatch(redacted.stdout, /s3cret/);
    const logs = readdirSync(join(root, "logs")).filter((name) => name.startsWith("install-"));
    assert.doesNotMatch(readFileSync(join(root, "logs", logs[0]), "utf8"), /s3cret/);
  });
});
