// Security sweep (exec-env group): subprocess argv/env hygiene and path-safe
// identity values. No network, no fixed ports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { filterChangedBenchmarkDirs } from "../dist/rigor-report.js";
import { APP_HARNESS_FILE, appReplayRunner, validateAppHarness } from "../dist/app-harness.js";
import { APP_HARNESS_SCHEMA } from "../dist/benchmark-artifacts.js";
import { scrubbedOfflineEnvironment } from "../dist/local-sft/index.js";
import { readPrimeExecutionConfig } from "../dist/prime-benchmark-runner.js";
import { sqlq } from "../dist/commands/explore.js";

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});
const tmpDir = (prefix = "security-exec-env-") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
};

describe("filterChangedBenchmarkDirs (--base is never a shell string)", () => {
  it("rejects shell metacharacters and option-like refs before touching git", () => {
    const marker = path.join(tmpDir(), "pwned");
    assert.throws(() => filterChangedBenchmarkDirs([], `HEAD; touch ${marker}`), /--base must be a git revision/);
    assert.throws(() => filterChangedBenchmarkDirs([], "$(id)"), /--base must be a git revision/);
    assert.throws(() => filterChangedBenchmarkDirs([], "--output=/tmp/x"), /--base must be a git revision/);
    assert.equal(fs.existsSync(marker), false);
  });

  it("still accepts ordinary revision syntax", () => {
    const repo = tmpDir("security-rigor-repo-");
    const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    fs.mkdirSync(path.join(repo, "benchmarks", "bench-a"), { recursive: true });
    fs.writeFileSync(path.join(repo, "benchmarks", "bench-a", "tasks.jsonl"), "{}\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    fs.writeFileSync(path.join(repo, "benchmarks", "bench-a", "tasks.jsonl"), "{\"changed\":true}\n");
    git("add", "-A");
    git("commit", "-qm", "touch");
    const previous = process.cwd();
    process.chdir(repo);
    try {
      const result = filterChangedBenchmarkDirs([path.join(repo, "benchmarks", "bench-a")], "HEAD~1");
      assert.equal(result.base, "HEAD~1");
      assert.deepEqual(result.dirs, [path.join(repo, "benchmarks", "bench-a")]);
    } finally {
      process.chdir(previous);
    }
  });
});

describe("app-harness argv_separator (opt-in)", () => {
  const harness = (overrides = {}) => ({ schema_version: APP_HARNESS_SCHEMA, command: ["node", "app.mjs"], input_mode: "argv", ...overrides });

  it("validates argv_separator as a boolean and leaves old harnesses untouched", () => {
    assert.deepEqual(validateAppHarness(harness()), []);
    assert.deepEqual(validateAppHarness(harness({ argv_separator: true })), []);
    assert.ok(validateAppHarness(harness({ argv_separator: "yes" })).some((e) => /argv_separator/.test(e)));
  });

  it("puts -- before the prompt only when the harness asks for it", async () => {
    const run = async (separator) => {
      const dir = tmpDir();
      const argvFile = path.join(dir, "argv.json");
      fs.writeFileSync(path.join(dir, "benchmark.json"), JSON.stringify({
        schema_version: "understudy.benchmark.v1",
        benchmark_id: "app-bench",
        provenance: { origin: "derived-from-traces" },
        taxonomy: [{ category_id: "cat-a" }],
        tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "replayed", split: "train" }],
        environment: { format: "verifiers.v1", package_ref: "environment" },
        verifier: { kind: "final-state", strict_metric: "task_completed_correctly", dense_metric: "final_state_partial_credit" },
      }));
      const task = {
        schema_version: "understudy.benchmark_task.v1",
        task_id: "t1",
        title: "t",
        source_messages: [{ role: "user", content: "--help me" }],
        outcome_contract: { required: [], preserved: [], forbidden: [], grading: "final_state_and_obligations" },
      };
      fs.writeFileSync(path.join(dir, "tasks.jsonl"), JSON.stringify(task) + "\n");
      fs.writeFileSync(path.join(dir, "app.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2))); console.log("ok");`);
      fs.writeFileSync(path.join(dir, APP_HARNESS_FILE), JSON.stringify(harness({ command: [process.execPath, "app.mjs"], ...(separator ? { argv_separator: true } : {}) })));
      const env = { ...process.env, UNDERSTUDY_API_KEY: "sk-test", UNDERSTUDY_GATEWAY_URL: "https://gw.example" };
      await appReplayRunner(env)({ benchmarkDir: dir, model: "my-app", task, rollout: 0, selectedTaskIds: ["t1"], journalPath: null, runId: "run-x" });
      return JSON.parse(fs.readFileSync(argvFile, "utf8"));
    };
    assert.deepEqual(await run(false), ["--help me"]);
    assert.deepEqual(await run(true), ["--", "--help me"]);
  });
});

describe("local-sft child environment is an allowlist", () => {
  it("drops everything that is not toolchain/cache/locale, including UV_* secrets", () => {
    const env = scrubbedOfflineEnvironment({
      PATH: "/bin", HOME: "/home/u", HF_HOME: "/hf", UV_CACHE_DIR: "/uv", UV_PYTHON_INSTALL_DIR: "/py",
      DATABASE_URL: "postgres://u:p@h/db", NPM_CONFIG__AUTH: "x", SSH_AUTH_SOCK: "/s", GPG_PASSPHRASE: "p",
      UV_PUBLISH_TOKEN: "t", UV_INDEX_FOO_PASSWORD: "p", OPENAI_API_KEY: "k", RANDOM_APP_VAR: "1",
    });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.HOME, "/home/u");
    assert.equal(env.HF_HOME, "/hf");
    assert.equal(env.UV_CACHE_DIR, "/uv");
    assert.equal(env.UV_PYTHON_INSTALL_DIR, "/py");
    assert.equal(env.UV_OFFLINE, "1");
    assert.equal(env.HF_HUB_OFFLINE, "1");
    for (const key of ["DATABASE_URL", "NPM_CONFIG__AUTH", "SSH_AUTH_SOCK", "GPG_PASSPHRASE", "UV_PUBLISH_TOKEN", "UV_INDEX_FOO_PASSWORD", "OPENAI_API_KEY", "RANDOM_APP_VAR"]) {
      assert.equal(key in env, false, key);
    }
  });
});

