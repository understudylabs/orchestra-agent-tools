// dspy-gepa climb controls, streaming, pricing and holdout evaluation, run against
// provider-free stand-ins for the pinned DSPy 3.4.1 / GEPA 0.1.4 runtime.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { writeMeteredDspyGepaStubs } from "./helpers/dspy-gepa-stubs.mjs";

const cli = ["node", resolve("dist/bin.js")];
const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;
const baseEnv = { ...process.env };
delete baseEnv.UNDERSTUDY_API_KEY;
delete baseEnv.UNDERSTUDY_GATEWAY_URL;
delete baseEnv.FORCE_COLOR;

const optimizeDir = (repo) => join(repo, ".understudy", "optimize-workload");
const runDir = (repo) => join(optimizeDir(repo), "dspy-gepa");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readCandidate = (repo) => readJson(join(optimizeDir(repo), "candidate.json"));

function run(args) {
  return spawnSync(cli[0], [cli[1], ...args], { cwd: process.cwd(), encoding: "utf8", env: baseEnv });
}

function withRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), "understudy-dspy-gepa-"));
  try {
    const samplesPath = join(repo, "samples.json");
    writeFileSync(samplesPath, JSON.stringify([{ question: "q1", answer: "a1" }, { question: "q2", answer: "a2" }]));
    return fn({ repo, samplesPath });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function writeSamples(repo, name, rows) {
  const path = join(repo, name);
  writeFileSync(path, JSON.stringify(rows));
  return path;
}

const holdoutRows = (labels = ["a1", "a2", "a2", "a2"]) => [
  { question: "q1", answer: labels[0], split: "train" },
  { question: "q2", answer: labels[1], split: "dev" },
  { question: "q3", answer: labels[2], split: "holdout" },
  { question: "q4", answer: labels[3], split: "holdout" },
];

const defaultSpendArgs = ["--budget-usd", "0.05", "--input-usd-per-million", "1", "--output-usd-per-million", "2"];
const roomySpendArgs = ["--budget-usd", "0.5", "--input-usd-per-million", "1", "--output-usd-per-million", "2"];

// Writes the runtime with the CLI, then runs it directly against the stubs.
function runDspyGepa(repo, samplesPath, extraArgs = [], extraEnv = {}, spendArgs = defaultSpendArgs) {
  const scaffold = run([
    "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa", "--samples", samplesPath,
    "--input-keys", "question", "--output-keys", "answer", "--model", "synthetic-deployment",
    "--reflection-model", "synthetic-reflection-deployment",
  ]);
  assert.equal(scaffold.status, 1);
  const runtime = join(optimizeDir(repo), "uv-runtime", "optimizer_runtime.py");
  const stubRoot = join(repo, "metered-python-stubs");
  if (!existsSync(stubRoot)) writeMeteredDspyGepaStubs(stubRoot);
  const sentinel = join(repo, "provider-call-count");
  const gepaKwargsPath = join(repo, "gepa-kwargs.json");
  const result = spawnSync("python3", [
    runtime, "dspy-gepa", "--repo", repo, "--samples", samplesPath, "--input-keys", "question",
    "--output-keys", "answer", "--model", "synthetic-deployment",
    "--reflection-model", "synthetic-reflection-deployment", "--max-metric-calls", "2", "--track-stats", "true",
    ...spendArgs, ...extraArgs,
  ], {
    encoding: "utf8",
    env: {
      ...baseEnv,
      PYTHONPATH: stubRoot,
      PROVIDER_SENTINEL: sentinel,
      GEPA_KWARGS_PATH: gepaKwargsPath,
      UNDERSTUDY_API_KEY: "fixture-key",
      UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
      UNDERSTUDY_AUTH_SOURCE: "fixture",
      ...extraEnv,
    },
  });
  const seen = () => readJson(gepaKwargsPath);
  return { result, sentinel, runtime, seen, payload: () => JSON.parse(result.stdout) };
}

function readEvents(repo) {
  const path = join(runDir(repo), "events.jsonl");
  const text = readFileSync(path, "utf8");
  return { path, text, events: text.trim().split("\n").map((line) => JSON.parse(line)) };
}

// Loads the generated runtime as a module and prints one JSON value from a script.
function runtimeScript(runtime, body, env = baseEnv) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rt", sys.argv[1])
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)
${body}
`;
  const result = spawnSync("python3", ["-c", script, runtime], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// A stand-in for the Understudy gateway's /v1/models, run as a child process
// because spawnSync blocks this process's event loop.
function withMockGateway(models, fn) {
  const dir = mkdtempSync(join(tmpdir(), "understudy-mock-gateway-"));
  const portFile = join(dir, "port");
  const server = spawn("python3", ["-c", `
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
MODELS = json.loads(sys.argv[2])
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body = json.dumps({"object": "list", "data": MODELS}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
httpd = HTTPServer(("127.0.0.1", 0), Handler)
open(sys.argv[1], "w").write(str(httpd.server_port))
httpd.serve_forever()
`, portFile, JSON.stringify(models)], { stdio: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(portFile) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(existsSync(portFile), "mock gateway did not start");
    return fn(`http://127.0.0.1:${readFileSync(portFile, "utf8").trim()}`);
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

const cliBase = (repo, samplesPath) => [
  "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa", "--samples", samplesPath,
  "--input-keys", "question", "--output-keys", "answer", "--model", "synthetic-deployment",
  "--reflection-model", "synthetic-reflection-deployment", "--execute",
];

describe("dspy-gepa adapter on the DSPy 3.4 engine seam", () => {
  it("meters at the engine with separate student and reflection output caps", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const first = runDspyGepa(repo, samplesPath);
      assert.equal(first.result.status, 0, first.result.stderr);
      const payload = first.payload();
      // Student and reflection each default to 2048 output tokens so reasoning
      // students and GEPA's structured JSON proposals are not truncated.
      assert.deepEqual(payload.spend_evidence.entries.map((entry) => entry.output_token_ceiling), [2048, 2048]);
      assert.deepEqual(payload.spend_evidence.entries.map((entry) => entry.role), ["student", "reflection"]);
      const candidate = readCandidate(repo);
      assert.equal(candidate.max_tokens, 2048);
      assert.equal(candidate.reflection_max_tokens, 2048);
      const config = readJson(join(runDir(repo), "config.json"));
      assert.equal(config.inference.reflection_max_tokens, 2048);

      const capped = runDspyGepa(mkdtempSync(join(repo, "caps-")), samplesPath, [
        "--max-tokens", "256", "--reflection-max-tokens", "512",
      ]);
      assert.equal(capped.result.status, 0, capped.result.stderr);
      assert.deepEqual(capped.payload().spend_evidence.entries.map((entry) => entry.output_token_ceiling), [256, 512]);
    }));

  it("records evolved instructions, gepa stats and main's deterministic GEPA controls", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, seen } = runDspyGepa(repo, samplesPath, [
        "--reflection-minibatch-size", "5", "--reflection-temperature", "0.5", "--num-threads", "4",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const kwargs = seen();
      assert.equal(kwargs.gepa.reflection_minibatch_size, 5);
      assert.equal(kwargs.gepa.num_threads, 4);
      assert.equal(kwargs.gepa.track_stats, true);
      assert.equal(kwargs.reflection_lm_kwargs.temperature, 0.5);
      assert.equal(kwargs.reflection_lm_kwargs.max_tokens, 2048);
      assert.equal(kwargs.reflection_model, "openai/synthetic-reflection-deployment");
      assert.equal(kwargs.compiles[0].use_cloudpickle, true);
      const candidate = readCandidate(repo);
      assert.deepEqual(candidate.baseline_instructions, { predict: "seed instruction" });
      assert.deepEqual(candidate.optimized_instructions, { predict: "evolved instruction" });
      assert.equal(candidate.instructions_changed, true);
      assert.deepEqual(candidate.gepa_stats, {
        split: "dev",
        num_candidates: 2,
        best_candidate_index: 1,
        baseline_val_score: 0.25,
        best_val_score: 0.75,
        total_metric_calls: 2,
        num_full_val_evals: 2,
      });
      assert.equal(candidate.search.rounds, 1);
      assert.equal(candidate.search.match_mode, "exact");
    }));

  it("fails closed and stops calling when a response reports zero usage", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, sentinel, payload } = runDspyGepa(repo, samplesPath, [], { STUB_ZERO_USAGE: "1" });
      assert.equal(result.status, 5, result.stderr);
      assert.equal(payload().status, "spend-evidence-error");
      assert.equal(payload().reason, "provider-usage-missing");
      assert.equal(payload().spend_evidence.usage_complete, false);
      assert.equal(payload().spend_evidence.entries[0].status, "usage-missing");
      assert.equal(readFileSync(sentinel, "utf8").trim().split("\n").length, 1);
    }));

  it("reports budget-blocked when DSPy wraps the budget error raised inside the engine", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, sentinel, payload } = runDspyGepa(repo, samplesPath, [], {}, [
        "--budget-usd", "0.000001", "--input-usd-per-million", "1", "--output-usd-per-million", "2",
      ]);
      assert.equal(result.status, 4, result.stderr);
      assert.equal(existsSync(sentinel), false);
      assert.equal(payload().status, "budget-blocked");
      assert.equal(payload().reason, "next-call-reservation-exceeds-budget");
      assert.equal(payload().spend_evidence.calls_attempted, 0);
    }));

  it("blocks every later call once one reservation was refused, even if the evaluator swallowed it", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const seen = runtimeScript(runtime, `
ledger = rt.SpendLedger(0.01, 1, 2)
first = ledger.reserve(10, 10)
try:
    ledger.reserve(10_000_000, 10)
except rt.SpendBudgetExceeded:
    pass
try:
    ledger.reserve(1, 1)
    later = "allowed"
except rt.SpendBudgetExceeded:
    later = "blocked"
print(json.dumps({"first": first, "later": later, "attempted": ledger.evidence()["calls_attempted"]}))
`);
      assert.deepEqual(seen, { first: 1, later: "blocked", attempted: 1 });
    }));
});

