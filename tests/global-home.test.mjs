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
    // Migration is off under node --test unless explicitly opted in.
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

  it("stays off under node --test and when opted out", () => {
    mkdirSync(legacy);
    assert.equal(migrateGlobalHome({ NODE_TEST_CONTEXT: "child-v8" }), "disabled");
    assert.equal(migrateGlobalHome({ UNDERSTUDY_HOME_MIGRATION: "0" }), "disabled");
    assert.ok(!existsSync(current));
    assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink());
  });

  it("a CLI spawned by a test leaves the home alone", () => {
    mkdirSync(legacy);
    const env = { ...process.env, HOME: home, UNDERSTUDY_TELEMETRY: "0" };
    delete env.UNDERSTUDY_HOME_MIGRATION;
    const result = spawnSync(process.execPath, ["dist/bin.js", "--version"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!existsSync(current));
  });

  it("creates ~/.orchestra and the legacy symlink on a fresh machine", () => {
    assert.equal(migrateGlobalHome(), "created");
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

    assert.equal(migrateGlobalHome(), "migrated");
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
    assert.equal(migrateGlobalHome(), "created");
    rmSync(legacy);
    assert.equal(migrateGlobalHome(), "already-migrated");
    assert.ok(lstatSync(legacy).isSymbolicLink());
  });

  it("never adopts another tool's ~/.orchestra", () => {
    mkdirSync(join(current, "config"), { recursive: true });
    writeFileSync(join(current, "config", "user_options.yml"), "other: tool\n");
    mkdirSync(legacy);
    writeFileSync(join(legacy, "credentials.json"), "{}\n");

    assert.equal(migrateGlobalHome(), "kept-legacy");
    assert.equal(globalConfigDir(), legacy);
    assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink());
    assert.ok(!existsSync(join(current, GLOBAL_HOME_MARKER)));
    assert.equal(readFileSync(join(current, "config", "user_options.yml"), "utf8"), "other: tool\n");
  });

  it("leaves a user-managed ~/.understudy symlink alone", () => {
    const elsewhere = join(home, "dotfiles", "understudy");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, legacy, "dir");

    assert.equal(migrateGlobalHome(), "kept-legacy");
    assert.equal(readlinkSync(legacy), elsewhere);
    assert.ok(!existsSync(current));
    assert.equal(globalConfigDir(), legacy);
  });

  it("does not touch a real ~/.understudy that appeared beside a migrated home", () => {
    assert.equal(migrateGlobalHome(), "created");
    rmSync(legacy);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "stray.json"), "{}\n");

    assert.equal(migrateGlobalHome(), "already-migrated");
    assert.equal(readFileSync(join(legacy, "stray.json"), "utf8"), "{}\n");
    assert.equal(globalConfigDir(), current);
  });

  it("globalConfigDir() only reads: it never moves anything", () => {
    mkdirSync(legacy);
    assert.equal(globalConfigDir(), legacy);
    assert.ok(!existsSync(current));
    assert.ok(!lstatSync(legacy).isSymbolicLink());
  });

  it("the CLI migrates on first run and still finds existing credentials", () => {
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(
      join(legacy, "credentials.json"),
      `${JSON.stringify({ api_key: "sk_cli", gateway_url: "https://gateway.example.test", orgs: {} })}\n`,
      { mode: 0o600 },
    );
    const result = spawnSync(process.execPath, ["dist/bin.js", "--json", "status"], {
      env: { ...process.env, HOME: home, UNDERSTUDY_TELEMETRY: "0" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(statSync(current).isDirectory());
    assert.ok(lstatSync(legacy).isSymbolicLink());
    assert.ok(existsSync(join(current, "credentials.json")));
    assert.equal(JSON.parse(result.stdout).signed_in, true);
  });
});
