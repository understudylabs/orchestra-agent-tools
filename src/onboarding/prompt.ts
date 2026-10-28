import { existsSync } from "node:fs";
import { join } from "node:path";

import { globalConfigDir } from "../config/paths.js";

/** Where install.sh and `orchestra init` keep install markers. */
export function installStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.UNDERSTUDY_INSTALL_STATE_DIR) return env.UNDERSTUDY_INSTALL_STATE_DIR;
  return join(env.UNDERSTUDY_LAB ?? join(globalConfigDir(), "agent-tools"), "install-state");
}

export interface PromptContext {
  signedIn: boolean;
  labStarted: boolean;
  lowerAnthropicBill?: boolean;
}

/**
 * The one line a person pastes into any coding agent (or that a terminal agent
 * gets as its first message). Kept short and plain: the onboarding skill
 * carries the flow, and nothing here asks the agent to handle sign-in codes.
 * Must stay in step with compose_initial_prompt in install.sh.
 */
export function onboardingPrompt(context: PromptContext): string {
  let prompt = context.lowerAnthropicBill
    ? "Use the Orchestra onboarding skill with the lower-Anthropic-bill path for this project, then the lower-anthropic-bill skill. Do not spend money, upload data, or call providers without my explicit approval and a cap."
    : "Use the Orchestra onboarding skill for this project.";
  if (!context.signedIn) {
    prompt += " I'm not signed in to Orchestra yet; if an account is needed, ask me to run `orchestra login` in my terminal.";
  }
  if (context.labStarted) {
    prompt += " The installer started the local model lab in the background.";
  }
  return prompt;
}

export function localModelLabStarted(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(installStateDir(env), "local-model-lab.json"));
}