describe("dspy-gepa holdout evaluation and match mode", () => {
  it("scores baseline and optimized once on the holdout, after the candidate is frozen", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      const { result, payload } = runDspyGepa(repo, samples, ["--evaluate-holdout"], {}, roomySpendArgs);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(payload().holdout_count_excluded, 2);
      assert.equal(payload().holdout_evaluation.status, "complete");
      assert.equal(payload().holdout_evaluation.count, 2);
      assert.equal("rows" in payload().holdout_evaluation, false);
      // baseline + reflection, then 2 baseline and 2 optimized holdout calls.
      assert.equal(payload().spend_evidence.calls_attempted, 6);

      // The candidate was written before any holdout row was scored and is not rewritten.
      const candidatePath = join(optimizeDir(repo), "candidate.json");
      const candidate = readJson(candidatePath);
      assert.equal(candidate.holdout_evaluation_requested, true);
      assert.equal("holdout_evaluation" in candidate, false);
      assert.equal(candidate.spend_evidence.calls_attempted, 2);
      const evaluation = readJson(join(runDir(repo), "holdout-evaluation.json"));
      assert.equal(statSync(join(runDir(repo), "holdout-evaluation.json")).mode & 0o777, 0o600);
      assert.equal(evaluation.used_for_selection, false);
      assert.equal(evaluation.candidate_sha256, payload().candidate_sha256);
      assert.equal(evaluation.config_sha256, payload().config_sha256);
      assert.deepEqual(evaluation.baseline, { score: 0, errors: 0, by_match: { exact: 0, "case-insensitive": 0 } });
      assert.deepEqual(evaluation.optimized, { score: 1, errors: 0, by_match: { exact: 1, "case-insensitive": 1 } });
      assert.equal(evaluation.delta, 1);
      assert.deepEqual(evaluation.rows[0], {
        expected: { answer: "a2" },
        baseline: { answer: "a1" },
        optimized: { answer: "a2" },
        baseline_score: 0,
        optimized_score: 1,
      });
      // Inputs stay out of the artifact; only labels and predictions are kept.
      assert.equal(JSON.stringify(evaluation).includes("q3"), false);
      const proof = readJson(join(optimizeDir(repo), "proof-packet.json"));
      assert.equal(proof.holdout_accessed_during_optimization, false);
      assert.equal(proof.holdout_evaluated_after_optimization, true);
      assert.equal(proof.candidate_sha256, payload().candidate_sha256);
      assert.equal(proof.holdout_evaluation.delta, 1);
    }));

  it("does not touch holdout rows unless --evaluate-holdout is set", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      const { result, payload } = runDspyGepa(repo, samples);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(payload().holdout_evaluation, null);
      assert.equal(payload().spend_evidence.calls_attempted, 2);
      assert.equal(existsSync(join(runDir(repo), "holdout-evaluation.json")), false);
      const proof = readJson(join(optimizeDir(repo), "proof-packet.json"));
      assert.equal(proof.holdout_evaluated_after_optimization, false);
    }));

  it("keeps the frozen candidate when the budget stops mid holdout evaluation", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      const prices = ["--input-usd-per-million", "1", "--output-usd-per-million", "2"];
      const env = { STUB_OUTPUT_TOKENS: "1000" };
      const probe = runDspyGepa(mkdtempSync(join(repo, "probe-")), samples, ["--evaluate-holdout"], env, [
        "--budget-usd", "10", ...prices,
      ]);
      // Completed calls settle to their attributed cost, so a call is blocked when
      // the cost so far plus its own reservation crosses the cap. Pick a cap that
      // admits the two optimization calls and blocks the first holdout call.
      const entries = probe.payload().spend_evidence.entries;
      const spentBefore = (index) => entries.slice(0, index).reduce((sum, entry) => sum + entry.attributed_cost_usd, 0);
      const holdoutStart = 2;
      const budget = spentBefore(holdoutStart) + entries[holdoutStart].reserved_upper_bound_usd * 0.99;
      for (let index = 0; index < holdoutStart; index += 1) {
        assert.ok(spentBefore(index) + entries[index].reserved_upper_bound_usd <= budget);
      }
      const { result, payload } = runDspyGepa(repo, samples, ["--evaluate-holdout"], env, [
        "--budget-usd", String(budget), ...prices,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(payload().status, "candidate-created");
      assert.equal(payload().holdout_evaluation.status, "incomplete-budget");
      assert.equal(payload().holdout_evaluation.baseline, null);
      assert.equal(readCandidate(repo).instructions_changed, true);
    }));

  it("settles each completed call's reservation to its attributed cost when usage reports nothing extra", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      const { result, payload } = runDspyGepa(repo, samples, ["--evaluate-holdout"]);
      assert.equal(result.status, 0, result.stderr);
      const evidence = payload().spend_evidence;
      assert.equal(evidence.reservations_are_cumulative, false);
      assert.equal(evidence.reservation_policy, "settle-completed-calls-to-billable-usage-bound");
      for (const entry of evidence.entries) assert.equal(entry.settled_upper_bound_usd, entry.attributed_cost_usd);
      assert.ok(evidence.calls_completed > 2);
      assert.ok(Math.abs(evidence.reserved_upper_bound_usd - evidence.attributed_cost_usd) < 1e-12);
      const reservedTotal = evidence.entries.reduce((sum, entry) => sum + entry.reserved_upper_bound_usd, 0);
      assert.ok(reservedTotal > evidence.reserved_upper_bound_usd * 10);
    }));

  it("rejects --evaluate-holdout before any provider call when there are no holdout rows", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, sentinel, payload } = runDspyGepa(repo, samplesPath, ["--evaluate-holdout"]);
      assert.equal(result.status, 3, result.stderr);
      assert.equal(existsSync(sentinel), false);
      assert.equal(payload().status, "error");
      assert.equal(payload().reason, "invalid-runtime-input");
      assert.equal(payload().provider_calls, false);
    }));

  it("scores letter case separately: --match-mode picks the metric and both are reported", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      // The optimized stub answers "a2" and the baseline "a1"; the labels are "A2".
      const samples = writeSamples(repo, "cased-samples.json", holdoutRows(["A1", "A2", "A2", "A2"]));
      const exact = runDspyGepa(repo, samples, ["--evaluate-holdout"], {}, roomySpendArgs);
      assert.equal(exact.result.status, 0, exact.result.stderr);
      const exactEval = readJson(join(runDir(repo), "holdout-evaluation.json"));
      assert.equal(exactEval.match_mode, "exact");
      assert.deepEqual(exactEval.optimized.by_match, { exact: 0, "case-insensitive": 1 });
      assert.deepEqual(exactEval.baseline.by_match, { exact: 0, "case-insensitive": 0 });
      assert.equal(exactEval.optimized.score, 0);

      const lenientRepo = mkdtempSync(join(repo, "ci-"));
      const lenient = runDspyGepa(lenientRepo, samples, ["--evaluate-holdout", "--match-mode", "case-insensitive"], {}, roomySpendArgs);
      assert.equal(lenient.result.status, 0, lenient.result.stderr);
      const lenientEval = readJson(join(runDir(lenientRepo), "holdout-evaluation.json"));
      assert.equal(lenientEval.metric, "case_insensitive_match");
      assert.equal(lenientEval.optimized.score, 1);
      assert.equal(lenientEval.delta, 1);
      assert.equal(readCandidate(lenientRepo).search.match_mode, "case-insensitive");
      // The match mode is hash-bound into the run config.
      assert.equal(readJson(join(runDir(lenientRepo), "config.json")).evaluation.match_mode, "case-insensitive");
    }));

  it("explains a letter-case miss in the feedback and honors the match mode", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const seen = runtimeScript(runtime, `
from types import SimpleNamespace
gold = SimpleNamespace(urgency="low")
def check(predicted, mode):
    result = rt.exact_match_feedback(["urgency"], gold, SimpleNamespace(urgency=predicted), mode)
    return [result.score, result.feedback]
print(json.dumps({
    "case_exact": check("Low", "exact"),
    "case_ci": check("Low", "case-insensitive"),
    "spaces_ci": check("  LOW  ", "case-insensitive"),
    "inner_spaces": rt.normalize_label("a   B\\tc", "case-insensitive"),
    "wrong": check("high", "case-insensitive"),
    "match": check("low", "exact"),
}))
`, { ...baseEnv, PYTHONPATH: join(repo, "metered-python-stubs") });
      assert.equal(seen.case_exact[0], 0);
      assert.match(seen.case_exact[1], /expected 'low', got 'Low' \(differs only in letter case\)/);
      assert.deepEqual(seen.case_ci, [1, "All output fields matched."]);
      assert.equal(seen.spaces_ci[0], 1);
      assert.equal(seen.inner_spaces, "a b c");
      assert.equal(seen.wrong[0], 0);
      assert.doesNotMatch(seen.wrong[1], /letter case/);
      assert.equal(seen.match[0], 1);
    }));
});

