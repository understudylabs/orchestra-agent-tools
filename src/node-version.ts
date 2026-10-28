// No imports: the entry point loads this before anything else, so it has to
// run on a Node too old for the rest of the CLI.

/** Keep in step with `engines.node` in package.json and MIN_NODE in install.sh. */
export const MIN_NODE = "22.19.0";

function parts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function nodeVersionOk(version: string, minimum = MIN_NODE): boolean {
  const have = parts(version);
  const need = parts(minimum);
  for (let index = 0; index < need.length; index += 1) {
    if ((have[index] ?? 0) !== need[index]) return (have[index] ?? 0) > need[index];
  }
  return true;
}

/**
 * The command that updates Node the way this one was installed: through a
 * version manager, Homebrew, or the nodejs.org installer.
 */
export function nodeUpdateHint(execPath: string, env: Record<string, string | undefined>, platform: string): string {
  if (execPath.includes("/.nvm/") || (env.NVM_DIR && execPath.startsWith(env.NVM_DIR))) return "nvm install 22 && nvm alias default 22";
  if (execPath.includes("/fnm/") || execPath.includes("/.fnm/")) return "fnm install 22 && fnm default 22";
  if (execPath.includes("/.volta/")) return "volta install node@22";
  if (execPath.includes("/mise/") || execPath.includes("/.asdf/")) return "install Node 22 with your version manager (mise or asdf)";
  if (execPath.startsWith("/opt/homebrew/") || execPath.startsWith("/usr/local/Cellar/") || execPath.startsWith("/usr/local/opt/")) {
    return "brew upgrade node";
  }
  return platform === "darwin"
    ? "install Node 22 from https://nodejs.org (or: brew install node)"
    : "install Node 22 from https://nodejs.org/en/download (or your version manager)";
}

/** One message for a Node that is too old, or null when it is new enough. */
export function nodeVersionProblem(
  version = process.versions.node,
  execPath = process.execPath,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string | null {
  if (nodeVersionOk(version)) return null;
  return [
    `Orchestra needs Node ${MIN_NODE} or newer; this is Node ${version.replace(/^v/, "")}.`,
    `Update: ${nodeUpdateHint(execPath, env, platform)}`,
    "Then run the command again.",
  ].join("\n");
}
