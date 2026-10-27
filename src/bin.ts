#!/usr/bin/env node

import { migrateGlobalHome } from "./config/paths.js";

const INTERNAL_CONVERSATION_SIDECAR_ARG = "__understudy_conversation_sidecar__";

// Before any command module computes a path under the global directory.
if (migrateGlobalHome() === "migrated" && process.stderr.isTTY) {
  process.stderr.write("orchestra: moved ~/.understudy to ~/.orchestra (~/.understudy still points there)\n");
}

if (process.argv[2] === INTERNAL_CONVERSATION_SIDECAR_ARG) {
  const { runConversationSidecarMain } = await import("./runtime/conversation/sidecar.js");
  await runConversationSidecarMain();
} else {
  const { main } = await import("./index.js");
  await main(process.argv);
}
