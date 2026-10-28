#!/usr/bin/env node

import { migrateGlobalHome } from "./config/paths.js";

const INTERNAL_CONVERSATION_SIDECAR_ARG = "__understudy_conversation_sidecar__";

// Before any command module computes a path under the global directory.
// A no-op unless UNDERSTUDY_HOME_MIGRATION=1 (set by the installer).
const home = migrateGlobalHome();
if (home.status === "migrated") {
  process.stderr.write("orchestra: moved ~/.understudy to ~/.orchestra (~/.understudy still points there)\n");
} else if (home.status === "split") {
  process.stderr.write(
    "orchestra: ~/.understudy is a real directory again beside ~/.orchestra. These entries exist in both and were left " +
      `in ~/.understudy; move or delete them, then rerun the installer:\n${home.conflicts.map((path) => `  ${path}`).join("\n")}\n`,
  );
}

// `orchestra explore` imports node:sqlite, which Node 22 still flags as
// experimental with a warning on import. Every command loads it, so that one
// warning would land in the middle of interactive screens; others still print.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.startsWith("SQLite is an experimental feature")) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

if (process.argv[2] === INTERNAL_CONVERSATION_SIDECAR_ARG) {
  const { runConversationSidecarMain } = await import("./runtime/conversation/sidecar.js");
  await runConversationSidecarMain();
} else {
  const { main } = await import("./index.js");
  await main(process.argv);
}
