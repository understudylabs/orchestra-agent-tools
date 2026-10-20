import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { daemonStatus, isLoopbackBaseUrl, readAgentCard } from "../dist/internal/daemon.js";

function writeCard(cardPath, app) {
  writeFileSync(
    cardPath,
    JSON.stringify({ schema_version: "understudy.agent_card.v1", app }, null, 2),
  );
}

describe("agent card base_url must be a loopback http origin", () => {
  let dir;
  let cardPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "understudy-daemon-sec-"));
    cardPath = join(dir, "agent-card.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("isLoopbackBaseUrl accepts only http://127.0.0.1[:port]", () => {
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1:17790"), true);
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1"), true);
    assert.equal(isLoopbackBaseUrl("https://127.0.0.1:17790"), false);
    assert.equal(isLoopbackBaseUrl("http://localhost:17790"), false);
    assert.equal(isLoopbackBaseUrl("http://example.invalid:80"), false);
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1:17790/api"), false);
    assert.equal(isLoopbackBaseUrl("http://user:pw@127.0.0.1:17790"), false);
    assert.equal(isLoopbackBaseUrl("http://127.0.0.1:17790?x=1"), false);
    assert.equal(isLoopbackBaseUrl("not a url"), false);
  });

  for (const base_url of ["http://example.invalid:80", "https://127.0.0.1:1", "http://localhost:1"]) {
    it(`refuses to probe ${base_url} even with a live pid`, async () => {
      writeCard(cardPath, { running: true, pid: process.pid, base_url });
      const status = await daemonStatus({ cardPath, timeoutMs: 200 });
      assert.equal(status.detected, true);
      assert.equal(status.running, false);
      assert.match(status.detail, /not a loopback/);
    });
  }

  it("treats a symlinked card as absent", async () => {
    const real = join(dir, "real.json");
    writeCard(real, { running: true, pid: process.pid, base_url: "http://127.0.0.1:1" });
    symlinkSync(real, cardPath);
    assert.equal(readAgentCard(cardPath), null);
    const status = await daemonStatus({ cardPath });
    assert.equal(status.detected, false);
    assert.match(status.detail, /no agent card/);
  });
});
