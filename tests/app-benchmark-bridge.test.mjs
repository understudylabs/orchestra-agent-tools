import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

// The app → benchmark spine bridge: the CLI's additive `--plain-dir`
// experiment mode (lineage next to a prepared dataset, before any benchmark
// exists) and the additive `runs queue --experiment` cross-link. The input
// shapes below mirror what the (since removed) desktop app sent.

const bin = path.resolve("dist/bin.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "app-benchmark-bridge-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const cli = (...args) => {
  const result = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const dataSelection = {
  selection_hash: "a".repeat(64),
  source: "support-tickets.csv",
  splits_sha256: "b".repeat(64),
};

const createInput = () => ({
  hypothesis:
    "sft training of answerdotai/ModernBERT-base on this Mac on dataset support-tickets.csv " +
    "beats its measured baseline on the frozen held-out split",
  status: "training",
  data_selection: dataSelection,
  training: {
    method: "sft",
    base_model: "answerdotai/ModernBERT-base",
    provider: "local",
    config: { task: "text_classification" },
    approvals: [],
  },
});

const providerSpendApproval = (approvedBy, at) => ({
  gate: "provider_training_spend",
  approved_by: approvedBy,
  at,
});

const concludedPatch = (verdict) => ({
  status: "concluded",
  verdict: { ...verdict, decided_at: new Date().toISOString() },
});

describe("CLI --plain-dir experiment lineage (dataset dir, no benchmark.json)", () => {
  const datasetDir = path.join(tmp, "dataset");
  fs.mkdirSync(datasetDir, { recursive: true });

  it("refuses a bare dir without --plain-dir (unchanged behavior)", () => {
    const result = cli("benchmarks", "experiment", "create", datasetDir, "--input", JSON.stringify(createInput()));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a benchmark dir/);
  });

  it("creates, updates (approvals append), and lists in a plain dir", () => {
    const created = cli(
      "benchmarks", "experiment", "create", datasetDir,
      "--plain-dir", "--input", JSON.stringify(createInput()),
    );
    assert.equal(created.status, 0, created.stderr);
    const experiment = JSON.parse(created.stdout);
    assert.equal(experiment.schema_version, "understudy.experiment.v1");
    assert.equal(experiment.status, "training");
    assert.equal(experiment.data_selection.selection_hash, dataSelection.selection_hash);
    assert.ok(fs.existsSync(path.join(datasetDir, "experiments.jsonl")));

    // The und-289 gate entry appends (never replaces) on update.
    const approval = providerSpendApproval("desktop-app:org:org_1", "2026-07-22T00:00:00Z");
    const updated = cli(
      "benchmarks", "experiment", "update", datasetDir, experiment.experiment_id,
      "--plain-dir", "--input", JSON.stringify({ training: { approvals: [approval] } }),
    );
    assert.equal(updated.status, 0, updated.stderr);
    const patched = JSON.parse(updated.stdout);
    assert.deepEqual(patched.training.approvals, [approval]);
    assert.equal(patched.training.base_model, "answerdotai/ModernBERT-base");

    // Conclude with the app's concludedPatch shape.
    const concluded = cli(
      "benchmarks", "experiment", "update", datasetDir, experiment.experiment_id,
      "--plain-dir", "--input", JSON.stringify(concludedPatch({ decision: "shadow", summary: "beats tf-idf" })),
    );
    assert.equal(concluded.status, 0, concluded.stderr);
    const final = JSON.parse(concluded.stdout);
    assert.equal(final.status, "concluded");
    assert.equal(final.verdict.decision, "shadow");
    // Approvals cleared earlier are never dropped by a later patch.
    assert.deepEqual(final.training.approvals, [approval]);

    const listed = cli("benchmarks", "experiment", "list", datasetDir);
    assert.equal(listed.status, 0, listed.stderr);
    const { experiments, total_lines } = JSON.parse(listed.stdout);
    assert.equal(experiments.length, 1);
    assert.equal(total_lines, 3);
    assert.equal(experiments[0].status, "concluded");
  });

  it("still validates records in plain-dir mode", () => {
    const result = cli(
      "benchmarks", "experiment", "create", datasetDir,
      "--plain-dir", "--input", JSON.stringify({ hypothesis: "" }),
    );
    assert.notEqual(result.status, 0);
  });
});

describe("runs queue --experiment cross-link", () => {
  const benchDir = path.join(tmp, "bench");
  fs.mkdirSync(benchDir, { recursive: true });
  fs.writeFileSync(
    path.join(benchDir, "benchmark.json"),
    JSON.stringify({
      schema_version: "understudy.benchmark.v1",
      benchmark_id: "bridge-bench",
      name: "Bridge bench",
      provenance: { origin: "authored" },
      taxonomy: [{ category_id: "cat-a" }],
      tasks: [{ task_id: "t1", category_id: "cat-a", genesis: "synthesized", split: "holdout" }],
      environment: { format: "verifiers.v1", package_ref: "pkg" },
      verifier: { kind: "reward-fns", strict_metric: "strict" },
    }),
  );

  it("rejects an experiment_id that is not in the benchmark's experiments.jsonl", () => {
    const result = cli(
      "runs", "queue", "--benchmark", benchDir,
      "--models", "glm-5.2", "--incumbent", "glm-5.2",
      "--experiment", "exp-missing",
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown experiment_id/);
  });

  it("queues the app's comparison shape once the experiment exists", () => {
    const created = cli(
      "benchmarks", "experiment", "create", benchDir,
      "--input", JSON.stringify({ ...createInput(), experiment_id: "exp-bridge-1" }),
    );
    assert.equal(created.status, 0, created.stderr);

    const armDir = path.join(tmp, "adapter");
    fs.mkdirSync(armDir, { recursive: true });
    const queued = cli(
      "runs", "queue", "--benchmark", benchDir,
      "--local-arm", `my-tuned-model=${armDir}`,
      "--models", "glm-5.2", "--incumbent", "glm-5.2",
      "--trivial-arms", "majority_class",
      "--experiment", "exp-bridge-1",
    );
    assert.equal(queued.status, 0, queued.stderr);
    const run = JSON.parse(queued.stdout);
    assert.equal(run.experiment_id, "exp-bridge-1");
    assert.equal(run.status, "queued");
    assert.ok(run.models.some((m) => typeof m === "object" && m.label === "my-tuned-model"));
    assert.deepEqual(run.incumbent_models, ["glm-5.2"]);
    assert.deepEqual(run.trivial_arms, ["majority_class"]);
    // The request landed in the file queue the executor watches.
    const queue = fs.readdirSync(path.join(benchDir, "runs", "queue"));
    assert.equal(queue.length, 1);
  });
});