describe("prime execution identity values stay inside their roots", () => {
  const writeConfig = (identity) => {
    const file = path.join(tmpDir(), "execution.json");
    fs.writeFileSync(file, JSON.stringify({
      schema_version: "understudy.prime_execution.v1",
      eval_config: "eval.toml",
      import_config: "import.json",
      source_dir: "source",
      rejected_dir: "rejected-runs",
      identity: { benchmark_version: "sample-v1", environment_sha256: "abc123", verifier_version: "0.2.1", model: "gpt-5.5", run_id: "r1", ...identity },
      provider_policy: { provider: "openai", deployment: "openai:gpt-5.5", allowed_providers: ["openai"] },
    }));
    return file;
  };

  it("rejects traversal, absolute and NUL-bearing values but keeps provider/model ids", () => {
    assert.throws(() => readPrimeExecutionConfig(writeConfig({ run_id: "../../tmp/evil" })), /identity\.run_id/);
    assert.throws(() => readPrimeExecutionConfig(writeConfig({ model: "/etc/x" })), /identity\.model/);
    assert.throws(() => readPrimeExecutionConfig(writeConfig({ benchmark_version: "a//b" })), /identity\.benchmark_version/);
    assert.throws(() => readPrimeExecutionConfig(writeConfig({ verifier_version: "0.2\0.1" })), /identity\.verifier_version/);
    assert.equal(readPrimeExecutionConfig(writeConfig({ model: "openai/gpt-5" })).identity.model, "openai/gpt-5");
    assert.equal(readPrimeExecutionConfig(writeConfig({})).identity.run_id, "r1");
  });
});

describe("explore ClickHouse literal escaping", () => {
  it("cannot close a single-quoted literal", () => {
    assert.equal(sqlq("a'b"), "a\\'b");
    assert.equal(sqlq("a\\'b"), "a\\\\\\'b");
    assert.equal(sqlq("plain"), "plain");
  });
});
