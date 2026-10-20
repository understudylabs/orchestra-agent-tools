import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { traceFoundryViewer } from "../dist/trace-foundry-viewer.js";
import { serveTraceFoundry } from "../dist/trace-foundry-server.js";

function benchmarkFixture() {
  const root = mkdtempSync(join(tmpdir(), "understudy-foundry-security-"));
  const viewer = join(root, "benchmark", "viewer");
  mkdirSync(join(viewer, "data", "captures"), { recursive: true });
  writeFileSync(join(viewer, "index.html"), "<!doctype html><title>benchmark orchard</title>");
  writeFileSync(join(viewer, "data", "captures", "one.json"), JSON.stringify({ capture_id: "one" }));
  writeFileSync(join(root, "secret.txt"), "outside-the-viewer");
  symlinkSync(join(root, "secret.txt"), join(viewer, "escape.json"));
  writeFileSync(join(viewer, "notes.txt"), "plain text");
  return { root, benchmark: join(root, "benchmark") };
}

// fetch() silently drops a caller-supplied Host header, so raw http is used to send one verbatim.
function statusWithHost(port, host) {
  return new Promise((resolvePromise, reject) => {
    const headers = host === undefined ? {} : { host };
    const req = request({ host: "127.0.0.1", port, path: "/", headers, setHost: false }, (message) => { message.resume(); resolvePromise(message.statusCode); });
    req.on("error", reject);
    req.end();
  });
}

test("trace foundry server rejects non-loopback Host headers and symlink escapes", async () => {
  const { benchmark } = benchmarkFixture();
  const server = serveTraceFoundry(benchmark, 0);
  await once(server, "listening");
  try {
    const port = server.address().port, base = `http://127.0.0.1:${port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200, "loopback Host keeps serving the viewer (tmpdir may sit behind a symlink)");
    assert.match(await page.text(), /benchmark orchard/);
    const capture = await fetch(`${base}/data/captures/one.json`);
    assert.equal(capture.status, 200);
    assert.equal(capture.headers.get("content-type"), "application/json");

    for (const host of ["evil.example:3003", "127.0.0.1.evil.example", "localhost.evil.example"]) {
      assert.equal(await statusWithHost(port, host), 403, `Host ${host} must be refused`);
    }
    // Node's parser rejects a missing Host before the handler runs (400); either way it must not be served.
    assert.notEqual(await statusWithHost(port, undefined), 200, "missing Host must be refused");
    for (const host of ["localhost:3003", "[::1]:3003", "127.0.0.1", "LOCALHOST"]) {
      assert.equal(await statusWithHost(port, host), 200, `Host ${host} must be accepted`);
    }

    const escaped = await fetch(`${base}/escape.json`);
    assert.equal(escaped.status, 403, "symlink inside viewer/ pointing outside is refused");

    const other = await fetch(`${base}/notes.txt`);
    assert.equal(other.status, 200);
    assert.equal(other.headers.get("content-type"), "application/octet-stream", "unknown extensions are not served as html");
  } finally {
    server.close();
  }
});

test("trace foundry viewer escapes quotes and avoids inline id handlers", () => {
  const tasks = [{ task_id: "task-ab'\"<x>", title: "t", status: "draft", candidate_boundary: "n1", source: { node_ids: ["n1"], edges: [] }, tool_surface: [] }];
  const nodes = [{ id: "n1", capture_id: "c1", captured_at: "2026-07-20T00:00:00Z", message_count: 1 }];
  const viewer = traceFoundryViewer({ tasks, nodes, issues: [], captures: {}, benchmark: {} });
  assert.doesNotMatch(viewer, /onclick="pick(Task|Node)\(/, "task and node buttons use data attributes, not inline handlers");
  assert.match(viewer, /data-task-id=/);
  assert.match(viewer, /data-node-id=/);
  assert.match(viewer, /"'":'&#39;'/, "esc maps the single quote");
  assert.doesNotMatch(viewer, /fonts\.googleapis\.com/, "viewer does not load remote fonts");
  const script = viewer.slice(viewer.indexOf("<script>") + 8, viewer.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "generated viewer script parses");
});
