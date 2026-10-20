import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// Like tests/ladder.test.mjs: the ladder skill is stdlib Python, so these tests
// drive it through python3 directly and import nothing from dist/.
const pythonAvailable = spawnSync("python3", ["--version"], { encoding: "utf8" }).status === 0;

function runPython(code, env = {}) {
  const result = spawnSync("python3", ["-c", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      UNDERSTUDY_TELEMETRY: "0",
      UNDERSTUDY_API_KEY: "",
      UNDERSTUDY_GATEWAY_URL: "",
      UNDERSTUDY_ORG_ID: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

const loadServe = `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("ladder_serve", ${JSON.stringify(resolve("skills/ladder/serve.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

describe("ladder server cross-site guard", { skip: !pythonAvailable }, () => {
  it("refuses cross-site browser requests, rebound hosts, and sends no CORS header", () => {
    const modelHome = mkdtempSync(join(tmpdir(), "ladder-models-"));
    const runsDir = mkdtempSync(join(tmpdir(), "ladder-runs-"));
    const code = `${loadServe}
import threading, urllib.request, urllib.error
srv = module.QuietServer(("127.0.0.1", 0), module.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

def get(path, headers=None):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.headers.get("Content-Type", "").startswith("text/event-stream"):
                lines = []                                  # keep-alive stream: stop at the terminal event
                for raw in resp:
                    line = raw.decode("utf-8", "ignore")
                    lines.append(line)
                    if '"type": "error"' in line or '"type": "done"' in line:
                        break
                body = "".join(lines)
            else:
                body = resp.read().decode("utf-8", "ignore")
            return {"status": resp.status, "acao": resp.headers.get("Access-Control-Allow-Origin"), "body": body}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "acao": e.headers.get("Access-Control-Allow-Origin"), "body": ""}

out = {}
out["plain"] = get("/models")                                   # curl-style: Host only
out["localhost"] = get("/models", {"Host": "localhost:%d" % port})
out["same_origin"] = get("/models", {"Sec-Fetch-Site": "same-origin"})
out["nav"] = get("/", {"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate"})
out["cross_site"] = get("/run?task=sort-email&model=gemma-4-e2b", {"Sec-Fetch-Site": "cross-site"})
out["same_site"] = get("/models", {"Sec-Fetch-Site": "same-site"})
out["rebound"] = get("/models", {"Host": "attacker.example:%d" % port})
out["bad_origin"] = get("/models", {"Origin": "http://evil.example"})
out["own_origin"] = get("/models", {"Origin": "http://127.0.0.1:%d" % port})
# a failing local run streams an actionable, path-free error event
out["run"] = get("/run?task=sort-email&model=gemma-4-e2b")
srv.shutdown()
print(json.dumps(out))
`;
    try {
      const out = runPython(code, { UNDERSTUDY_MODEL_HOME: modelHome, UNDERSTUDY_LADDER_RUNS_DIR: runsDir });
      for (const key of ["plain", "localhost", "same_origin", "nav", "own_origin"]) {
        assert.equal(out[key].status, 200, key);
        assert.equal(out[key].acao, null, `${key} must not send Access-Control-Allow-Origin`);
      }
      assert.match(out.plain.body, /gemma-4-e2b/);
      for (const key of ["cross_site", "same_site", "rebound", "bad_origin"]) {
        assert.equal(out[key].status, 403, key);
        assert.equal(out[key].acao, null, `${key} must not send Access-Control-Allow-Origin`);
      }
      assert.equal(out.run.status, 200);
      assert.match(out.run.body, /"type": "error"/);
      assert.match(out.run.body, /pull it with the manage-local-models skill/);
      assert.doesNotMatch(out.run.body, new RegExp(modelHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(out.run.body, /FileNotFoundError:/);
    } finally {
      rmSync(modelHome, { recursive: true, force: true });
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it("defaults the --agent smoke command to a gateway model that is still served", () => {
    const out = runPython(`${loadServe}
print(json.dumps({"first_gateway": next((m for m, s in module.MODELS.items() if s[0] == "gateway"), None),
                  "has_glm51": "glm-5.1" in module.MODELS}))
`);
    assert.equal(out.first_gateway, "glm-5.2");
    assert.equal(out.has_glm51, false);
  });
});

describe("ladder world recoverable-error contract", { skip: !pythonAvailable }, () => {
  it("turns non-string tool args into {error} instead of raising", () => {
    const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("ladder_world", ${JSON.stringify(resolve("skills/ladder/env/world.py"))})
world = importlib.util.module_from_spec(spec)
spec.loader.exec_module(world)
state = world.fresh_state({})
calls = [
    ("crm_find_accounts", {"query": ["Nova"]}),
    ("mail_find", {"query": 3808}),
    ("mail_find", {"query": True}),
    ("mail_send", {"to": {"email": "a@b"}, "subject": "x", "body": "y"}),
    ("mail_send", {"to": "a@b", "subject": ["x"], "body": "y"}),
    ("crm_update_ticket", {"id": ["t1"], "status": "closed"}),
]
results = [world.call_tool(state, name, args) for name, args in calls]
print(json.dumps({
    "all_error_dicts": all(isinstance(r, dict) and "error" in r for r in results),
    "sent": len(state.mail["sent"]),
    "norm_dict": world._norm({"email": "a@b"}),
    "loose_int": world._loose(3808),
    "norm_none": world._norm(None),
}))
`;
    const out = runPython(code);
    assert.equal(out.all_error_dicts, true);
    assert.equal(out.sent, 0);
    assert.equal(typeof out.norm_dict, "string");
    assert.equal(out.loose_int, "3808");
    assert.equal(out.norm_none, "");
  });
});
