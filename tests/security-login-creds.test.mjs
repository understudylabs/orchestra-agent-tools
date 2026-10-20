import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const baseEnv = { ...process.env, UNDERSTUDY_TELEMETRY: "0" };
delete baseEnv.UNDERSTUDY_API_KEY;
delete baseEnv.UNDERSTUDY_GATEWAY_URL;
delete baseEnv.FORCE_COLOR;
const posix = process.platform !== "win32";

function runCli(args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn("node", [bin, ...args], { env: { ...baseEnv, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function fileMode(path) {
  return statSync(path).mode & 0o777;
}

function startFakeGateway({ registerOrigin, redirectAt, redirectTo } = {}) {
  const state = { registers: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const authBase = registerOrigin ?? base;
      if (req.url === redirectAt) {
        res.writeHead(307, { location: redirectTo });
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          agent_auth: {
            register_uri: `${authBase}/agent/auth/register`,
            claim_uri: `${authBase}/agent/auth/claim`,
          },
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/agent/auth/register") {
        state.registers += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          registration_id: "reg_1",
          claim_token: "ct_secret",
          claim_url: "/agent/auth/claim/complete",
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/agent/auth/claim/complete") {
        const payload = JSON.parse(body);
        if (payload.claim_token !== "ct_secret" || payload.code !== "123456") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Invalid or expired code." }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          credential_type: "api_key",
          credential: "sk_test_pinned",
          org_id: "org_PINNED",
          default_project: { slug: "default" },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state }));
  });
}

describe("login credential handling", () => {
  for (const kind of ["file", "symlink"]) {
    it(`does not reuse a predictable credential temp ${kind}`, { skip: !posix }, () => {
      const home = mkdtempSync(join(tmpdir(), "understudy-login-temp-"));
      try {
        const moduleUrl = new URL("../dist/config/credentials.js", import.meta.url).href;
        const script = `
          import { mkdirSync, writeFileSync, symlinkSync } from "node:fs";
          import { join } from "node:path";
          import { writeCredentials } from ${JSON.stringify(moduleUrl)};
          const dir = join(process.env.HOME, ".understudy");
          mkdirSync(dir, { mode: 0o700 });
          const temporary = join(dir, "credentials.json.tmp-" + process.pid);
          const sentinel = join(dir, "sentinel");
          writeFileSync(sentinel, "unchanged");
          if (${JSON.stringify(kind)} === "symlink") symlinkSync(sentinel, temporary);
          else writeFileSync(temporary, "stale", { mode: 0o644 });
          writeCredentials({ api_key: "sk_test_private", orgs: {} });
        `;
        const result = spawnSync("node", ["--input-type=module", "-e", script], {
          env: { ...baseEnv, HOME: home, USERPROFILE: home }, encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(home, ".understudy", "sentinel"), "utf8"), "unchanged");
        assert.equal(fileMode(join(home, ".understudy", "credentials.json")), 0o600);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("takes the manual key from UNDERSTUDY_API_KEY instead of argv", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-login-env-"));
    try {
      const result = await runCli(
        ["login", "--org", "org_TEST", "--project", "default", "--json"],
        { HOME: home, USERPROFILE: home, UNDERSTUDY_API_KEY: "sk_from_env" },
      );
      assert.equal(result.status, 0, result.stderr);
      const credsPath = join(home, ".understudy", "credentials.json");
      const creds = JSON.parse(readFileSync(credsPath, "utf8"));
      assert.equal(creds.api_key, "sk_from_env");
      if (posix) assert.equal(fileMode(credsPath), 0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads the manual key from stdin with --api-key -", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-login-stdin-"));
    try {
      const result = await runCli(
        ["login", "--api-key", "-", "--org", "org_TEST", "--project", "default", "--json"],
        { HOME: home, USERPROFILE: home },
        "sk_from_stdin\n",
      );
      assert.equal(result.status, 0, result.stderr);
      const creds = JSON.parse(readFileSync(join(home, ".understudy", "credentials.json"), "utf8"));
      assert.equal(creds.api_key, "sk_from_stdin");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the email-flow hint for bare `login` even when UNDERSTUDY_API_KEY is exported", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-login-bare-"));
    try {
      const result = await runCli(
        ["login"],
        { HOME: home, USERPROFILE: home, UNDERSTUDY_API_KEY: "sk_from_env" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /login --email/);
      assert.ok(!existsSync(join(home, ".understudy", "credentials.json")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses auth metadata that points sign-in off the gateway origin", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-login-offorigin-"));
    const { server, state } = await startFakeGateway({ registerOrigin: "http://127.0.0.1:1" });
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const result = await runCli(
        ["login", "--email", "agent@example.com", "--send-code", "--gateway-url", gatewayUrl],
        { HOME: home, USERPROFILE: home },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /off-origin/);
      assert.equal(state.registers, 0);
      assert.ok(!existsSync(join(home, ".understudy", "login-pending.json")));
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const redirectAt of [
    "/.well-known/oauth-authorization-server",
    "/agent/auth/register",
    "/agent/auth/claim/complete",
  ]) {
    it(`does not follow cross-origin redirects from ${redirectAt}`, async () => {
      const home = mkdtempSync(join(tmpdir(), "understudy-login-redirect-"));
      let leakedRequests = 0;
      const receiver = createServer((req, res) => {
        leakedRequests += 1;
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
      await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
      const redirectTo = `http://127.0.0.1:${receiver.address().port}/collect`;
      const { server } = await startFakeGateway({ redirectAt, redirectTo });
      const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
      try {
        const sent = await runCli(
          ["login", "--email", "agent@example.com", "--send-code", "--gateway-url", gatewayUrl, "--json"],
          { HOME: home, USERPROFILE: home },
        );
        let result = sent;
        if (redirectAt === "/agent/auth/claim/complete") {
          assert.equal(sent.status, 0, sent.stderr);
          result = await runCli(["login", "--code", "123456", "--json"], { HOME: home, USERPROFILE: home });
        }
        assert.equal(result.status, 1);
        assert.equal(leakedRequests, 0, "sign-in requests must never reach the redirect receiver");
        assert.ok(!existsSync(join(home, ".understudy", "credentials.json")));
      } finally {
        server.close();
        receiver.close();
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it("creates login-pending.json and credentials.json at mode 600", async () => {
    const home = mkdtempSync(join(tmpdir(), "understudy-login-mode-"));
    const { server } = await startFakeGateway();
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const sent = await runCli(
        ["login", "--email", "agent@example.com", "--send-code", "--gateway-url", gatewayUrl, "--json"],
        { HOME: home, USERPROFILE: home },
      );
      assert.equal(sent.status, 0, sent.stderr);
      const pendingPath = join(home, ".understudy", "login-pending.json");
      if (posix) assert.equal(fileMode(pendingPath), 0o600);

      const done = await runCli(["login", "--code", "123456", "--json"], { HOME: home, USERPROFILE: home });
      assert.equal(done.status, 0, done.stderr);
      const credsPath = join(home, ".understudy", "credentials.json");
      assert.equal(JSON.parse(readFileSync(credsPath, "utf8")).api_key, "sk_test_pinned");
      if (posix) assert.equal(fileMode(credsPath), 0o600);
      assert.ok(!existsSync(pendingPath));
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
