export const ENV_PREFIX = "ORCHESTRA_";
export const LEGACY_ENV_PREFIX = "UNDERSTUDY_";

/**
 * Mirror every `ORCHESTRA_*` variable onto its `UNDERSTUDY_*` name, so the
 * existing `UNDERSTUDY_*` reads across the CLI accept the new names. The
 * `ORCHESTRA_*` value wins when both are set; `UNDERSTUDY_*` alone keeps
 * working. Called once at CLI startup, before any command reads the env.
 */
export function applyOrchestraEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !key.startsWith(ENV_PREFIX) || key.length === ENV_PREFIX.length) continue;
    env[LEGACY_ENV_PREFIX + key.slice(ENV_PREFIX.length)] = value;
  }
}

/**
 * Expand `UNDERSTUDY_*` entries to carry both prefixes, for env handed to
 * child processes: new code can read `ORCHESTRA_*` while existing apps that
 * read `UNDERSTUDY_*` keep working.
 */
export function withBothEnvPrefixes(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = value;
    if (key.startsWith(LEGACY_ENV_PREFIX)) {
      out[ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length)] = value;
    }
  }
  return out;
}
