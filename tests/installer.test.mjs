import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, it } from "node:test";

let root;

describe("install.sh", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "understudy-installer-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the curl installer off the desktop and development dependency paths", () => {
    const script = readFileSync("install.sh", "utf8");
    assert.match(script, /git clone --depth 1 --filter=blob:none --sparse/);
    assert.match(script, /sparse-checkout set/);
    assert.doesNotMatch(script, /sparse-checkout set[^\n]*apps\/homescreen/);
    assert.match(script, /npm ci --prefix "\$INSTALL_SOURCE_DIR" --omit=dev --ignore-scripts/);
    assert.match(script, /tsconfig\.install\.json/);
    assert.match(script, /npm pkg delete scripts\.prepare --prefix "\$INSTALL_SOURCE_DIR"/);
    assert.match(script, /npm pack \. --ignore-scripts/);
    // npm pack drops package-lock.json, so the runtime dependencies installed
    // from the lockfile must be bundled into the tarball before it is packed.
    assert.match(script, /npm pkg set --prefix "\$INSTALL_SOURCE_DIR" --json bundleDependencies=/);
    assert.ok(script.indexOf("--json bundleDependencies=") < script.indexOf("npm pack . --ignore-scripts"));
  });

  it("runs from a pipe when noninteractive mode is explicit", () => {
    const script = readFileSync("install.sh", "utf8");
    const lab = join(root, "lab");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
        "--lab",
        lab,
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Running non-interactively/);
    assert.match(result.stdout, /Skipping coding-agent launch because --no-claude is set/);
  });

  it("lets require-confirm override noninteractive mode", () => {
    const script = readFileSync("install.sh", "utf8");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--require-confirm",
        "--only-step",
        "3",
        "--no-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stdout, /Confirmation is required/);
  });

  it("signs out an existing sign-in with --fresh-login, preserving everything else", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(
      join(understudyDir, "credentials.json"),
      `${JSON.stringify({ api_key: "sk_demo", gateway_url: "https://api.understudylabs.com", email: "demo@example.com", orgs: {} })}\n`,
    );
    writeFileSync(join(understudyDir, "profile.json"), '{"keep":"me"}\n');
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--fresh-login",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Signed out demo@example\.com/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), false);
    const backups = readdirSync(understudyDir).filter((name) => name.startsWith("credentials.json.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(understudyDir, "profile.json"), "utf8"), '{"keep":"me"}\n');
  });

  it("does not reuse a GitHub noreply email from existing credentials", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(
      join(understudyDir, "credentials.json"),
      `${JSON.stringify({
        api_key: "sk_demo",
        gateway_url: "https://api.understudylabs.com",
        email: "166242911+lluisinthedesert@users.noreply.github.com",
        orgs: {},
      })}\n`,
    );

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--fresh-login",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "none",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Ignoring GitHub noreply email from existing Orchestra credentials/);
    assert.match(result.stdout, /Signed out the existing Orchestra sign-in/);
    assert.doesNotMatch(result.stdout, /users\.noreply\.github\.com/);
  });

  it("does not seed the launch prompt from a GitHub noreply git email", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".gitconfig"),
      "[user]\n\temail = 166242911+lluisinthedesert@users.noreply.github.com\n",
    );

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "none",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Ignoring GitHub noreply email from git config user\.email/);
    assert.doesNotMatch(result.stdout, /users\.noreply\.github\.com/);
  });

  it("keeps the sign-in with --keep-login", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(
      join(understudyDir, "credentials.json"),
      `${JSON.stringify({ api_key: "sk_demo", gateway_url: "https://api.understudylabs.com", email: "demo@example.com", orgs: {} })}\n`,
    );
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--keep-login",
        "--from-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Already signed in as demo@example\.com; keeping that sign-in/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), true);
  });

  it("leaves login state alone when running a single step", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const understudyDir = join(home, ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(join(understudyDir, "credentials.json"), '{"api_key":"sk_demo","orgs":{}}\n');
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--no-claude",
        "--agents",
        "claude-code",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), true);
  });

  it("installs the Cursor adapter when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "cursor",
        "--no-launch-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          // The piped installer only trusts the installed package; the tests
          // install the adapters from this checkout, which needs the opt-in.
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Orchestra Cursor plugin linked/);
    assert.equal(existsSync(join(home, ".cursor", "plugins", "local", "orchestra")), true);
  });

  it("does not overwrite an existing Cursor plugin path", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const dest = join(home, ".cursor", "plugins", "local", "orchestra");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "marker.txt"), "keep me\n");

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "cursor",
        "--no-launch-agent",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    // The path is preserved, but an explicitly requested adapter that ends up
    // not installed is no longer a silent success: exit 3 with a loud warning.
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Cursor plugin path already exists/);
    assert.match(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.match(result.stdout, /adapter installation was incomplete/);
    assert.equal(readFileSync(join(dest, "marker.txt"), "utf8"), "keep me\n");
  });

  it("registers the Codex marketplace when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "codex-calls.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "codex",
        "--no-launch-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Orchestra Codex marketplace registered/);
    assert.match(readFileSync(calls, "utf8"), /plugin marketplace add /);
  });

  it("resolves the npm package symlink before registering the Codex marketplace", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const npmRoot = join(root, "npm-root");
    const packageLink = join(npmRoot, "@orchestraai", "agent-tools");
    const calls = join(root, "codex-realpath-calls.txt");
    mkdirSync(dirname(packageLink), { recursive: true });
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.cwd(), packageLink, "dir");
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env bash\nif [[ "$*" == "root -g" ]]; then printf '%s\\n' "${npmRoot}"; exit 0; fi\nexit 1\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "codex",
        "--no-launch-agent",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const callsText = readFileSync(calls, "utf8");
    assert.ok(callsText.includes(`plugin marketplace add ${process.cwd()}`));
    assert.equal(callsText.includes(packageLink), false);
  });

  it("links the OpenCode skills when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "opencode",
        "--no-launch-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Orchestra OpenCode skills linked/);
    assert.equal(existsSync(join(home, ".config", "opencode", "skills", "understudy", "SKILL.md")), true);
    assert.match(
      readlinkSync(join(home, ".config", "opencode", "skills", "understudy")),
      /skills\/understudy$/,
    );
    assert.equal(existsSync(join(home, ".config", "opencode", "commands", "orchestra-onboard.md")), true);
  });

  it("hands off to OpenCode without auto-launching it", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "opencode"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--agents",
        "opencode",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OpenCode skills and commands are installed/);
    assert.match(result.stdout, /Open a fresh OpenCode TUI session/);
    assert.match(result.stdout, /Then run \/orchestra-onboard/);
    assert.doesNotMatch(result.stdout, /OpenCode exited with status/);
  });

  it("hands off to detected OpenCode in auto mode even when Claude Code is disabled", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "opencode"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--no-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OpenCode skills and commands are installed/);
    assert.match(result.stdout, /Open a fresh OpenCode TUI session/);
    assert.doesNotMatch(result.stdout, /no other launchable adapter is available/);
  });

  it("registers the Hermes skills tree through a stable symlink when explicitly requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const hermesHome = join(home, ".hermes");
    const config = join(hermesHome, "config.yaml");
    const stableLink = join(home, ".understudy", "skills");
    const realSkills = join(process.cwd(), "skills");
    const env = {
      ...process.env,
      CI: "1",
      UNDERSTUDY_INSTALL_FROM_CWD: "1",
      HOME: home,
      HERMES_HOME: hermesHome,
      UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
    };
    const args = [
      "-s",
      "--",
      "--non-interactive",
      "--only-step",
      "2",
      "--agents",
      "hermes",
      "--no-launch-claude",
      "--lab",
      join(root, "lab"),
    ];

    const first = spawnSync("bash", args, { cwd: process.cwd(), input: script, encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.match(first.stdout, /registered Orchestra skills in skills\.external_dirs/);
    // A durable ~/.understudy/skills symlink points at the resolved skills tree.
    assert.equal(readlinkSync(stableLink), realSkills);
    // The config registers the stable symlink path, not the resolved checkout path.
    assert.equal(existsSync(config), true);
    const written = readFileSync(config, "utf8");
    assert.match(written, /external_dirs/);
    assert.ok(written.includes(stableLink), `expected ${config} to list ${stableLink}`);

    // A second run is idempotent: the path is already present, so nothing changes.
    const second = spawnSync("bash", args, { cwd: process.cwd(), input: script, encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.match(second.stdout, /already registered in .*config\.yaml/);
    const after = readFileSync(config, "utf8");
    assert.equal((after.match(new RegExp(stableLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 1);
  });

  it("autodetects available agent adapters by default", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "agent-calls.txt");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\nif [ "$*" = "plugin list --json" ]; then printf '[]\\n'; fi\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf 'codex %s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "opencode"),
      `#!/usr/bin/env bash\nprintf 'opencode %s\\n' "$*" >> "${calls}"\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);
    chmodSync(join(bin, "opencode"), 0o755);

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--no-launch-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          // Isolate from any real ~/.hermes so autodetection never edits it.
          HERMES_HOME: join(home, ".hermes"),
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Orchestra plugin installed/);
    assert.match(result.stdout, /Orchestra Cursor plugin linked/);
    assert.match(result.stdout, /Orchestra Codex marketplace registered/);
    assert.match(result.stdout, /Orchestra OpenCode skills linked/);
    const callsText = readFileSync(calls, "utf8");
    assert.match(callsText, /claude plugin marketplace add /);
    assert.match(callsText, /claude plugin install orchestra@orchestra-skills/);
    assert.match(callsText, /codex plugin marketplace add /);
  });

  it("replaces pre-rename understudy plugin installs with orchestra", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "agent-calls.txt");
    const oldCheckout = join(root, "old", "understudy-agent-tools");
    mkdirSync(join(home, ".cursor", "plugins", "local"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode", "commands"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    symlinkSync(oldCheckout, join(home, ".cursor", "plugins", "local", "understudy"));
    symlinkSync(
      join(oldCheckout, ".opencode", "commands", "understudy-onboard.md"),
      join(home, ".config", "opencode", "commands", "understudy-onboard.md"),
    );
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\ncase "$*" in\n  "plugin list --json") printf '[{"id":"understudy@understudy-skills"}]\\n' ;;\n  "plugin marketplace list") printf 'understudy-skills\\n' ;;\nesac\nexit 0\n`,
    );
    writeFileSync(join(bin, "codex"), `#!/usr/bin/env bash\nprintf 'codex %s\\n' "$*" >> "${calls}"\nexit 0\n`);
    writeFileSync(join(bin, "opencode"), `#!/usr/bin/env bash\nexit 0\n`);
    for (const name of ["claude", "codex", "opencode"]) chmodSync(join(bin, name), 0o755);

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--no-launch-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          HERMES_HOME: join(home, ".hermes"),
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Removed the old understudy plugin/);
    const callsText = readFileSync(calls, "utf8");
    assert.match(callsText, /claude plugin uninstall understudy@understudy-skills/);
    assert.match(callsText, /claude plugin marketplace remove understudy-skills/);
    assert.match(callsText, /claude plugin install orchestra@orchestra-skills/);
    assert.match(callsText, /codex plugin marketplace remove understudy-skills/);
    // lstat, not existsSync: the old links point at a checkout that no longer exists.
    assert.throws(() => lstatSync(join(home, ".cursor", "plugins", "local", "understudy")), { code: "ENOENT" });
    assert.equal(lstatSync(join(home, ".cursor", "plugins", "local", "orchestra")).isSymbolicLink(), true);
    assert.throws(() => lstatSync(join(home, ".config", "opencode", "commands", "understudy-onboard.md")), { code: "ENOENT" });
    assert.equal(
      lstatSync(join(home, ".config", "opencode", "commands", "orchestra-onboard.md")).isSymbolicLink(),
      true,
    );
  });

  it("moves Claude and Codex marketplaces left at an earlier package folder", () => {
    const script = readFileSync("install.sh", "utf8");
    const earlier = [
      join(root, "npm-root", "@understudylabs", "understudy-agent-tools"),
      join(root, "npm-root", "orchestra-agent-tools"),
    ];
    for (const [index, oldPackage] of earlier.entries()) {
    const home = join(root, `home-${index}`);
    const bin = join(root, `bin-${index}`);
    const calls = join(root, `agent-calls-${index}.txt`);
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const claudeList = JSON.stringify([{ name: "orchestra-skills", source: "directory", path: oldPackage }]);
    const codexList = JSON.stringify({ marketplaces: [{ name: "orchestra-skills", root: oldPackage }] });
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\ncase "$*" in\n  "plugin list --json") [ -e "${calls}.uninstalled" ] && printf '[]\\n' || printf '[{"id":"orchestra@orchestra-skills"}]\\n' ;;\n  "plugin uninstall orchestra@orchestra-skills") : > "${calls}.uninstalled" ;;\n  "plugin marketplace list --json") printf '%s\\n' '${claudeList}' ;;\nesac\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf 'codex %s\\n' "$*" >> "${calls}"\ncase "$*" in\n  "plugin marketplace list --json") printf '%s\\n' '${codexList}' ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "claude-code,codex", "--no-launch-agent", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          HERMES_HOME: join(home, ".hermes"),
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes(`Moving the Orchestra Claude Code plugin from ${oldPackage}.`), result.stdout);
    const callsText = readFileSync(calls, "utf8");
    assert.match(callsText, /claude plugin uninstall orchestra@orchestra-skills/);
    assert.match(callsText, /claude plugin marketplace remove orchestra-skills/);
    assert.match(callsText, /claude plugin marketplace add /);
    assert.match(callsText, /codex plugin marketplace remove orchestra-skills/);
    assert.match(callsText, /codex plugin marketplace add /);
    }
  });

  it("leaves Claude and Codex marketplaces that are current or not Orchestra's", () => {
    const script = readFileSync("install.sh", "utf8");
    const foreign = join(root, "elsewhere", "my-skills");
    // Each run pairs one adapter already at this checkout with one whose
    // orchestra-skills marketplace is someone else's folder.
    for (const [index, [claudePath, codexRoot]] of [[process.cwd(), foreign], [foreign, realpathSync(process.cwd())]].entries()) {
    const home = join(root, `home-${index}`);
    const bin = join(root, `bin-${index}`);
    const calls = join(root, `agent-calls-${index}.txt`);
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const claudeList = JSON.stringify([{ name: "orchestra-skills", source: "directory", path: claudePath }]);
    const codexList = JSON.stringify({ marketplaces: [{ name: "orchestra-skills", root: codexRoot }] });
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\ncase "$*" in\n  "plugin list --json") printf '[{"id":"orchestra@orchestra-skills"}]\\n' ;;\n  "plugin marketplace list --json") printf '%s\\n' '${claudeList}' ;;\nesac\nexit 0\n`,
    );
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf 'codex %s\\n' "$*" >> "${calls}"\ncase "$*" in\n  "plugin marketplace list --json") printf '%s\\n' '${codexList}' ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "claude-code,codex", "--no-launch-agent", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          HERMES_HOME: join(home, ".hermes"),
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Orchestra plugin already appears installed/);
    const callsText = readFileSync(calls, "utf8");
    assert.doesNotMatch(callsText, /plugin uninstall orchestra@orchestra-skills/);
    assert.doesNotMatch(callsText, /marketplace remove orchestra-skills/);
    }
  });

  it("removes earlier global packages and their commands but not a user's own", () => {
    const script = readFileSync("install.sh", "utf8");
    const start = script.indexOf("remove_previous_global_package() {");
    const fn = script.slice(start, script.indexOf("\n}\n", start) + 3);
    const npmRoot = join(root, "prefix", "lib", "node_modules");
    const prefixBin = join(root, "prefix", "bin");
    // The current scoped folder (a reinstall) plus both earlier names.
    const installs = [
      join(npmRoot, "@orchestraai", "agent-tools"),
      join(npmRoot, "orchestra-agent-tools"),
      join(npmRoot, "@understudylabs", "understudy-agent-tools"),
    ];
    const home = join(root, "home");
    const bin = join(root, "bin");
    for (const dir of installs) {
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "bin.js"), "");
    }
    mkdirSync(prefixBin, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    // Bins can belong to any earlier install; each must be recognized as ours.
    symlinkSync(join(installs[2], "dist", "bin.js"), join(prefixBin, "understudy"));
    symlinkSync(join(installs[1], "dist", "bin.js"), join(prefixBin, "orchestra"));
    symlinkSync(join(installs[0], "dist", "bin.js"), join(home, ".local", "bin", "understudy"));
    writeFileSync(join(home, ".local", "bin", "orchestra"), "#!/bin/sh\necho mine\n");
    writeFileSync(
      join(bin, "npm"),
      `#!/usr/bin/env bash\ncase "$*" in\n  "root -g") printf '%s\\n' "${npmRoot}" ;;\n  "prefix -g") printf '%s\\n' "${join(root, "prefix")}" ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);

    const names = script.match(/^PACKAGE_NAME=.*\n(?:#.*\n)*LEGACY_PACKAGE_NAMES=.*$/m)[0];
    const harness = `say() { printf '%s\\n' "$*"; }\nwarn() { printf 'warn: %s\\n' "$*"; }\n${names}\n${fn}\nremove_previous_global_package\n`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const dir of installs) assert.equal(existsSync(dir), false, dir);
    assert.equal(existsSync(join(npmRoot, "@understudylabs")), false);
    assert.throws(() => lstatSync(join(prefixBin, "understudy")), { code: "ENOENT" });
    assert.throws(() => lstatSync(join(prefixBin, "orchestra")), { code: "ENOENT" });
    assert.throws(() => lstatSync(join(home, ".local", "bin", "understudy")), { code: "ENOENT" });
    assert.equal(readFileSync(join(home, ".local", "bin", "orchestra"), "utf8"), "#!/bin/sh\necho mine\n");
  });

  it("refreshes Cursor and OpenCode links left at another @orchestraai/agent-tools folder", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const otherPrefix = join(root, "other-prefix", "lib", "node_modules", "@orchestraai", "agent-tools");
    mkdirSync(join(home, ".cursor", "plugins", "local"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode", "skills"), { recursive: true });
    mkdirSync(join(home, ".config", "opencode", "commands"), { recursive: true });
    symlinkSync(otherPrefix, join(home, ".cursor", "plugins", "local", "orchestra"));
    symlinkSync(join(otherPrefix, "skills", "understudy"), join(home, ".config", "opencode", "skills", "understudy"));
    symlinkSync(
      join(otherPrefix, ".opencode", "commands", "orchestra-onboard.md"),
      join(home, ".config", "opencode", "commands", "orchestra-onboard.md"),
    );

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "cursor,opencode", "--no-launch-agent", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          HERMES_HOME: join(home, ".hermes"),
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Orchestra Cursor plugin refreshed/);
    assert.equal(readlinkSync(join(home, ".cursor", "plugins", "local", "orchestra")), process.cwd());
    assert.equal(readlinkSync(join(home, ".config", "opencode", "skills", "understudy")), join(process.cwd(), "skills", "understudy"));
    assert.equal(
      readlinkSync(join(home, ".config", "opencode", "commands", "orchestra-onboard.md")),
      join(process.cwd(), ".opencode", "commands", "orchestra-onboard.md"),
    );
  });

  it("leaves a pre-rename Cursor path alone when it is not an Orchestra checkout", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const foreign = join(home, ".cursor", "plugins", "local", "understudy");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "keep.txt"), "mine\n");

    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "cursor", "--no-launch-claude", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          HERMES_HOME: join(home, ".hermes"),
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(join(foreign, "keep.txt"), "utf8"), "mine\n");
    assert.equal(lstatSync(join(home, ".cursor", "plugins", "local", "orchestra")).isSymbolicLink(), true);
  });

  it("surfaces an interactive install-target selector for human installs", () => {
    const script = readFileSync("install.sh", "utf8");

    assert.match(script, /Choose Coding Agent/);
    assert.match(script, /Where should Orchestra install its agent plugin/);
    assert.match(script, /Install target/);
    assert.match(script, /All detected coding agents/);
    assert.match(script, /CLI only, no coding-agent plugins/);
    assert.match(script, /OpenCode/);
    assert.match(script, /Hermes Agent/);
  });

  it("focuses the handoff on Anthropic bill reduction when requested", () => {
    const script = readFileSync("install.sh", "utf8");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "3",
        "--lower-my-ant-bill",
        "--no-launch-agent",
        "--agents",
        "none",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Focused path: lower Anthropic bill/);
    assert.match(result.stdout, /lower-anthropic-bill skill/);
  });

  it("continues when Codex marketplace registration cannot be refreshed", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "codex-failed-calls.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "codex"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$*" in\n  plugin\\ marketplace\\ add*) echo "Error: --ref is only supported for git marketplace sources" >&2; exit 1 ;;\n  "plugin marketplace upgrade orchestra-skills") echo "Error: marketplace is not configured as a Git marketplace" >&2; exit 1 ;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "codex",
        "--no-launch-claude",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    // The install still continues through the remaining adapters, but an
    // explicitly requested adapter that failed now yields exit code 3.
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Codex marketplace add failed; trying marketplace refresh/);
    assert.match(result.stdout, /Codex marketplace registration failed; continuing/);
    assert.match(result.stdout, /Manual recovery: run `codex plugin marketplace remove orchestra-skills`/);
    assert.match(result.stdout, /codex: failed — marketplace registration failed/);
    assert.match(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    const callsText = readFileSync(calls, "utf8");
    assert.match(callsText, /plugin marketplace add /);
    assert.match(callsText, /plugin marketplace upgrade orchestra-skills/);
  });

  it("rejects ambiguous mixed agent adapter modes", () => {
    const script = readFileSync("install.sh", "utf8");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "auto,cursor", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 2);
    assert.match(result.stdout, /cannot be combined/);
  });

  it("skips agent adapters with --no-agents", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--no-agents", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Claude Code adapter not selected or not detected/);
    assert.match(result.stdout, /Cursor adapter not selected or not detected/);
    assert.match(result.stdout, /Codex adapter not selected or not detected/);
    assert.match(result.stdout, /OpenCode adapter not selected or not detected/);
    assert.match(result.stdout, /Hermes adapter not selected or not detected/);
    assert.match(result.stdout, /No coding-agent plugins were requested/);
    assert.doesNotMatch(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.equal(existsSync(join(home, ".cursor", "plugins", "local", "orchestra")), false);
  });

  it("logs the resolved adapter selection to stdout and the install log", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const logDir = join(root, "logs");
    const result = spawnSync(
      "bash",
      ["-s", "--", "--non-interactive", "--only-step", "2", "--agents", "none", "--lab", join(root, "lab")],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: logDir,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Agent adapter selection: none \(source: --agents flag\)/);
    const logs = readdirSync(logDir).filter((name) => name.startsWith("install-"));
    assert.equal(logs.length, 1);
    assert.match(
      readFileSync(join(logDir, logs[0]), "utf8"),
      /Agent adapter selection: none \(source: --agents flag\)/,
    );
  });

  it("fails loudly when an explicitly requested adapter has no CLI on PATH", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    // A minimal PATH with node + npm but no claude: the explicit request must
    // become a recorded failure with recovery commands and exit code 3.
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(dirname(process.execPath), "npm"), join(bin, "npm"));
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-launch-agent",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Agent adapter selection: claude-code \(source: --agents flag\)/);
    assert.match(result.stdout, /explicitly requested but the claude CLI is not on PATH/);
    assert.match(result.stdout, /claude-code: failed — the claude CLI is not on PATH/);
    assert.match(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.match(result.stdout, /claude plugin marketplace add .+ && claude plugin install orchestra@orchestra-skills/);
    assert.match(result.stdout, /skills are NOT ready in any coding agent/);
    assert.doesNotMatch(result.stdout, /Claude Code: run \/reload-plugins and then \/orchestra:onboard\./);
  });

  it("only prints next steps for adapters that actually installed", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const calls = join(root, "claude-calls.txt");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf 'claude %s\\n' "$*" >> "${calls}"\nif [ "$*" = "plugin list --json" ]; then printf '[]\\n'; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);

    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-launch-agent",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          UNDERSTUDY_INSTALL_FROM_CWD: "1",
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Adapter summary/);
    assert.match(result.stdout, /claude-code: plugin installed/);
    assert.match(result.stdout, /cursor: skipped — not selected or not detected/);
    assert.match(result.stdout, /Claude Code: run \/reload-plugins and then \/orchestra:onboard\./);
    assert.doesNotMatch(result.stdout, /Cursor: restart Cursor or run Developer: Reload Window/);
    assert.doesNotMatch(result.stdout, /Codex: run \/plugins/);
    assert.doesNotMatch(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
  });

  it("treats --agents claude-code --no-claude as an intentional CLI-only install", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-claude",
        "--no-launch-agent",
        "--lab",
        join(root, "lab"),
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    // The user disabled the adapter themselves, so this is a CLI-only
    // install by choice, not a zero-adapter failure: exit 0, no loud block.
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /claude-code: skipped — disabled by --no-claude/);
    assert.match(result.stdout, /disabled by a flag/);
    assert.doesNotMatch(result.stdout, /NO CODING-AGENT PLUGIN WAS INSTALLED/);
    assert.doesNotMatch(result.stdout, /skills are NOT ready in any coding agent/);
  });

  it("does not mark step 2 resumable when adapter installation is incomplete", () => {
    const script = readFileSync("install.sh", "utf8");
    const home = join(root, "home");
    const lab = join(root, "lab");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    symlinkSync(join(dirname(process.execPath), "npm"), join(bin, "npm"));
    const result = spawnSync(
      "bash",
      [
        "-s",
        "--",
        "--non-interactive",
        "--only-step",
        "2",
        "--agents",
        "claude-code",
        "--no-launch-agent",
        "--lab",
        lab,
      ],
      {
        cwd: process.cwd(),
        input: script,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "1",
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
        },
      },
    );

    // The failed adapter step must not write last-step=2, or --resume would
    // start at step 3 and exit 0 while the plugin is still missing. The state
    // dir follows the --lab override.
    assert.equal(result.status, 3, result.stderr || result.stdout);
    assert.match(result.stdout, /Step 2 is not marked complete/);
    const stateDir = join(lab, "install-state");
    assert.equal(existsSync(join(home, ".understudy", "agent-tools", "install-state")), false);
    const lastStep = join(stateDir, "last-step");
    if (existsSync(lastStep)) {
      assert.notEqual(readFileSync(lastStep, "utf8").trim(), "2");
    }
    assert.equal(existsSync(join(stateDir, "step-2.done")), false);
  });

  // Stubs for the commands the new install flow shells out to. The PATH holds
  // only these stubs and node, so a real npm, git, uv, or brew on the machine
  // can never be reached.
  function flowStubs({ npmView = {}, uname = ["Darwin", "arm64"], uv = true } = {}) {
    const bin = join(root, "bin");
    const nodeBin = join(root, "node-bin");
    const calls = join(root, "calls.txt");
    const prefix = join(root, "prefix");
    mkdirSync(bin, { recursive: true });
    mkdirSync(nodeBin, { recursive: true });
    symlinkSync(process.execPath, join(nodeBin, "node"));
    const views = Object.entries(npmView)
      .map(([args, out]) => `  "view ${args}") printf '%s\\n' '${out}' ;;\n`)
      .join("");
    const stubs = {
      npm: `#!/bin/bash\nprintf 'npm %s\\n' "$*" >> "${calls}"\ncase "$*" in\n  "root -g") printf '%s\\n' "${join(prefix, "lib", "node_modules")}" ;;\n  "prefix -g") printf '%s\\n' "${prefix}" ;;\n${views}  view*) exit 1 ;;\nesac\nexit 0\n`,
      git: `#!/bin/bash\nprintf 'git %s\\n' "$*" >> "${calls}"\nexit 1\n`,
      orchestra: `#!/bin/bash\nprintf 'orchestra %s\\n' "$*" >> "${calls}"\nexit 0\n`,
      uname: `#!/bin/bash\ncase "$1" in\n  -s) echo ${uname[0]} ;;\n  -m) echo ${uname[1]} ;;\n  *) /usr/bin/uname "$@" ;;\nesac\n`,
      date: `#!/bin/bash\nexec /bin/date "$@"\n`,
    };
    if (uv) stubs.uv = `#!/bin/bash\nexit 0\n`;
    for (const [name, body] of Object.entries(stubs)) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    return { calls, path: `${bin}:${nodeBin}:/usr/bin:/bin` };
  }

  function runFlow(args, stubs) {
    return spawnSync("bash", ["-s", "--", ...args, "--lab", join(root, "lab")], {
      cwd: process.cwd(),
      input: readFileSync("install.sh", "utf8"),
      encoding: "utf8",
      env: {
        HOME: join(root, "home"),
        PATH: stubs.path,
        CI: "1",
        UNDERSTUDY_INSTALL_LOG_DIR: join(root, "logs"),
      },
    });
  }

  function waitForCalls(calls, pattern) {
    for (let i = 0; i < 50; i += 1) {
      if (existsSync(calls) && pattern.test(readFileSync(calls, "utf8"))) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  it("installs the published npm release by default, without cloning", () => {
    mkdirSync(join(root, "home"), { recursive: true });
    const stubs = flowStubs({
      npmView: { "@orchestraai/agent-tools@latest version": "0.7.0", "@orchestraai/agent-tools@0.7.0 deprecated": "" },
    });
    const result = runFlow(["--non-interactive", "--only-step", "1"], stubs);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Installing @orchestraai\/agent-tools@0\.7\.0 from npm/);
    const callsText = readFileSync(stubs.calls, "utf8");
    assert.match(callsText, /npm install -g --ignore-scripts @orchestraai\/agent-tools@0\.7\.0/);
    assert.doesNotMatch(callsText, /git clone/);
    assert.equal(readFileSync(join(root, "lab", "install-state", "package-version"), "utf8"), "0.7.0\n");
  });

  it("builds from source when npm has no release or only the deprecated placeholder", () => {
    for (const npmView of [{}, { "@orchestraai/agent-tools@latest version": "0.0.1", "@orchestraai/agent-tools@0.0.1 deprecated": "Not installable from npm." }]) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(join(root, "home"), { recursive: true });
      const stubs = flowStubs({ npmView });
      const result = runFlow(["--non-interactive", "--only-step", "1"], stubs);

      // The stub git fails the clone, so the run stops there; what matters is
      // that it went to the source build and never installed from npm.
      assert.match(result.stdout, /Building Orchestra from the GitHub source instead/);
      const callsText = readFileSync(stubs.calls, "utf8");
      assert.match(callsText, /git clone/);
      assert.doesNotMatch(callsText, /npm install -g --ignore-scripts @orchestraai/);
    }
  });

  it("starts the local model lab in the background on Apple Silicon", () => {
    mkdirSync(join(root, "home"), { recursive: true });
    const stubs = flowStubs();
    const result = runFlow(["--non-interactive", "--from-step", "2", "--agents", "none", "--local-models"], stubs);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Downloading gemma-4-e2b-it-qat-mlx-vlm-understudy \(about 3\.6 GB\) in the background/);
    waitForCalls(stubs.calls, /models runtime install[\s\S]*models pull|models pull[\s\S]*models runtime install/);
    const callsText = readFileSync(stubs.calls, "utf8");
    assert.match(callsText, /orchestra models runtime install/);
    assert.match(callsText, /orchestra models pull gemma-4-e2b-it-qat-mlx-vlm-understudy/);
    const lab = JSON.parse(readFileSync(join(root, "lab", "install-state", "local-model-lab.json"), "utf8"));
    assert.equal(lab.model, "gemma-4-e2b-it-qat-mlx-vlm-understudy");
    assert.ok(lab.pull.log.endsWith(".log"));
    assert.ok(lab.runtime.log.endsWith(".log"));
  });

  it("still downloads the model but never installs uv when uv is missing", () => {
    mkdirSync(join(root, "home"), { recursive: true });
    const stubs = flowStubs({ uv: false });
    const result = runFlow(["--non-interactive", "--from-step", "2", "--agents", "none", "--local-models"], stubs);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /uv is not installed, so the MLX runtime was not set up/);
    waitForCalls(stubs.calls, /models pull/);
    const callsText = readFileSync(stubs.calls, "utf8");
    assert.match(callsText, /orchestra models pull gemma-4-e2b-it-qat-mlx-vlm-understudy/);
    assert.doesNotMatch(callsText, /models runtime install|brew/);
    assert.equal(JSON.parse(readFileSync(join(root, "lab", "install-state", "local-model-lab.json"), "utf8")).runtime, null);
  });

  it("skips the local model lab off Apple Silicon", () => {
    mkdirSync(join(root, "home"), { recursive: true });
    const stubs = flowStubs({ uname: ["Linux", "x86_64"] });
    const result = runFlow(["--non-interactive", "--from-step", "2", "--agents", "none", "--local-models"], stubs);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /The local model lab needs an Apple Silicon Mac; skipping it/);
    assert.equal(existsSync(join(root, "lab", "install-state", "local-model-lab.json")), false);
    assert.doesNotMatch(existsSync(stubs.calls) ? readFileSync(stubs.calls, "utf8") : "", /models (pull|runtime)/);
  });

  it("keeps an existing sign-in by default and leaves sign-in to the terminal", () => {
    const understudyDir = join(root, "home", ".understudy");
    mkdirSync(understudyDir, { recursive: true });
    writeFileSync(join(understudyDir, "credentials.json"), '{"api_key":"sk_demo","orgs":{}}\n');
    let stubs = flowStubs();
    let result = runFlow(["--non-interactive", "--from-step", "2", "--agents", "none"], stubs);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Already signed in; keeping that sign-in/);
    assert.equal(existsSync(join(understudyDir, "credentials.json")), true);
    assert.equal(readdirSync(understudyDir).some((name) => name.startsWith("credentials.json.bak-")), false);

    // Not signed in and no terminal: point at `orchestra login`, never sign in for the user.
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "home"), { recursive: true });
    stubs = flowStubs();
    result = runFlow(["--non-interactive", "--from-step", "2", "--agents", "none"], stubs);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Not signed in\. Run `orchestra login` in a terminal/);
    assert.doesNotMatch(existsSync(stubs.calls) ? readFileSync(stubs.calls, "utf8") : "", /orchestra login/);

    result = runFlow(["--non-interactive", "--from-step", "2", "--agents", "none", "--skip-login"], stubs);
    assert.match(result.stdout, /Skipping the Orchestra sign-in/);
  });

  it("hands off without forcing a permission mode, recording the session, or asking the agent to handle codes", () => {
    const script = readFileSync("install.sh", "utf8");
    assert.match(script, /^CLAUDE_PERMISSION_MODE="\$\{UNDERSTUDY_CLAUDE_PERMISSION_MODE:-\}"$/m);
    assert.doesNotMatch(script, /script -q/);
    const start = script.indexOf("compose_initial_prompt() {");
    const prompt = script
      .slice(start, script.indexOf("\n}\n", start))
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(prompt, /inbox|login --code|login --email/);
    assert.match(prompt, /Use the Orchestra onboarding skill for this project\./);
  });

  it("offers a short setup menu with the local model lab only on Apple Silicon", () => {
    const script = readFileSync("install.sh", "utf8");
    assert.match(script, /What do you want to set up\?/);
    assert.match(script, /Orchestra account \+ plugin for your coding agents/);
    assert.match(script, /if local_models_supported; then\n\s+say "  \$\{G3\}2\.\$\{R\} Option 1 \+ local model lab/);
    assert.match(script, /Advanced: choose which coding agents get the plugin/);
  });
});
