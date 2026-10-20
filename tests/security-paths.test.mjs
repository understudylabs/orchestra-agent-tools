import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { submitReview, submitTaskFeedback } from "../dist/benchmark-hub-core.js";
import { routeSnapshotPath } from "../dist/internal/workloads.js";
import { resolveGatewayAuth } from "../dist/trace-author.js";

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "security-paths-"));
  tmpDirs.push(dir);
  return dir;
}

test("routeSnapshotPath accepts gateway-shaped ids and rejects path segments", () => {
  const ok = routeSnapshotPath("proj_1", "usp_classify");
  assert.ok(ok.endsWith(path.join(".understudy", "routes", "proj_1", "usp_classify", "last-route.json")));
  for (const [projectId, workloadId] of [
    ["../../../tmp", "usp_x"],
    ["proj_1", "usp_/../../../../tmp/evil"],
    ["..", "usp_x"],
    ["proj_1", "."],
    ["", "usp_x"],
    ["proj_1", ""],
  ]) {
    assert.throws(() => routeSnapshotPath(projectId, workloadId), /route snapshot path/);
  }
});

test("resolveGatewayAuth reads credentials through the shared schema", () => {
  const dir = tmpDir();
  const credentialsPath = path.join(dir, "credentials.json");
  // The org is selected from the nearest .understudy/config.json, so pin cwd
  // to a directory with no such ancestor (the repo root has one).
  const previous = process.cwd();
  process.chdir(dir);
  try {
    fs.writeFileSync(credentialsPath, JSON.stringify({ api_key: 42 }));
    assert.throws(() => resolveGatewayAuth({}, credentialsPath));

    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({ orgs: { org_1: { api_key: "key-1", gateway_url: "https://gw.example.test/" } } }),
    );
    assert.deepEqual(resolveGatewayAuth({}, credentialsPath), { baseUrl: "https://gw.example.test/v1", apiKey: "key-1" });

    assert.throws(() => resolveGatewayAuth({}, path.join(dir, "missing.json")), /Understudy gateway/);

    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        orgs: {
          org_1: { api_key: "key-1", gateway_url: "https://gw.example.test/" },
          org_2: { api_key: "key-2", gateway_url: "https://gw2.example.test" },
        },
      }),
    );
    assert.throws(() => resolveGatewayAuth({}, credentialsPath), /Multiple orgs/);
    fs.mkdirSync(path.join(dir, ".understudy"));
    fs.writeFileSync(path.join(dir, ".understudy", "config.json"), JSON.stringify({ org_id: "org_2", project_slug: "proj" }));
    assert.deepEqual(resolveGatewayAuth({}, credentialsPath), { baseUrl: "https://gw2.example.test/v1", apiKey: "key-2" });
  } finally {
    process.chdir(previous);
  }
});

test(
  "review and feedback appends create 0600 files",
  { skip: process.platform === "win32" },
  () => {
    const dir = path.join(tmpDir(), "prop");
    fs.mkdirSync(dir, { recursive: true });
    const task = {
      schema_version: "understudy.benchmark_task.v1",
      task_id: "t1",
      execution_group: "g1",
      title: "task t1",
      status: "machine_proposed",
      split: "construction",
      candidate_boundary: "b",
      machine_confidence: "high",
      close_call: false,
      tool_surface: [],
      outcome_contract: { required: [], preserved: [], forbidden: [], grading: "final_state" },
      world_model: {},
      source: { node_ids: [], edges: [], captures: [] },
      claims: [],
      sentinels: [],
      review: { decision: "pending" },
    };
    const entry = {
      kind: "proposed",
      slug: "data--prop",
      source: "data-dir",
      readOnly: false,
      dir,
      manifestPath: path.join(dir, "manifest.json"),
      foundry: { schema_version: "understudy.trace_foundry.v1" },
      tasks: [task],
      dag: null,
      captureIndex: [],
    };
    const previousUmask = process.umask(0o022);
    try {
      assert.equal(submitReview(entry, { task_id: "t1", decision: "accept", note: "private note" }).ok, true);
      assert.equal(submitTaskFeedback(entry, { task_id: "t1", feedback: "private feedback" }).ok, true);
    } finally {
      process.umask(previousUmask);
    }
    for (const name of ["reviews.jsonl", "feedback.jsonl"]) {
      const mode = fs.statSync(path.join(dir, name)).mode & 0o777;
      assert.equal(mode, 0o600, `${name} mode ${mode.toString(8)}`);
    }
  },
);