describe("dspy-gepa spend prices", () => {
  it("prices reflection calls with their own basis", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, payload } = runDspyGepa(repo, samplesPath, [
        "--reflection-input-usd-per-million", "3", "--reflection-output-usd-per-million", "4",
      ]);
      assert.equal(result.status, 0, result.stderr);
      const [student, reflection] = payload().spend_evidence.entries;
      assert.equal(student.price_source, "global");
      assert.equal(reflection.price_source, "reflection-flag");
      assert.equal(reflection.input_usd_per_million, 3);
      assert.equal(reflection.output_usd_per_million, 4);
      // 10 input + 5 output tokens: student at $1/$2, reflection at $3/$4 per million.
      assert.ok(Math.abs(student.attributed_cost_usd - 0.00002) < 1e-12);
      assert.ok(Math.abs(reflection.attributed_cost_usd - 0.00005) < 1e-12);
      assert.equal(payload().spend_evidence.reflection_price_basis.input_usd_per_million, 3);
      assert.ok(reflection.reserved_upper_bound_usd > student.reserved_upper_bound_usd);
      const config = readJson(join(runDir(repo), "config.json"));
      assert.deepEqual(config.inference.prices.reflection, [3, 4]);
      assert.equal(config.inference.price_basis_scope, "per-call-resolved-reflection-model-gateway-global");
    }));

  it("prices each model from --model-price, the gateway, then the global basis", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) =>
      withMockGateway(
        [{ id: "synthetic-deployment", pricing: { input_usd_per_million: 7, output_usd_per_million: 9 } }],
        (gatewayUrl) => {
          const gatewayEnv = { UNDERSTUDY_GATEWAY_URL: gatewayUrl };
          const first = runDspyGepa(repo, samplesPath, [
            "--reflection-input-usd-per-million", "3", "--reflection-output-usd-per-million", "4",
          ], gatewayEnv, roomySpendArgs);
          assert.equal(first.result.status, 0, first.result.stderr);
          const evidence = first.payload().spend_evidence;
          const [student, reflection] = evidence.entries;
          assert.equal(student.price_source, "gateway");
          assert.equal(student.input_usd_per_million, 7);
          assert.equal(reflection.price_source, "reflection-flag");
          assert.equal(evidence.gateway_price_lookup.status, "ok");
          assert.deepEqual(evidence.gateway_price_lookup.models_priced, ["synthetic-deployment"]);
          assert.equal(evidence.gateway_price_basis["synthetic-deployment"].source, "understudy-gateway");

          const flagged = runDspyGepa(mkdtempSync(join(repo, "flag-")), samplesPath, [
            "--model-price", "synthetic-deployment=11,12",
          ], gatewayEnv, roomySpendArgs);
          assert.equal(flagged.result.status, 0, flagged.result.stderr);
          assert.equal(flagged.payload().spend_evidence.entries[0].price_source, "model-flag");
          assert.equal(flagged.payload().spend_evidence.entries[0].input_usd_per_million, 11);

          const off = runDspyGepa(mkdtempSync(join(repo, "off-")), samplesPath, [
            "--prices-from-gateway", "off",
          ], gatewayEnv);
          assert.equal(off.result.status, 0, off.result.stderr);
          assert.equal(off.payload().spend_evidence.entries[0].price_source, "global");
          assert.equal(off.payload().spend_evidence.gateway_price_lookup.status, "off");
        },
      ),
    ));

  it("falls back to the global basis when the gateway publishes no prices", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) =>
      withMockGateway([{ id: "synthetic-deployment" }], (gatewayUrl) => {
        const { result, payload } = runDspyGepa(repo, samplesPath, [], { UNDERSTUDY_GATEWAY_URL: gatewayUrl });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(payload().spend_evidence.gateway_price_lookup.status, "no-prices-published");
        assert.equal(payload().spend_evidence.entries[0].price_source, "global");
        assert.equal(payload().spend_evidence.price_basis.source, "user-supplied");
      }),
    ));

  it("reads every supported gateway price shape and never raises on a bad gateway", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const shapes = runtimeScript(runtime, `
shape = rt.parse_gateway_price
print(json.dumps({
    "per_million": shape({"id": "a", "pricing": {"input_usd_per_million": 1.5, "output_usd_per_million": 6}}),
    "per_token": shape({"id": "b", "pricing": {"prompt": "0.000002", "completion": 0.00001}}),
    "top_level": shape({"id": "c", "input_usd_per_million": 2, "output_usd_per_million": 3}),
    "none": shape({"id": "d"}),
    "zero": shape({"id": "e", "pricing": {"input_usd_per_million": 0, "output_usd_per_million": 0}}),
    "negative": shape({"id": "f", "pricing": {"input_usd_per_million": -1, "output_usd_per_million": 2}}),
    "junk": shape({"id": "g", "pricing": {"input_usd_per_million": "abc", "output_usd_per_million": None}}),
    "unreachable": rt.fetch_gateway_prices("http://127.0.0.1:9", "k", {"a"}, timeout=2)[1]["status"],
    "credentialed_url": rt.fetch_gateway_prices("http://user:pw@127.0.0.1:9", "k", {"a"}, timeout=2)[1]["status"],
}))
`);
      assert.deepEqual(shapes.per_million, [1.5, 6]);
      assert.ok(Math.abs(shapes.per_token[0] - 2) < 1e-9 && Math.abs(shapes.per_token[1] - 10) < 1e-9);
      assert.deepEqual(shapes.top_level, [2, 3]);
      for (const key of ["none", "zero", "negative", "junk"]) assert.equal(shapes[key], null, key);
      assert.equal(shapes.unreachable, "unavailable");
      assert.equal(shapes.credentialed_url, "unavailable");
    }));

  it("refuses to start when no price source covers a model, before any provider call", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const missing = runDspyGepa(repo, samplesPath, [], {}, ["--budget-usd", "0.5"]);
      assert.equal(missing.result.status, 3, missing.result.stderr);
      assert.equal(existsSync(missing.sentinel), false);
      assert.equal(missing.payload().status, "error");
      assert.equal(missing.payload().provider_calls, false);

      const required = runDspyGepa(mkdtempSync(join(repo, "require-")), samplesPath, ["--prices-from-gateway", "require"]);
      assert.equal(required.result.status, 3, required.result.stderr);
      assert.equal(required.payload().provider_calls, false);
    }));

  it("runs without the spend cap when --no-spend-ledger is set, still recording usage", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, payload } = runDspyGepa(repo, samplesPath, ["--no-spend-ledger"], {}, []);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(payload().spend_enforcement, "none");
      const evidence = payload().spend_evidence;
      assert.equal(evidence.spend_enforcement, "none");
      assert.equal(evidence.approved_budget_usd, null);
      assert.equal(evidence.price_basis, null);
      assert.equal(evidence.unpriced_calls, 2);
      assert.deepEqual(
        evidence.entries.map((entry) => [entry.input_tokens, entry.output_tokens, entry.attributed_cost_usd]),
        [[10, 5, null], [10, 5, null]],
      );
      assert.equal(readJson(join(optimizeDir(repo), "proof-packet.json")).spend_enforcement, "none");

      // Without the cap, missing usage is recorded instead of failing the run.
      const zero = runDspyGepa(mkdtempSync(join(repo, "zero-")), samplesPath, ["--no-spend-ledger"], { STUB_ZERO_USAGE: "1" }, [
        "--input-usd-per-million", "1", "--output-usd-per-million", "2",
      ]);
      assert.equal(zero.result.status, 0, zero.result.stderr);
      assert.equal(zero.payload().spend_evidence.usage_complete, false);
      assert.deepEqual(zero.payload().spend_evidence.entries.map((entry) => entry.status), ["usage-missing", "usage-missing"]);
    }));

  it("rejects contradictory or malformed spend and search flags before touching auth", () =>
    withRepo(({ repo, samplesPath }) => {
      const prices = ["--input-usd-per-million", "1", "--output-usd-per-million", "2"];
      const seedInsideRun = join(runDir(repo), "best-so-far.json");
      mkdirSync(runDir(repo), { recursive: true });
      writeFileSync(seedInsideRun, JSON.stringify({ instructions: { predict: "x" } }));
      const cases = [
        [["--no-spend-ledger", "--budget-usd", "1"], /cannot be combined with --no-spend-ledger/],
        [["--budget-usd", "1", "--model-price", "synthetic-deployment=oops"], /--model-price must look like/],
        [["--budget-usd", "1", "--prices-from-gateway", "sometimes"], /--prices-from-gateway must be one of/],
        [["--budget-usd", "1"], /--input-usd-per-million is required/],
        [["--budget-usd", "1", "--model-price", "other-model=1,2"], /--input-usd-per-million is required/],
        [["--budget-usd", "1", ...prices, "--reflection-input-usd-per-million", "3"], /must be supplied together/],
        [["--budget-usd", "1", ...prices, "--match-mode", "fuzzy"], /--match-mode must be one of: exact, case-insensitive/],
        [["--budget-usd", "1", ...prices, "--rounds", "0"], /--rounds must be a positive integer/],
        [["--budget-usd", "1", ...prices, "--max-minutes", "-1"], /--max-minutes must be a positive number/],
        [["--budget-usd", "1", ...prices, "--seed-instructions", join(repo, "missing.json")], /--seed-instructions must point to an existing regular file/],
        [["--budget-usd", "1", ...prices, "--seed-instructions", seedInsideRun], /--seed-instructions must not point inside \.understudy\/optimize-workload or the --log-dir/],
        [["--budget-usd", "1", ...prices, "--seed-instructions", samplesPath, "--log-dir", repo], /--seed-instructions must not point inside/],
        [["--budget-usd", "1", ...prices, "--dev-split", "Holdout"], /--train-split and --dev-split must not name the holdout split/],
        [["--budget-usd", "1", ...prices, "--train-split", "holdout"], /--train-split and --dev-split must not name the holdout split/],
        [["--budget-usd", "1", ...prices, "--train-split", "dev"], /--train-split and --dev-split must differ/],
      ];
      for (const [extra, pattern] of cases) {
        const result = run([...cliBase(repo, samplesPath), ...extra]);
        assert.notEqual(result.status, 0, extra.join(" "));
        assert.match(result.stderr, pattern, extra.join(" "));
        assert.doesNotMatch(result.stderr, /login|api key|uv run/i, extra.join(" "));
      }
    }));

  it("refuses built-in-only flags and the observe-only ledger for program bridges", () =>
    withRepo(({ repo }) => {
      const bridge = join(repo, "bridge.py");
      const bridgeConfig = join(repo, "bridge-config.json");
      writeFileSync(bridge, "\n");
      writeFileSync(bridgeConfig, JSON.stringify({ schema_version: "understudy.dspy_gepa_bridge_config.v1" }));
      const base = [
        "optimize-workload", "adapter", "run", "--repo", repo, "--adapter", "dspy-gepa",
        "--program-bridge", bridge, "--program-bridge-config", bridgeConfig, "--admission-only",
        "--model", "student", "--reflection-model", "reflection", "--execute",
      ];
      const prices = ["--budget-usd", "1", "--input-usd-per-million", "1", "--output-usd-per-million", "2"];
      for (const [extra, pattern] of [
        [["--no-spend-ledger"], /--no-spend-ledger is not supported with --program-bridge/],
        [[...prices, "--evaluate-holdout"], /--evaluate-holdout is not supported with --program-bridge/],
        [[...prices, "--match-mode", "case-insensitive"], /--match-mode is not supported with --program-bridge/],
        [[...prices, "--seed-instructions", bridgeConfig], /--seed-instructions is not supported with --program-bridge/],
      ]) {
        const result = run([...base, ...extra]);
        assert.notEqual(result.status, 0, extra.join(" "));
        assert.match(result.stderr, pattern, extra.join(" "));
      }
    }));
});

