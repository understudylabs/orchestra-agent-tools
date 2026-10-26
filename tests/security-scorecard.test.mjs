import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverPrimeScorecards, isLoopbackHost, startPrimeScorecardServer } from "../dist/prime-scorecard-server.js";

function syntheticRoot() {
  const root = mkdtempSync(join(tmpdir(), "understudy-scorecard-security-"));
  mkdirSync(join(root, "demo-v1", "viewer"), { recursive: true });
  writeFileSync(
    join(root, "demo-v1", "viewer", "index.html"),
    '<html><script>const D={"benchmark_id":"demo-v1","name":"Demo Bench","rollouts":[1,2],"verifier_version":"0.2.1"};\nlet selected=0;</script>PRIVATE-TRACE</html>',
  );
  return root;
}

function get(port, path, host) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("isLoopbackHost recognizes loopback names only", () => {
  for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["0.0.0.0", "::", "192.168.1.2", "evil.example", ""]) assert.equal(isLoopbackHost(host), false, host);
});

test("discoverPrimeScorecards skips dangling symlinks and plain files", () => {
  const root = syntheticRoot();
  symlinkSync(join(root, "does-not-exist"), join(root, "dangling"));
  writeFileSync(join(root, "stray-file"), "x");
  const entries = discoverPrimeScorecards(root);
  assert.deepEqual(entries.map((entry) => entry.slug), ["demo"]);
});

test("loopback scorecard server rejects non-loopback Host headers", async () => {
  const root = syntheticRoot();
  const { server, url } = await startPrimeScorecardServer(root, 0);
  try {
    const port = server.address().port;
    assert.equal(url, `http://127.0.0.1:${port}/`);

    const rebound = await get(port, "/b/demo/", "evil.example:4317");
    assert.equal(rebound.status, 403);
    assert.doesNotMatch(rebound.body, /PRIVATE-TRACE/);
    assert.equal((await get(port, "/", "evil.example")).status, 403);

    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const gallery = await get(port, "/", host);
      assert.equal(gallery.status, 200, host);
      assert.equal(gallery.headers["x-content-type-options"], "nosniff");
      assert.match(gallery.body, /Demo Bench/);
    }
    const viewer = await get(port, "/b/demo/", `127.0.0.1:${port}`);
    assert.equal(viewer.status, 200);
    assert.equal(viewer.headers["x-content-type-options"], "nosniff");
    assert.match(viewer.body, /PRIVATE-TRACE/);
    assert.equal((await get(port, "/missing", `127.0.0.1:${port}`)).status, 404);
    assert.equal((await get(port, "/b/%ZZ/", `127.0.0.1:${port}`)).status, 400);
  } finally {
    server.close();
  }
});
