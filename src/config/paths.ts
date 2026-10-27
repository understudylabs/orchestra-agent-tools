import { homedir } from "node:os";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The per-repo config directory name. Sits alongside `.git/`.
 */
export const PROJECT_CONFIG_DIR = ".understudy";

/**
 * Per-repo config filename.
 */
export const PROJECT_CONFIG_FILE = "config.json";

/**
 * Global config directory under the user's home (credentials, profile,
 * models, runtime state). Resolve it with `globalConfigDir()`, never by
 * joining this name onto `homedir()` directly.
 */
export const GLOBAL_CONFIG_DIR = ".orchestra";

/**
 * Pre-rebrand global directory. After `migrateGlobalHome()` it is a
 * symlink to `GLOBAL_CONFIG_DIR`, so the installer, Python helpers, and
 * skills that still name `~/.understudy` keep working.
 */
export const LEGACY_GLOBAL_CONFIG_DIR = ".understudy";

/**
 * Marker file that proves a `~/.orchestra` directory belongs to this CLI.
 * Another tool's `~/.orchestra` (no marker) is never adopted or touched.
 */
export const GLOBAL_HOME_MARKER = ".orchestra-home";

/**
 * Global credentials filename.
 */
export const GLOBAL_CREDENTIALS_FILE = "credentials.json";

export const GLOBAL_TELEMETRY_FILE = "telemetry.json";

/**
 * In-flight email-code sign-in state. Written when a one-time code is
 * sent, consumed by `understudy login --code`, removed on success.
 */
export const GLOBAL_LOGIN_PENDING_FILE = "login-pending.json";

/**
 * Walk upward from `startDir` looking for the nearest directory that
 * contains a `.understudy/` folder. If none exists, fall back to
 * `startDir` itself.
 *
 * This is the same pattern as `package.json` / `.git` lookup — the CLI
 * should "just work" from any subdirectory of a repo that's been
 * signed in with `understudy login`.
 *
 * `$HOME` is never a project root: `~/.understudy/` is the *global*
 * config dir (credentials.json, profile.json, agent-card.json), not a
 * project marker. Matching it made every walk that reached the home
 * directory "find" a project there, and per-repo state (the active
 * project) ended up written to `~/.understudy/config.json`.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir);
  const root = resolve("/");
  const home = canonicalDir(resolve(homedir()));

  while (true) {
    if (canonicalDir(current) !== home) {
      const candidate = join(current, PROJECT_CONFIG_DIR);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current || parent === root) {
      return resolve(startDir);
    }
    current = parent;
  }
}

/**
 * Resolve symlinks so paths compare structurally — on macOS `$HOME` can
 * arrive as `/var/...` while `process.cwd()` reports `/private/var/...`
 * for the same directory. Falls back to the input when it doesn't exist.
 */
function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when `path` resolves to the global `~/.understudy/config.json`.
 * That file is never a *project* config — readers must treat it as
 * "no project" and writers must refuse it, or the global dir starts
 * claiming an active project for every directory under `$HOME`.
 */
export function isGlobalProjectConfigPath(path: string): boolean {
  const global = join(globalConfigDir(), PROJECT_CONFIG_FILE);
  const target = resolve(path);
  if (target === global) {
    return true;
  }
  // The file itself may not exist yet; canonicalize the parent dirs so
  // symlinked forms of the same location still match.
  return (
    basename(target) === basename(global) &&
    canonicalDir(dirname(target)) === canonicalDir(dirname(global))
  );
}

