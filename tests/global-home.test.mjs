import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { GLOBAL_HOME_MARKER, globalConfigDir, migrateGlobalHome } from "../dist/config/paths.js";

const posix = process.platform !== "win32";

// Same in-process $HOME swap as tests/paths.test.mjs: os.homedir() reads
// the env var on POSIX, and node:test runs these cases sequentially.
describe("global home: ~/.understudy -> ~/.orchestra", { skip: !posix }, () => {
  let home;
  let current;
  let legacy;
  const savedHome = process.env.HOME;
  const savedOptIn = process.env.UNDERSTUDY_HOME_MIGRATION;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orchestra-home-"));
    process.env.HOME = home;
    // Migration is opt-in; the installer sets this.
    process.env.UNDERSTUDY_HOME_MIGRATION = "1";
    assert.equal(homedir(), home);
    current = join(home, ".orchestra");
    legacy = join(home, ".understudy");
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedOptIn === undefined) delete process.env.UNDERSTUDY_HOME_MIGRATION;
    else process.env.UNDERSTUDY_HOME_MIGRATION = savedOptIn;
    rmSync(home, { recursive: true, force: true });
  });

  it("does nothing unless UNDERSTUDY_HOME_MIGRATION=1", () => {
    mkdirSync(legacy);
    assert.equal(migrateGlobalHome({}).status, "disabled");
    assert.equal(migrateGlobalHome({ UNDERSTUDY_HOME_MIGRATION: "0" }).status, "disabled");
    assert.equal(migrateGlobalHome({ UNDERSTUDY_HOME_MIGRATION: "true" }).status, "disabled");
    assert.ok(!existsSync(current));
    assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink());
  });

  it("a plain CLI run leaves the home alone, even outside node --test", () => {
    mkdirSync(legacy);
    const env = { ...process.env, HOME: home, UNDERSTUDY_TELEMETRY: "0" };
    delete env.UNDERSTUDY_HOME_MIGRATION;
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(current));
  });

  it("creates ~/.orchestra and the legacy symlink on a fresh machine", () => {
    assert.equal(migrateGlobalHome().status, "created");
    assert.ok(statSync(current).isDirectory());
    assert.equal(statSync(current).mode & 0o777, 0o700);
    assert.ok(existsSync(join(current, GLOBAL_HOME_MARKER)));
    assert.ok(lstatSync(legacy).isSymbolicLink());
    assert.equal(readlinkSync(legacy), ".orchestra");
    assert.equal(globalConfigDir(), current);
  });

  it("moves an existing ~/.understudy and keeps every old path working", () => {
    mkdirSync(join(legacy, "models", "gemma"), { recursive: true, mode: 0o700 });
    writeFileSync(join(legacy, "credentials.json"), '{"api_key":"sk_test"}\n', { mode: 0o600 });
    writeFileSync(join(legacy, "models", "gemma", "weights.bin"), "w");

    assert.equal(migrateGlobalHome().status, "migrated");
    assert.equal(globalConfigDir(), current);
    assert.equal(readFileSync(join(current, "credentials.json"), "utf8"), '{"api_key":"sk_test"}\n');
    assert.equal(statSync(join(current, "credentials.json")).mode & 0o777, 0o600);
    // Old readers (installer, Python helpers, skills) go through the link.
    assert.ok(lstatSync(legacy).isSymbolicLink());
    assert.equal(readFileSync(join(legacy, "models", "gemma", "weights.bin"), "utf8"), "w");
    const marker = JSON.parse(readFileSync(join(current, GLOBAL_HOME_MARKER), "utf8"));
    assert.equal(marker.migrated_from, "~/.understudy");
  });

  it("is idempotent and restores a deleted legacy link", () => {
    assert.equal(migrateGlobalHome().status, "created");
    rmSync(legacy);
    assert.equal(migrateGlobalHome().status, "already-migrated");
    assert.ok(lstatSync(legacy).isSymbolicLink());
  });

  it("never adopts another tool's ~/.orchestra", () => {
    mkdirSync(join(current, "config"), { recursive: true });
    writeFileSync(join(current, "config", "user_options.yml"), "other: tool\n");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "credentials.json"), "{}\n");

    assert.equal(migrateGlobalHome().status, "kept-legacy");
    assert.equal(globalConfigDir(), legacy);
    assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink());
    assert.ok(!existsSync(join(current, GLOBAL_HOME_MARKER)));
    assert.equal(readFileSync(join(current, "config", "user_options.yml"), "utf8"), "other: tool\n");
  });

  it("leaves a user-managed ~/.understudy symlink alone", () => {
    const elsewhere = join(home, "dotfiles", "understudy");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, legacy, "dir");

    assert.equal(migrateGlobalHome().status, "kept-legacy");
    assert.equal(readlinkSync(legacy), elsewhere);
    assert.ok(!existsSync(current));
    assert.equal(globalConfigDir(), legacy);
  });

  it("merges a real ~/.understudy that reappeared beside a migrated home", () => {
    // State after a crash between rename and symlink, then the installer
    // recreating ~/.understudy/agent-tools/... as a real directory.
    mkdirSync(join(current, "agent-tools", "logs"), { recursive: true });
    writeFileSync(join(current, GLOBAL_HOME_MARKER), "{}\n");
    writeFileSync(join(current, "credentials.json"), "{}\n");
    mkdirSync(join(legacy, "agent-tools", "install-state"), { recursive: true });
    writeFileSync(join(legacy, "agent-tools", "install-state", "step-1.done"), "x");
    writeFileSync(join(legacy, "profile.json"), '{"tier":"new"}\n');
    writeFileSync(join(legacy, GLOBAL_HOME_MARKER), "{}\n");

    assert.equal(migrateGlobalHome().status, "already-migrated");
    assert.ok(lstatSync(legacy).isSymbolicLink());
    assert.equal(readFileSync(join(current, "agent-tools", "install-state", "step-1.done"), "utf8"), "x");
    assert.equal(readFileSync(join(current, "profile.json"), "utf8"), '{"tier":"new"}\n');
    assert.ok(existsSync(join(current, "agent-tools", "logs")));
    assert.equal(readFileSync(join(current, "credentials.json"), "utf8"), "{}\n");
  });

  it("never overwrites: entries in both homes stay put and are reported", () => {
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, GLOBAL_HOME_MARKER), "{}\n");
    writeFileSync(join(current, "credentials.json"), '{"api_key":"sk_new"}\n');
    mkdirSync(legacy);
    writeFileSync(join(legacy, "credentials.json"), '{"api_key":"sk_old"}\n');
    writeFileSync(join(legacy, "profile.json"), "{}\n");

    const outcome = migrateGlobalHome();
    assert.equal(outcome.status, "split");
    assert.deepEqual(outcome.conflicts, [join(legacy, "credentials.json")]);
    assert.equal(readFileSync(join(current, "credentials.json"), "utf8"), '{"api_key":"sk_new"}\n');
    assert.equal(readFileSync(join(legacy, "credentials.json"), "utf8"), '{"api_key":"sk_old"}\n');
    assert.ok(existsSync(join(current, "profile.json")));
    assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink());
  });

  it("globalConfigDir() only reads: it never moves anything", () => {
    mkdirSync(legacy);
    assert.equal(globalConfigDir(), legacy);
    assert.ok(!existsSync(current));
    assert.ok(!lstatSync(legacy).isSymbolicLink());
  });

  it("the CLI migrates when the installer opts in and still finds existing credentials", () => {
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(
      join(legacy, "credentials.json"),
      `${JSON.stringify({ api_key: "sk_cli", gateway_url: "https://gateway.example.test", orgs: {} })}\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(process.execPath, ["dist/bin.js", "--json", "status"], {
      env: { ...process.env, HOME: home, UNDERSTUDY_TELEMETRY: "0", UNDERSTUDY_HOME_MIGRATION: "1" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(statSync(current).isDirectory());
    assert.ok(lstatSync(legacy).isSymbolicLink());
    assert.ok(existsSync(join(current, "credentials.json")));
    assert.equal(JSON.parse(result.stdout).signed_in, true);
  });
});