describe("dspy-gepa spend ledger settlement", () => {
  it("keeps the reservation for tokens billed outside output_tokens and cache writes outside input_tokens", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const seen = runtimeScript(runtime, `
from types import SimpleNamespace as NS
def usage(**fields):
    # lm15 Usage: every counter present, None when the provider did not report it.
    base = {"input_tokens": None, "output_tokens": None, "total_tokens": None, "cache_read_tokens": None,
            "cache_write_tokens": None, "reasoning_tokens": None}
    return NS(**{**base, **fields})
def settle(reported, ceiling=(10000, 1000)):
    ledger = rt.SpendLedger(1.0, 1.0, 2.0)
    call = ledger.reserve(*ceiling, {"role": "student", "requested_model": "m"})
    try:
        ledger.complete(call, NS(usage=reported))
    except rt.SpendEvidenceError as error:
        return {"error": str(error), "failure": str(ledger.failure)}
    entry = ledger.entries[0]
    return {
        "attributed": entry["attributed_cost_usd"],
        "settled": entry["settled_upper_bound_usd"],
        "reserved": entry["reserved_upper_bound_usd"],
        "billable": [entry["billable_input_tokens"], entry["billable_output_tokens"]],
        "ledger_reserved": ledger.reserved_upper_bound_usd,
        "ledger_attributed": ledger.attributed_cost_usd,
    }
print(json.dumps({
    "openai_plain": settle({"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}),
    "lm15_plain": settle(usage(input_tokens=100, output_tokens=50, total_tokens=150)),
    # Gemini and xAI: output excludes reasoning, the total includes it.
    "reasoning_in_total": settle(usage(input_tokens=100, output_tokens=50, total_tokens=400, reasoning_tokens=250)),
    "reasoning_no_total": settle({"prompt_tokens": 100, "completion_tokens": 50, "completion_tokens_details": {"reasoning_tokens": 200}}),
    # lm15 fills an unreported total as input + output, so it says nothing more.
    "reasoning_autofilled_total": settle(usage(input_tokens=100, output_tokens=50, total_tokens=150, reasoning_tokens=200)),
    # Anthropic: input excludes cache writes.
    "cache_write": settle(usage(input_tokens=100, output_tokens=50, total_tokens=150, cache_write_tokens=300)),
    "cache_write_nested": settle({"prompt_tokens": 100, "completion_tokens": 50, "prompt_tokens_details": {"cache_write_tokens": 300}}),
    "total_exceeds_output_cap": settle(usage(input_tokens=10, output_tokens=50, total_tokens=400), (10000, 100)),
    # Reasoning reported beside completion_tokens is not an overrun (OpenAI counts it
    # inside completion_tokens), but the settled bound keeps it, capped at the reservation.
    "reasoning_capped": settle({"prompt_tokens": 10, "completion_tokens": 50, "completion_tokens_details": {"reasoning_tokens": 200}}, (20, 100)),
}))
`);
      const price = (input, output) => (input + 2 * output) / 1e6;
      const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-15, `${label}: ${actual} != ${expected}`);
      for (const name of ["openai_plain", "lm15_plain"]) {
        near(seen[name].settled, price(100, 50), name);
        near(seen[name].attributed, price(100, 50), name);
        near(seen[name].ledger_reserved, seen[name].ledger_attributed, name);
      }
      const keeps = {
        reasoning_in_total: [100, 300],
        reasoning_no_total: [100, 250],
        reasoning_autofilled_total: [100, 250],
        cache_write: [400, 50],
        cache_write_nested: [400, 50],
      };
      for (const [name, [input, output]] of Object.entries(keeps)) {
        assert.deepEqual(seen[name].billable, [input, output], name);
        near(seen[name].settled, price(input, output), name);
        near(seen[name].ledger_reserved, price(input, output), name);
        // Attribution still prices the reported counters, and never exceeds the bound.
        near(seen[name].attributed, price(100, 50), name);
        assert.ok(seen[name].attributed < seen[name].settled, name);
      }
      assert.deepEqual(seen.total_exceeds_output_cap, {
        error: "provider-usage-exceeds-reservation",
        failure: "provider-usage-exceeds-reservation",
      });
      near(seen.reasoning_capped.settled, seen.reasoning_capped.reserved, "reasoning_capped");
      near(seen.reasoning_capped.ledger_reserved, price(20, 100), "reasoning_capped");
      near(seen.reasoning_capped.attributed, price(10, 50), "reasoning_capped");
    }));

  it("latches a refused reservation before releasing the lock, so a racing call cannot slip through", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const seen = runtimeScript(runtime, `
import threading
class HandoffLock:
    """Runs a second reservation in the gap right after the first one releases the lock."""
    def __init__(self):
        self.inner = threading.Lock()
        self.after_release = None
    def __enter__(self):
        self.inner.acquire()
        return self
    def __exit__(self, *exc):
        self.inner.release()
        hook, self.after_release = self.after_release, None
        if hook is not None:
            hook()
        return False
identity = {"role": "student", "requested_model": "m"}
out = {}
for case in ("blocked", "no-price"):
    ledger = rt.SpendLedger(1.0, 1.0, 2.0) if case == "blocked" else rt.SpendLedger(1.0, None, None)
    lock = HandoffLock()
    ledger._lock = lock
    if case == "no-price":
        # The racing call is priced; the first one has no price basis at all.
        ledger.model_prices["priced"] = (1.0, 2.0)
    racing = {"role": "student", "requested_model": "priced" if case == "no-price" else "m"}
    seen = {}
    def race():
        try:
            ledger.reserve(10, 10, racing)
            seen["racing"] = "reserved"
        except (rt.SpendBudgetExceeded, rt.SpendEvidenceError) as error:
            seen["racing"] = type(error).__name__
    lock.after_release = race
    try:
        ledger.reserve(10**9, 10**9, identity)
    except (rt.SpendBudgetExceeded, rt.SpendEvidenceError) as error:
        seen["first"] = type(error).__name__
    seen["calls_attempted"] = ledger.calls_attempted
    out[case] = seen
print(json.dumps(out))
`);
      assert.deepEqual(seen.blocked, { first: "SpendBudgetExceeded", racing: "SpendBudgetExceeded", calls_attempted: 0 });
      assert.deepEqual(seen["no-price"], { first: "SpendEvidenceError", racing: "SpendEvidenceError", calls_attempted: 0 });
    }));

  it("applies gateway prices only to routes whose bound base URL is the gateway's", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const seen = runtimeScript(runtime, `
gateway = "http://gateway.test"
claimed = {"inference_routes": {"student": {
    "route_id": "understudy-gateway", "base_url": "https://cheaper.example/v1", "api_key_env": "FIXTURE_KEY",
    "requested_model": "m", "executed_model": "openai/m",
}}}
default_route = rt.resolve_lm_route("student", "m", {}, gateway)[0]
claimed_route = rt.resolve_lm_route("student", "m", claimed, gateway)[0]
print(json.dumps({
    "default": sorted(rt.gateway_routed_roles({"student": default_route}, gateway)),
    "default_with_slash": sorted(rt.gateway_routed_roles({"student": default_route}, gateway + "/v1/")),
    "claimed": sorted(rt.gateway_routed_roles({"student": claimed_route, "reflection": default_route}, gateway)),
    "no_gateway": sorted(rt.gateway_routed_roles({"student": default_route}, None)),
    "bad_gateway": sorted(rt.gateway_routed_roles({"student": default_route}, "ftp://gateway.test")),
}))
`, { ...baseEnv, UNDERSTUDY_API_KEY: "fixture-key", FIXTURE_KEY: "fixture-key" });
      assert.deepEqual(seen.default, ["student"]);
      assert.deepEqual(seen.default_with_slash, ["student"]);
      // A bridge route may claim the gateway's route id, but not its base URL.
      assert.deepEqual(seen.claimed, ["reflection"]);
      assert.deepEqual(seen.no_gateway, []);
      assert.deepEqual(seen.bad_gateway, []);
    }));
});