export function projectConfigPath(startDir: string = process.cwd()): string {
  return join(findProjectRoot(startDir), PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
}

/**
 * The global config directory. Read-only: returns `~/.orchestra` once it
 * is ours (see `migrateGlobalHome()`), otherwise `~/.understudy`, so a
 * library import or a test never moves anything.
 */
export function globalConfigDir(): string {
  const home = homedir();
  const legacy = join(home, LEGACY_GLOBAL_CONFIG_DIR);
  if (process.platform === "win32") return legacy;
  const current = join(home, GLOBAL_CONFIG_DIR);
  return isOrchestraHome(current) ? current : legacy;
}

export type GlobalHomeMigration =
  | "already-migrated"
  | "migrated"
  | "created"
  | "kept-legacy"
  | "unsupported-platform"
  | "disabled";

/**
 * One-time move of `~/.understudy` to `~/.orchestra`, leaving a relative
 * `~/.understudy -> .orchestra` symlink behind. Called once at CLI
 * startup; never throws, and leaves `~/.understudy` in place whenever the
 * move cannot be completed safely:
 *
 * - a `~/.orchestra` without our marker belongs to another tool;
 * - a user-managed `~/.understudy` symlink is left as is;
 * - if the symlink cannot be created, the rename is rolled back.
 *
 * The marker is written into `~/.understudy` before the rename, so a
 * concurrent CLI process sees a finished migration, never a half one.
 *
 * `UNDERSTUDY_HOME_MIGRATION=0` opts out. Under `node --test`
 * (`NODE_TEST_CONTEXT`, inherited by every CLI a test spawns) it is off
 * unless `UNDERSTUDY_HOME_MIGRATION=1`, so a test run can never move the
 * developer's real home directory.
 */
export function migrateGlobalHome(env: NodeJS.ProcessEnv = process.env): GlobalHomeMigration {
  const optIn = env.UNDERSTUDY_HOME_MIGRATION;
  if (optIn === "0" || (env.NODE_TEST_CONTEXT && optIn !== "1")) return "disabled";
  if (process.platform === "win32") return "unsupported-platform";
  const home = homedir();
  const current = join(home, GLOBAL_CONFIG_DIR);
  const legacy = join(home, LEGACY_GLOBAL_CONFIG_DIR);
  try {
    if (isOrchestraHome(current)) {
      ensureLegacyLink(legacy, current);
      return "already-migrated";
    }
    if (lstatOrNull(current)) return "kept-legacy";
    const legacyStat = lstatOrNull(legacy);
    if (legacyStat?.isDirectory()) return moveLegacyHome(legacy, current);
    if (legacyStat) return "kept-legacy";
    mkdirSync(current, { mode: 0o700 });
    writeHomeMarker(current, null);
    ensureLegacyLink(legacy, current);
    return "created";
  } catch {
    return isOrchestraHome(current) ? "already-migrated" : "kept-legacy";
  }
}

function moveLegacyHome(legacy: string, current: string): GlobalHomeMigration {
  writeHomeMarker(legacy, `~/${LEGACY_GLOBAL_CONFIG_DIR}`);
  try {
    renameSync(legacy, current);
  } catch {
    // Another CLI process may have finished the move first.
    if (isOrchestraHome(current)) {
      ensureLegacyLink(legacy, current);
      return "already-migrated";
    }
    return "kept-legacy";
  }
  if (ensureLegacyLink(legacy, current)) return "migrated";
  // Without the symlink, readers of ~/.understudy would lose everything:
  // put the directory back rather than half-migrate.
  try {
    renameSync(current, legacy);
    return "kept-legacy";
  } catch {
    return "migrated";
  }
}

/** True when `legacy` is (or now is) a symlink resolving to `current`. */
function ensureLegacyLink(legacy: string, current: string): boolean {
  const existing = lstatOrNull(legacy);
  if (!existing) {
    try {
      symlinkSync(GLOBAL_CONFIG_DIR, legacy, "dir");
      return true;
    } catch {
      // Lost a race to another process creating the same link.
    }
  }
  try {
    return lstatSync(legacy).isSymbolicLink() && realpathSync(legacy) === realpathSync(current);
  } catch {
    return false;
  }
}

function isOrchestraHome(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, GLOBAL_HOME_MARKER));
  } catch {
    return false;
  }
}

function writeHomeMarker(dir: string, migratedFrom: string | null): void {
  const marker = {
    schema_version: "orchestra.home.v1",
    created_at: new Date().toISOString(),
    migrated_from: migratedFrom,
  };
  writeFileSync(join(dir, GLOBAL_HOME_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export function globalCredentialsPath(): string {
  return join(globalConfigDir(), GLOBAL_CREDENTIALS_FILE);
}

export function globalTelemetryPath(): string {
  return join(globalConfigDir(), GLOBAL_TELEMETRY_FILE);
}

export function globalLoginPendingPath(): string {
  return join(globalConfigDir(), GLOBAL_LOGIN_PENDING_FILE);
}
