import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { globalConfigDir } from "./config/paths.js";
import { readNativeState } from "./claude-native.js";
import { ClaudeSessionSchema } from "./commands/claude.js";

const Result = z.object({ is_error: z.literal(false), result: z.string().min(1), session_id: z.string().uuid() });

export async function checkClaudeSetup() {
  const sessionId = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), "orchestra-setup-check-"));
  const { config } = readNativeState();
  try {
    const { stdout } = await promisify(execFile)("claude", [
      "-p", "Reply with exactly ORCHESTRA_SETUP_OK.",
      "--system-prompt", "This is a connection check. Reply only with the requested text.",
      "--session-id", sessionId, "--tools", "", "--disable-slash-commands",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--permission-mode", "default", "--setting-sources", "user",
      "--max-turns", "1", "--no-session-persistence", "--output-format", "json",
    ], {
      cwd, timeout: 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env,
        UNDERSTUDY_CLAUDE_SETUP_TEST_SESSION: sessionId,
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128", MAX_THINKING_TOKENS: "0",
      },
    });
    const result = Result.parse(JSON.parse(stdout));
    if (result.session_id !== sessionId || result.result.trim() !== "ORCHESTRA_SETUP_OK") throw new Error("Unexpected setup-check response.");
    const session = ClaudeSessionSchema.parse(JSON.parse(readFileSync(join(globalConfigDir(), "claude-sessions", `${sessionId}.json`), "utf8")));
    if (session.environment !== "test" || session.org !== config.org || session.project !== config.project || session.workload !== config.workload || session.gateway_url !== config.gateway_url) throw new Error("Setup-check attribution did not match the selected scope.");
    return { inference: "verified" as const, capture: "not_checked" as const, session_id: sessionId };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