describe("dspy-gepa splits, seeds and fixed-path artifacts", () => {
  it("refuses a train or dev split that names the holdout, or a dev split equal to train", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      for (const [extra, reason] of [
        [["--dev-split", "holdout"], "split-invalid: --train-split and --dev-split must not name the holdout split"],
        [["--dev-split", "Holdout", "--evaluate-holdout"], "split-invalid: --train-split and --dev-split must not name the holdout split"],
        [["--train-split", "HOLDOUT"], "split-invalid: --train-split and --dev-split must not name the holdout split"],
        [["--train-split", "dev"], "split-invalid: --train-split and --dev-split must differ"],
      ]) {
        const bad = runDspyGepa(mkdtempSync(join(repo, "bad-")), samples, extra);
        assert.equal(bad.result.status, 3, `${extra.join(" ")}: ${bad.result.stderr}`);
        assert.equal(bad.payload().reason, reason, extra.join(" "));
        assert.equal(bad.payload().provider_calls, false);
        assert.equal(existsSync(bad.sentinel), false, `${extra.join(" ")} reached the provider`);
      }
      const { runtime } = runDspyGepa(mkdtempSync(join(repo, "ok-")), samples);
      const overlap = runtimeScript(runtime, `
row = {"split": "holdout"}
try:
    rt.require_disjoint_holdout([row], [row])
    print(json.dumps("disjoint"))
except rt.SplitError as error:
    print(json.dumps(str(error)))
`);
      assert.equal(overlap, "split-invalid: holdout rows overlap the train or dev rows");
    }));

  it("refuses a seed the run itself rewrites, and resumes the identical command from a copied seed", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const first = runDspyGepa(repo, samplesPath);
      assert.equal(first.result.status, 0, first.result.stderr);
      const bestPath = join(runDir(repo), "best-so-far.json");
      const logSeed = join(repo, "custom-log", "seed.json");
      mkdirSync(join(repo, "custom-log"));
      writeFileSync(logSeed, readFileSync(bestPath));
      for (const extra of [
        ["--seed-instructions", bestPath],
        ["--seed-instructions", join(optimizeDir(repo), "candidate.json")],
        ["--seed-instructions", logSeed, "--log-dir", join(repo, "custom-log")],
      ]) {
        const refused = runDspyGepa(repo, samplesPath, extra);
        assert.equal(refused.result.status, 3, refused.result.stderr);
        assert.match(refused.payload().reason, /^seed-instructions-inside-run-artifacts: copy the seed file out of/);
        assert.equal(refused.payload().provider_calls, false);
      }
      const seed = join(repo, "seed.json");
      writeFileSync(seed, readFileSync(bestPath));
      const seededArgs = ["--seed-instructions", seed, "--log-dir", join(repo, "seeded-log")];
      const seeded = runDspyGepa(repo, samplesPath, seededArgs);
      assert.equal(seeded.result.status, 0, seeded.result.stderr);
      // The run rewrote best-so-far.json, but the copied seed is unchanged, so the
      // identical command resumes instead of stopping with resume-log-config-mismatch.
      const resumed = runDspyGepa(repo, samplesPath, seededArgs);
      assert.equal(resumed.result.status, 0, resumed.result.stderr);
      assert.equal(resumed.payload().config_sha256, seeded.payload().config_sha256);
    }));

  it("never lists an earlier run's holdout evaluation or best-so-far as this run's", { skip: !pythonAvailable }, () =>
    withRepo(({ repo }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      const holdoutPath = join(runDir(repo), "holdout-evaluation.json");
      const bestPath = join(runDir(repo), "best-so-far.json");
      const first = runDspyGepa(repo, samples, ["--evaluate-holdout", "--log-dir", join(repo, "log-1")], {}, roomySpendArgs);
      assert.equal(first.result.status, 0, first.result.stderr);
      assert.equal(first.payload().artifacts.holdout_evaluation_path, ".understudy/optimize-workload/dspy-gepa/holdout-evaluation.json");
      const firstBest = readJson(bestPath);
      assert.equal(firstBest.config_sha256, first.payload().config_sha256);
      assert.equal(typeof firstBest.run_id, "string");

      // A later run without --evaluate-holdout: the old evaluation is gone and unlisted,
      // and the other config's best-so-far was cleared before this run's was written.
      const secondArgs = ["--log-dir", join(repo, "log-2")];
      const second = runDspyGepa(repo, samples, secondArgs, {}, roomySpendArgs);
      assert.equal(second.result.status, 0, second.result.stderr);
      assert.equal(existsSync(holdoutPath), false);
      assert.equal("holdout_evaluation_path" in second.payload().artifacts, false);
      assert.equal(readJson(bestPath).config_sha256, second.payload().config_sha256);
      const runIds = () => [...new Set(readEvents(repo).events.map((event) => event.run_id))];
      const clearedIn = (runId) => readEvents(repo).events.some((event) => event.run_id === runId && event.event === "best-so-far-cleared");
      assert.equal(clearedIn(runIds().at(-1)), true);

      // Resuming the same config keeps its best-so-far.
      const resumed = runDspyGepa(repo, samples, secondArgs, {}, roomySpendArgs);
      assert.equal(resumed.result.status, 0, resumed.result.stderr);
      assert.equal(clearedIn(runIds().at(-1)), false);

      // A run that fails before optimizing lists neither fixed-path file.
      writeFileSync(holdoutPath, JSON.stringify({ stale: true }));
      const failed = runDspyGepa(repo, samples, ["--log-dir", join(repo, "log-3"), "--dev-split", "holdout"], {}, roomySpendArgs);
      assert.equal(failed.result.status, 3, failed.result.stderr);
      assert.equal(existsSync(bestPath), true);
      assert.equal("holdout_evaluation_path" in failed.payload().artifacts, false);
      assert.equal("best_so_far_path" in failed.payload().artifacts, false);
    }));
});

