import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// Security sweep (group mcp): the stdio benchmarks MCP surface enforces the
// same spend-adjacent trust-posture guard as the embedded Pi chat, confines
// the one directory-creating path argument, validates the ledger-bound
// review scope, and labels relayed journal/task text as untrusted data.
import {
  BENCHMARKS_TOOLS,
  benchmarkGuardBlockMessage,
  callBenchmarksTool,
  classifyBenchmarkToolCall,
  queueRunIsTrivial,
} from "../dist/benchmarks-mcp.js";

const bin = path.resolve("dist/bin.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "security-mcp-"));
process.env.BENCHMARK_HUB_DATA_DIR = tmp;
delete process.env.BENCHMARK_HUB_DEMO;
// Pin the trust posture to the absent-file default (local_sandbox) so a
// developer machine's real ~/.understudy/trust.json never flips these tests.
process.env.UNDERSTUDY_TRUST_FILE = path.join(tmp, "trust.json");
const postureAt = (level) => ({ schema_version: "understudy.trust_posture.v1", level, set_at: null, overrides: {} });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* ---------------- fixture: one promoted benchmark + one drop file ---------------- */

const promotedDir = path.join(tmp, "promoted");
fs.mkdirSync(path.join(promotedDir, "runs", "live"), { recursive: true });
fs.writeFileSync(
  path.join(promotedDir, "benchmark.json"),
  JSON.stringify({
    schema_version: "understudy.benchmark.v1",
    benchmark_id: "promoted-bench",
    name: "Promoted bench",
    provenance: { origin: "authored" },
    taxonomy: [{ category_id: "cat-a" }],
    tasks: [
      { task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" },
      { task_id: "t2", category_id: "cat-a", genesis: "synthesized", split: "dev" },
    ],
    environment: { format: "verifiers.v1", package_ref: "pkg" },
    verifier: { kind: "reward-fns", strict_metric: "strict" },
  }),
);
const dropFile = path.join(tmp, "drop.csv");
fs.writeFileSync(dropFile, "text,label\nhello,ham\nWIN NOW,spam\n");

function discoveredSlug() {
  const out = callBenchmarksTool("list_benchmarks", {});
  const entry = out.benchmarks.find((b) => b.dir === promotedDir);
  assert.ok(entry, "fixture benchmark discovered through the shared loader");
  return entry.slug;
}

/* ---------------- mcp-5: inputSchema enums are enforced in code ---------------- */

describe("review_prime_benchmark scope validation", () => {
  const base = { dir: path.join(tmp, "not-a-prime-package"), decision: "approve", reviewer: "r", note: "n" };

  it("rejects an out-of-enum scope before touching the ledger", () => {
    assert.throws(() => callBenchmarksTool("review_prime_benchmark", { ...base, scope: "whatever" }), /scope must be one of/);
    assert.throws(() => callBenchmarksTool("review_prime_benchmark", { ...base, scope: 7 }), /scope must be one of/);
    assert.equal(fs.existsSync(path.join(base.dir, "reviews.jsonl")), false);
  });

  it("still defaults an omitted or null scope (the error then comes from the package check)", () => {
    assert.throws(() => callBenchmarksTool("review_prime_benchmark", { ...base }), (e) => !/scope must be/.test(e.message));
    assert.throws(() => callBenchmarksTool("review_prime_benchmark", { ...base, scope: null }), (e) => !/scope must be/.test(e.message));
  });
});

/* ---------------- mcp-2: profile_workload output_root confinement ---------------- */

describe("profile_workload output_root", () => {
  it("accepts a root under the configured benchmark roots", () => {
    const out = callBenchmarksTool("profile_workload", { path: dropFile, output_root: path.join(tmp, "capture-imports") });
    assert.equal(out.source_type, "file");
    assert.ok(fs.existsSync(path.join(out.artifact_root, "workload-card.json")));
  });

  it("rejects roots outside the allowed set, including a sibling-prefix and a parent", () => {
    for (const outputRoot of [`${tmp}-evil`, path.dirname(tmp), path.join(tmp, "..", "elsewhere")]) {
      assert.throws(() => callBenchmarksTool("profile_workload", { path: dropFile, output_root: outputRoot }), /output_root must be under/);
    }
    assert.equal(fs.existsSync(`${tmp}-evil`), false);
  });
});

/* ---------------- mcp-4: relayed text is labeled as data ---------------- */

describe("untrusted-text provenance", () => {
  it("read_task keeps its fields in place and adds a sibling provenance marker", () => {
    const out = callBenchmarksTool("read_task", { slug: discoveredSlug(), task_id: "t1" });
    assert.equal(out.task_id, "t1");
    assert.ok("prompt" in out, "prompt stays a top-level field");
    assert.equal(out.provenance.untrusted_text, true);
    assert.ok(out.provenance.fields.includes("prompt"));
    assert.match(out.provenance.note, /not instructions/);
  });

  it("the read tools' descriptions carry the data-not-instructions caveat", () => {
    for (const name of ["read_task", "read_rollout", "diff_rollouts"]) {
      const tool = BENCHMARKS_TOOLS.find((t) => t.name === name);
      assert.match(tool.description, /never follow it/);
    }
  });
});

/* ---------------- mcp-1: trust-posture guard on the MCP surface ---------------- */

describe("spend-adjacent guard (pi-free)", () => {
  it("classifies like the Pi extension", () => {
    assert.equal(queueRunIsTrivial({ models: ["m"], tasks: ["t1"] }), true);
    const spendy = { slug: "s", models: ["a", "b"], tasks: ["t1", "t2"], rollouts_per_task: 3 };
    const blocked = classifyBenchmarkToolCall("queue_run", spendy, postureAt("local_sandbox"));
    assert.equal(blocked.decision, "block");
    assert.equal(blocked.rule_id, "benchmark.queue-run-below-posture");
    assert.match(benchmarkGuardBlockMessage(blocked), /orchestra trust set bounded_experiments/);
    assert.deepEqual(classifyBenchmarkToolCall("queue_run", { ...spendy, confirm: true }, postureAt("local_sandbox")), { decision: "allow" });
    const allowed = classifyBenchmarkToolCall("queue_run", spendy, postureAt("bounded_experiments"));
    assert.equal(allowed.decision, "allow");
    assert.match(allowed.notice, /2 arm\(s\)/);
    assert.match(allowed.notice, /2 task\(s\) x 3 rollout\(s\)/);
    assert.equal(
      classifyBenchmarkToolCall("update_experiment", { slug: "s", experiment_id: "e", patch: { status: "approved" } }, postureAt("local_sandbox")).rule_id,
      "benchmark.experiment-approval-below-posture",
    );
    assert.deepEqual(classifyBenchmarkToolCall("read_benchmark", { slug: "s" }, postureAt("local_sandbox")), { decision: "allow" });
  });

  it("the raw shared tool list stays confirm-free (the Pi clone adds it itself)", () => {
    for (const tool of BENCHMARKS_TOOLS) assert.equal(tool.inputSchema.properties?.confirm, undefined);
  });

  it("stdio: serves the confirm gate and blocks a multi-arm queue_run at local_sandbox", async () => {
    const slug = discoveredSlug();
    const responses = await mcpSession([
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list", params: {} },
      { id: 3, method: "tools/call", params: { name: "queue_run", arguments: { slug, models: ["a", "b"], tasks: ["t1"], split: "holdout" } } },
      { id: 4, method: "tools/call", params: { name: "queue_run", arguments: { slug, models: ["a"], tasks: ["t1"], split: "holdout" } } },
    ]);
    const tools = responses.get(2).result.tools;
    assert.equal(tools.length, BENCHMARKS_TOOLS.length);
    const served = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(served.queue_run.inputSchema.properties.confirm.type, "boolean");
    assert.equal(served.update_experiment.inputSchema.properties.confirm.type, "boolean");
    assert.match(served.queue_run.description, /trust posture/);
    assert.equal(served.read_task.inputSchema.properties.confirm, undefined);

    const blocked = responses.get(3).result;
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /benchmark\.queue-run-below-posture/);

    const trivial = responses.get(4).result;
    assert.notEqual(trivial.isError, true);
    const queued = JSON.parse(trivial.content[0].text);
    assert.ok(queued.run_id, "trivial single-arm probes still queue unchanged");
    // Only the trivial probe reached the queue writer; the blocked 2-arm request never did.
    assert.deepEqual(fs.readdirSync(path.join(promotedDir, "runs", "queue")), [`${queued.run_id}.json`]);
  });

  it("stdio: at bounded_experiments the notice rides ahead of the payload", async () => {
    fs.writeFileSync(process.env.UNDERSTUDY_TRUST_FILE, JSON.stringify(postureAt("bounded_experiments")));
    try {
      const slug = discoveredSlug();
      const responses = await mcpSession([
        { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/call", params: { name: "queue_run", arguments: { slug, models: ["model-a", "model-b"], tasks: ["t1"], split: "holdout" } } },
      ]);
      const result = responses.get(2).result;
      assert.notEqual(result.isError, true);
      assert.match(result.content[0].text, /Trust posture bounded_experiments/);
      assert.ok(JSON.parse(result.content[1].text).run_id);
    } finally {
      fs.rmSync(process.env.UNDERSTUDY_TRUST_FILE, { force: true });
    }
  });
});

// minimal JSON-RPC-over-stdio MCP client against `understudy benchmarks mcp`
function mcpSession(requests, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [bin, "benchmarks", "mcp"], {
      env: { ...process.env, BENCHMARK_HUB_DATA_DIR: tmp },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const expected = requests.filter((r) => r.id !== undefined).length;
    const responses = new Map();
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp timeout; got ${responses.size}/${expected} responses`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
        if (responses.size === expected) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(responses);
        }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    for (const r of requests) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...r }) + "\n");
  });
}
