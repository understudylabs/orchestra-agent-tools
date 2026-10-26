import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import test from "node:test";

import { startConversationSidecar } from "../dist/runtime/conversation/sidecar.js";

function send(port, { method = "GET", path = "/", headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode, body }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("sidecar did not answer")));
    req.on("error", reject);
    req.end();
  });
}

// Writes a raw request line so request targets Node's client would normalize reach the server verbatim.
function sendRaw(port, requestTarget) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolvePromise(raw));
    socket.setTimeout(2000, () => socket.destroy(new Error("sidecar did not answer")));
    socket.on("error", reject);
  });
}

async function withSidecar(run) {
  const token = randomBytes(32).toString("hex");
  const runtime = await startConversationSidecar({ port: 0, token });
  const port = Number(new URL(runtime.baseUrl).port);
  // A throw inside the async request handler would otherwise take down the test runner.
  const rejections = [];
  const onRejection = (reason) => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  try {
    await run({ port, token });
  } finally {
    process.off("unhandledRejection", onRejection);
    await runtime.close();
  }
  assert.deepEqual(rejections, []);
}

test("sidecar rejects missing, wrong, and same-length bearer tokens", async () => {
  await withSidecar(async ({ port, token }) => {
    assert.equal((await send(port, { method: "POST", path: "/v1/runs" })).status, 401);
    assert.equal(
      (await send(port, { method: "POST", path: "/v1/runs", headers: { authorization: "Bearer nope" } })).status,
      401,
    );
    const flipped = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    assert.equal(
      (await send(port, { method: "POST", path: "/v1/runs", headers: { authorization: `Bearer ${flipped}` } })).status,
      401,
    );
    assert.equal((await send(port, { method: "DELETE", path: "/v1/runs/x", headers: { authorization: token } })).status, 401);
    // The right token passes auth and reaches the handler (empty body -> 400, not 401).
    const accepted = await send(port, { method: "POST", path: "/v1/runs", headers: { authorization: `Bearer ${token}` } });
    assert.equal(accepted.status, 400);
    assert.equal((await send(port, { path: "/health" })).status, 200);
  });
});

test("sidecar answers malformed request targets with 400 before auth", async () => {
  await withSidecar(async ({ port }) => {
    for (const target of ["http://[::1", "//[::1", "//[", "http://%"]) {
      const raw = await sendRaw(port, target);
      assert.match(raw, /^HTTP\/1\.1 400 /, target);
      assert.match(raw, /"bad request"/, target);
    }
    assert.equal((await send(port, { path: "/health" })).status, 200);
  });
});

test("sidecar answers an undecodable run id with 400", async () => {
  await withSidecar(async ({ port, token }) => {
    const headers = { authorization: `Bearer ${token}` };
    assert.equal((await send(port, { method: "DELETE", path: "/v1/runs/%E0", headers })).status, 400);
    assert.equal((await send(port, { method: "DELETE", path: "/v1/runs/%E0" })).status, 401);
    assert.equal((await send(port, { method: "DELETE", path: "/v1/runs/missing", headers })).status, 404);
    assert.equal((await send(port, { path: "/health" })).status, 200);
  });
});