describe("dspy-gepa streaming", () => {
  it("streams an event log, live run state and best-so-far while the run is in progress", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, seen, payload } = runDspyGepa(repo, samplesPath);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(payload().events_path, ".understudy/optimize-workload/dspy-gepa/events.jsonl");
      assert.equal(payload().artifacts.events_path, ".understudy/optimize-workload/dspy-gepa/events.jsonl");

      // While the optimizer was still running, the run state and event log already existed.
      const live = seen();
      assert.deepEqual(live.live_run_state, { status: "running", phase: "optimizing" });
      assert.equal(live.callback_count, 1);
      for (const name of ["run-started", "data-loaded", "phase", "call-completed"]) {
        assert.ok(live.live_events.includes(name), `${name} was not on disk mid-run`);
      }
      assert.equal(live.live_events.includes("run-finished"), false);

      const { path, events, text } = readEvents(repo);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
      assert.equal(new Set(events.map((event) => event.run_id)).size, 1);
      const names = events.map((event) => event.event);
      assert.equal(names[0], "run-started");
      assert.equal(names.at(-1), "run-finished");
      assert.deepEqual(
        events.filter((event) => event.event === "phase").map((event) => event.name),
        ["baseline", "optimizing", "optimization-finished"],
      );
      for (const name of [
        "gepa-started", "gepa-proposal", "gepa-valset-evaluated", "gepa-candidate-accepted",
        "gepa-candidate-rejected", "gepa-error", "gepa-finished", "round-started", "round-finished",
      ]) {
        assert.ok(names.includes(name), `missing ${name}`);
      }
      const calls = events.filter((event) => event.event === "call-completed");
      assert.deepEqual(calls.map((call) => [call.call_id, call.role, call.input_tokens, call.output_tokens]), [
        [1, "student", 10, 5],
        [2, "reflection", 10, 5],
      ]);
      assert.ok(calls[1].attributed_cost_usd > calls[0].attributed_cost_usd);
      assert.equal(events[0].spend_enforcement, "ledger");
      assert.equal(events[0].approved_budget_usd, 0.05);

      // Counts, scores, token usage and instruction text only: no sample inputs,
      // no credentials, no route URLs.
      for (const secret of ["q1", "q2", "fixture-key", "127.0.0.1"]) {
        assert.equal(text.includes(secret), false, `event log leaked ${secret}`);
      }

      const best = readJson(join(runDir(repo), "best-so-far.json"));
      assert.equal(statSync(join(runDir(repo), "best-so-far.json")).mode & 0o777, 0o600);
      assert.equal(best.average_score, 0.75);
      assert.equal(best.split, "dev");
      assert.deepEqual(best.instructions, { predict: "evolved instruction" });
      const runState = readJson(join(runDir(repo), "run-state.json"));
      assert.equal(runState.status, "candidate-created");
      assert.equal(runState.phase, "finished");
    }));

  it("streams holdout progress and ends a failed run's log with run-failed", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const samples = writeSamples(repo, "holdout-samples.json", holdoutRows());
      const holdout = runDspyGepa(repo, samples, ["--evaluate-holdout"], {}, roomySpendArgs);
      assert.equal(holdout.result.status, 0, holdout.result.stderr);
      const { events } = readEvents(repo);
      const progress = events.filter((event) => event.event === "holdout-progress");
      assert.deepEqual(
        progress.filter((event) => event.done === event.total).map((event) => [event.program, event.running_score]),
        [["baseline", 0], ["optimized", 1]],
      );
      assert.ok(events.some((event) => event.event === "phase" && event.name === "evaluating-holdout"));

      const failedRepo = mkdtempSync(join(repo, "failed-"));
      const failed = runDspyGepa(failedRepo, samplesPath, [], { STUB_ZERO_USAGE: "1" });
      assert.equal(failed.result.status, 5, failed.result.stderr);
      const last = readEvents(failedRepo).events.at(-1);
      assert.equal(last.event, "run-failed");
      assert.equal(last.reason, "provider-usage-missing");
      assert.equal(last.phase, "baseline");
      const runState = readJson(join(runDir(failedRepo), "run-state.json"));
      assert.equal(runState.status, "spend-evidence-error");
      assert.equal(runState.phase, "baseline");

      const blockedRepo = mkdtempSync(join(repo, "blocked-"));
      const blocked = runDspyGepa(blockedRepo, samplesPath, [], {}, [
        "--budget-usd", "0.000001", "--input-usd-per-million", "1", "--output-usd-per-million", "2",
      ]);
      assert.equal(blocked.result.status, 4, blocked.result.stderr);
      const blockedEvents = readEvents(blockedRepo).events;
      assert.ok(blockedEvents.some((event) => event.event === "budget-blocked" && event.approved_budget_usd === 0.000001));
      assert.equal(blockedEvents.at(-1).status, "budget-blocked");
    }));

  it("prints live progress lines to stderr only when --progress is set", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const quiet = runDspyGepa(repo, samplesPath);
      assert.equal(quiet.result.status, 0, quiet.result.stderr);
      assert.equal(quiet.result.stderr.trim(), "");

      const loud = runDspyGepa(mkdtempSync(join(repo, "loud-")), samplesPath, ["--progress"]);
      assert.equal(loud.result.status, 0, loud.result.stderr);
      const lines = loud.result.stderr.trim().split("\n");
      assert.match(lines[0], /^\[\d\d:\d\d\] run-started /);
      assert.ok(lines.some((line) => /phase: optimizing/.test(line)));
      assert.ok(lines.some((line) => /call 1 student synthetic-deployment in=10 out=5 \| spend \$/.test(line)));
      assert.ok(lines.some((line) => /candidate 1 val score 0\.750 \(new best\)/.test(line)));
      assert.match(lines.at(-1), /run-finished/);
      assert.equal(loud.payload().status, "candidate-created");
    }));

  it("passes --progress to the runtime and inherits stderr only when asked", () =>
    withRepo(({ repo, samplesPath }) => {
      const fakeBin = join(repo, "fake-bin");
      const uvArgsPath = join(repo, "uv-args.txt");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "uv"), `#!/bin/sh
printf '%s\\n' "$@" > "$UV_ARGS_SENTINEL"
echo "progress-line" >&2
printf '%s\\n' '{"schema_version":"fixture.uv.v1","status":"fixture-ok"}'
`, { encoding: "utf8", mode: 0o755 });
      const env = {
        ...baseEnv,
        PATH: `${fakeBin}:${baseEnv.PATH}`,
        UV_ARGS_SENTINEL: uvArgsPath,
        UNDERSTUDY_API_KEY: "fixture-key",
        UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
        UNDERSTUDY_TELEMETRY: "0",
      };
      const args = [...cliBase(repo, samplesPath), "--budget-usd", "1", "--input-usd-per-million", "1", "--output-usd-per-million", "2"];
      const quiet = spawnSync(cli[0], [cli[1], ...args], { encoding: "utf8", env });
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.equal(readFileSync(uvArgsPath, "utf8").includes("--progress"), false);
      const loud = spawnSync(cli[0], [cli[1], ...args, "--progress"], { encoding: "utf8", env });
      assert.equal(loud.status, 0, loud.stderr);
      assert.equal(readFileSync(uvArgsPath, "utf8").trim().split("\n").at(-1), "--progress");
      assert.match(loud.stderr, /progress-line/);
      assert.equal(JSON.parse(loud.stdout).status, "fixture-ok");
    }));
});

