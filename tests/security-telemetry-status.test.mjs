import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { trackRunStarted, trackStatusChecked } from "../dist/internal/telemetry.js";

// Telemetry must never affect CLI behavior: a corrupt or unwritable
// ~/.understudy/telemetry.json must not throw from awaited trackers nor
// reject from the void-tracked ones.
describe("telemetry robustness against a corrupt state file", () => {
  let root;
  let previousHome;
  let previousUserProfile;
  let previousTelemetry;
  let previousFetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "understudy-telemetry-sec-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousTelemetry = process.env.UNDERSTUDY_TELEMETRY;
    previousFetch = globalThis.fetch;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.UNDERSTUDY_TELEMETRY;
    mkdirSync(join(root, ".understudy"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(root, ".understudy", "credentials.json"),
      JSON.stringify({
        api_key: "sk_test_telemetry",
        gateway_url: "https://api.understudylabs.test",
        orgs: {},
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousTelemetry === undefined) delete process.env.UNDERSTUDY_TELEMETRY;
    else process.env.UNDERSTUDY_TELEMETRY = previousTelemetry;
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  });

  it("regenerates the install id and still sends when telemetry.json is truncated JSON", async () => {
    const statePath = join(root, ".understudy", "telemetry.json");
    writeFileSync(statePath, '{"install_id": "abc', "utf8");
    const bodies = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    };

    await assert.doesNotReject(trackStatusChecked({ configured: true, signedIn: true }));

    assert.equal(bodies.length, 1);
    assert.match(bodies[0].install_id, /^[0-9a-f-]{36}$/);
    const healed = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(healed.install_id, bodies[0].install_id);
  });

  it("does not throw when telemetry.json is a directory and cannot be rewritten", async () => {
    mkdirSync(join(root, ".understudy", "telemetry.json"));
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };

    await assert.doesNotReject(trackStatusChecked({ configured: true, signedIn: true }));
    assert.equal(calls, 1);
  });

  it("void-tracked run events never surface as unhandled rejections", async () => {
    writeFileSync(join(root, ".understudy", "telemetry.json"), "not json", "utf8");
    globalThis.fetch = async () => new Response(null, { status: 204 });
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      trackRunStarted({
        apiKey: "sk_test_telemetry",
        gatewayUrl: "https://api.understudylabs.test",
        commandKind: "sh",
        orgId: null,
        projectSlug: null,
        authSource: "env",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    assert.deepEqual(rejections, []);
  });
});
