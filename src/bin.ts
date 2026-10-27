#!/usr/bin/env node

import { applyOrchestraEnvAliases } from "./config/env-aliases.js";

const INTERNAL_CONVERSATION_SIDECAR_ARG = "__understudy_conversation_sidecar__";

applyOrchestraEnvAliases();

if (process.argv[2] === INTERNAL_CONVERSATION_SIDECAR_ARG) {
  const { runConversationSidecarMain } = await import("./runtime/conversation/sidecar.js");
  await runConversationSidecarMain();
} else {
  const { main } = await import("./index.js");
  await main(process.argv);
}