describe("dspy-gepa climb controls", () => {
  it("always arms the stop file and adds only the stoppers and strategies that were asked for", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const plain = runDspyGepa(repo, samplesPath);
      assert.equal(plain.result.status, 0, plain.result.stderr);
      const [defaults] = plain.seen().compiles;
      assert.deepEqual(defaults.stoppers.map((stopper) => stopper[0]), ["FileStopper"]);
      assert.ok(defaults.stoppers[0][1].endsWith("/dspy-gepa/STOP"));
      assert.equal(defaults.sampling, null);
      assert.equal(defaults.proposer, null);
      assert.equal(defaults.candidate_selection, "pareto");
      assert.equal(defaults.use_merge, false);

      const skillDir = join(repo, "guidance-skill");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "SKILL.md"), "Prefer short imperative instructions.");
      const tunedRepo = mkdtempSync(join(repo, "tuned-"));
      const tuned = runDspyGepa(tunedRepo, samplesPath, [
        "--stop-after-stale", "5", "--stop-at-score", "0.95", "--max-minutes", "2",
        "--proposals-per-iteration", "3", "--candidate-selection-strategy", "current_best", "--use-merge", "true",
        "--proposer-skill", skillDir, "--proposer-note", "Use imperative voice.", "--proposer-max-chars", "800",
      ]);
      assert.equal(tuned.result.status, 0, tuned.result.stderr);
      const [config] = tuned.seen().compiles;
      assert.deepEqual(config.stoppers.slice(1), [
        ["NoImprovementStopper", 5],
        ["ScoreThresholdStopper", 0.95],
        ["TimeoutStopCondition", 120],
      ]);
      assert.deepEqual(config.sampling, ["IndependentSampling", 3]);
      assert.deepEqual(config.selection, ["BestImprovement"]);
      assert.equal(config.acceptance, "strict_improvement");
      assert.equal(config.candidate_selection, "current_best");
      assert.equal(config.use_merge, true);
      assert.deepEqual(config.proposer, {
        skills: [realpathSync(skillDir)],
        additional_instructions: "Use imperative voice.",
        max_chars: 800,
      });
      // The settings are hash-bound into the config and recorded with the candidate.
      const search = readCandidate(tunedRepo).search;
      assert.equal(search.proposals_per_iteration, 3);
      assert.equal(search.stop_after_stale, 5);
      assert.equal(search.proposer_skills.length, 1);
      assert.equal(search.proposer_skills[0].sha256.length, 64);
      assert.deepEqual(readJson(join(runDir(tunedRepo), "config.json")).search, search);
    }));

  it("climbs in rounds from the previous best, each round in its own log dir, until a round stops gaining", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { result, seen } = runDspyGepa(repo, samplesPath, ["--rounds", "4"]);
      assert.equal(result.status, 0, result.stderr);
      const { compiles } = seen();
      // Round 2 starts from round 1's best prompt, gains nothing, and ends the climb.
      assert.deepEqual(compiles.map((compile) => compile.seed_instructions), ["seed instruction", "evolved instruction"]);
      assert.ok(compiles[0].log_dir.endsWith("/dspy-gepa/gepa-log"));
      assert.ok(compiles[1].log_dir.endsWith("/dspy-gepa/gepa-log/round-2"));
      const candidate = readCandidate(repo);
      assert.deepEqual(candidate.rounds.map((round) => [round.round, round.seed_val_score, round.best_val_score, round.gain]), [
        [1, 0.25, 0.75, 0.5],
        [2, 0.75, 0.75, 0],
      ]);
      assert.deepEqual(candidate.baseline_instructions, { predict: "seed instruction" });
      assert.deepEqual(candidate.optimized_instructions, { predict: "evolved instruction" });
      const names = readEvents(repo).events.map((event) => event.event);
      assert.equal(names.filter((name) => name === "round-started").length, 2);
      assert.equal(names.filter((name) => name === "round-finished").length, 2);

      // A changed climb setting no longer matches the bound resume log.
      const rebound = runDspyGepa(repo, samplesPath, ["--rounds", "3"]);
      assert.equal(rebound.result.status, 6, rebound.result.stderr);
      assert.equal(rebound.payload().reason, "resume-log-config-mismatch");
    }));

  it("warm starts from a previous run's instructions without changing the holdout baseline", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const seeds = {
        bestSoFar: { instructions: { predict: "from best-so-far" } },
        candidate: { optimized_instructions: { predict: "from candidate" } },
        mapping: { predict: "from mapping" },
      };
      for (const [name, payload] of Object.entries(seeds)) {
        const seedPath = join(repo, `${name}.json`);
        writeFileSync(seedPath, JSON.stringify(payload));
        const seededRepo = mkdtempSync(join(repo, `${name}-`));
        const seeded = runDspyGepa(seededRepo, samplesPath, ["--seed-instructions", seedPath]);
        assert.equal(seeded.result.status, 0, seeded.result.stderr);
        const [compile] = seeded.seen().compiles;
        assert.equal(compile.seed_instructions, Object.values(payload.instructions ?? payload.optimized_instructions ?? payload)[0]);
        const candidate = readCandidate(seededRepo);
        assert.deepEqual(candidate.baseline_instructions, { predict: "seed instruction" });
        assert.equal(candidate.search.seed_instructions.sha256.length, 64);
        assert.ok(readEvents(seededRepo).events.some((event) => event.event === "seeded"));
      }
      const textSeed = join(repo, "seed.txt");
      writeFileSync(textSeed, "plain text prompt");
      const text = runDspyGepa(mkdtempSync(join(repo, "text-")), samplesPath, ["--seed-instructions", textSeed]);
      assert.equal(text.seen().compiles[0].seed_instructions, "plain text prompt");
    }));

  it("ends the climb gracefully when the stop file appears, and clears a stale one at start", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      mkdirSync(runDir(repo), { recursive: true });
      writeFileSync(join(runDir(repo), "STOP"), "");
      const { result, payload } = runDspyGepa(repo, samplesPath, ["--rounds", "4"], { STUB_TOUCH_STOP_FILE: "1" });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readEvents(repo).events.some((event) => event.event === "stop-file-cleared"));
      const candidate = readCandidate(repo);
      assert.equal(candidate.rounds.length, 1);
      assert.equal(candidate.rounds[0].stopped_by_stop_file, true);
      assert.equal(payload().status, "candidate-created");
      assert.deepEqual(candidate.optimized_instructions, { predict: "evolved instruction" });
    }));

  it("rejects bad search settings in the runtime before any provider call", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const unknownSeed = join(repo, "unknown.json");
      writeFileSync(unknownSeed, JSON.stringify({ instructions: { nope: "x" } }));
      const skillDir = join(repo, "empty-skill");
      mkdirSync(skillDir);
      const cases = [
        ["--rounds", "0"],
        ["--proposals-per-iteration", "0"],
        ["--stop-at-score", "abc"],
        ["--max-minutes", "-1"],
        ["--min-round-gain", "-0.5"],
        ["--proposer-skill", join(repo, "nowhere.md")],
        ["--proposer-skill", skillDir],
        ["--seed-instructions", join(repo, "missing.json")],
        ["--seed-instructions", unknownSeed],
      ];
      for (const extra of cases) {
        const bad = runDspyGepa(mkdtempSync(join(repo, "bad-")), samplesPath, extra);
        assert.equal(bad.result.status, 3, `${extra.join(" ")}: ${bad.result.stderr}`);
        assert.equal(existsSync(bad.sentinel), false, `${extra.join(" ")} reached the provider`);
        assert.equal(bad.payload().status, "error");
        assert.equal(bad.payload().provider_calls, false);
      }
    }));

  it("reads every supported seed shape", { skip: !pythonAvailable }, () =>
    withRepo(({ repo, samplesPath }) => {
      const { runtime } = runDspyGepa(repo, samplesPath);
      const seen = runtimeScript(runtime, `
import tempfile
from pathlib import Path
def load(text):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        handle.write(text)
    try:
        return rt.load_seed_instructions(Path(handle.name))
    except ValueError as error:
        return "error: " + str(error)[:40]
print(json.dumps({
    "best": load(json.dumps({"instructions": {"p": "a"}, "average_score": 1})),
    "candidate": load(json.dumps({"optimized_instructions": {"p": "b"}})),
    "mapping": load(json.dumps({"p": "c"})),
    "text": load("  plain prompt  "),
    "empty": load("   "),
    "junk": load(json.dumps({"p": 3})),
    "list": load(json.dumps(["x"])),
}))
`);
      assert.deepEqual(seen.best, { p: "a" });
      assert.deepEqual(seen.candidate, { p: "b" });
      assert.deepEqual(seen.mapping, { p: "c" });
      assert.deepEqual(seen.text, { "*": "plain prompt" });
      assert.deepEqual(seen.empty, {});
      assert.match(seen.junk, /^error:/);
      assert.match(seen.list, /^error:/);
    }));

  it("forwards climb flags from the CLI to the runtime", () =>
    withRepo(({ repo, samplesPath }) => {
      const fakeBin = join(repo, "fake-bin");
      const uvArgsPath = join(repo, "uv-args.txt");
      mkdirSync(fakeBin);
      writeFileSync(join(fakeBin, "uv"), `#!/bin/sh
printf '%s\\n' "$@" > "$UV_ARGS_SENTINEL"
printf '%s\\n' '{"schema_version":"fixture.uv.v1","status":"fixture-ok"}'
`, { encoding: "utf8", mode: 0o755 });
      const seed = join(repo, "seed.txt");
      writeFileSync(seed, "seed");
      const result = spawnSync(cli[0], [cli[1], ...cliBase(repo, samplesPath),
        "--budget-usd", "1", "--input-usd-per-million", "1", "--output-usd-per-million", "2",
        "--reflection-input-usd-per-million", "3", "--reflection-output-usd-per-million", "4",
        "--model-price", "openai/synthetic-deployment=5,6", "--prices-from-gateway", "off",
        "--reflection-max-tokens", "4096", "--evaluate-holdout", "--match-mode", "case-insensitive",
        "--seed-instructions", seed, "--rounds", "3", "--min-round-gain", "0.02", "--stop-after-stale", "8",
        "--stop-at-score", "0.9", "--max-minutes", "5", "--proposals-per-iteration", "2",
        "--proposer-skill", seed, "--proposer-note", "terse", "--proposer-max-chars", "900",
      ], {
        encoding: "utf8",
        env: {
          ...baseEnv,
          PATH: `${fakeBin}:${baseEnv.PATH}`,
          UV_ARGS_SENTINEL: uvArgsPath,
          UNDERSTUDY_API_KEY: "fixture-key",
          UNDERSTUDY_GATEWAY_URL: "http://127.0.0.1:9",
          UNDERSTUDY_TELEMETRY: "0",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const uvArgs = readFileSync(uvArgsPath, "utf8").trim().split("\n");
      const flagValue = (flag) => uvArgs[uvArgs.indexOf(flag) + 1];
      assert.equal(flagValue("--model-price"), "synthetic-deployment=5,6");
      assert.equal(flagValue("--reflection-input-usd-per-million"), "3");
      assert.equal(flagValue("--prices-from-gateway"), "off");
      assert.equal(flagValue("--reflection-max-tokens"), "4096");
      assert.equal(flagValue("--match-mode"), "case-insensitive");
      assert.equal(flagValue("--seed-instructions"), seed);
      assert.equal(flagValue("--rounds"), "3");
      assert.equal(flagValue("--min-round-gain"), "0.02");
      assert.equal(flagValue("--stop-after-stale"), "8");
      assert.equal(flagValue("--stop-at-score"), "0.9");
      assert.equal(flagValue("--max-minutes"), "5");
      assert.equal(flagValue("--proposals-per-iteration"), "2");
      assert.equal(flagValue("--proposer-skill"), seed);
      assert.equal(flagValue("--proposer-note"), "terse");
      assert.equal(flagValue("--proposer-max-chars"), "900");
      assert.ok(uvArgs.includes("--evaluate-holdout"));
    }));
});
