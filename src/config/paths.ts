import { homedir } from "node:os";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
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

/**
 * True when two paths name the same location once symlinks are resolved.
 * Records written before the home migration store `~/.understudy/...`
 * paths, which now reach `~/.orchestra/...` through a symlink, so stored
 * paths must be compared this way, never as strings. Works for paths that
 * no longer exist: the deepest existing ancestor is resolved and the rest
 * appended.
 */
export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

function canonicalPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (true) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.unshift(basename(head));
      head = parent;
    }
  }
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

export type GlobalHomeMigrationStatus =
  | "already-migrated"
  | "migrated"
  | "created"
  | "kept-legacy"
  | "unsupported-platform"
  | "disabled"
  | "split";

export interface GlobalHomeMigration {
  status: GlobalHomeMigrationStatus;
  /** Entries left in a real ~/.understudy because ~/.orchestra already has them. */
  conflicts: string[];
}

/**
 * One-time move of `~/.understudy` to `~/.orchestra`, leaving a relative
 * `~/.understudy -> .orchestra` symlink behind. Opt-in: runs only with
 * `UNDERSTUDY_HOME_MIGRATION=1`, which the installer sets, so a test, a
 * library import, or a plain `npm i -g` upgrade never moves anything.
 * Never throws, and leaves `~/.understudy` in place whenever the move
 * cannot be completed safely:
 *
 * - a `~/.orchestra` without our marker belongs to another tool;
 * - a user-managed `~/.understudy` symlink is left as is;
 * - if the symlink cannot be created, the rename is rolled back.
 *
 * The marker is written into `~/.understudy` before the rename, so a
 * concurrent process sees a finished migration, never a half one. If a
 * real `~/.understudy` reappears beside a migrated home (a crash between
 * rename and symlink, or an older process recreating it), its entries are
 * moved across without overwriting anything; entries that already exist in
 * `~/.orchestra` are left where they are and reported as conflicts.
 */
export function migrateGlobalHome(env: NodeJS.ProcessEnv = process.env): GlobalHomeMigration {
  if (env.UNDERSTUDY_HOME_MIGRATION !== "1") return result("disabled");
  if (process.platform === "win32") return result("unsupported-platform");
  const home = homedir();
  const current = join(home, GLOBAL_CONFIG_DIR);
  const legacy = join(home, LEGACY_GLOBAL_CONFIG_DIR);
  try {
    if (isOrchestraHome(current)) return linkOrReconcile(legacy, current, "already-migrated");
    if (lstatOrNull(current)) return result("kept-legacy");
    const legacyStat = lstatOrNull(legacy);
    if (legacyStat?.isDirectory()) return moveLegacyHome(legacy, current);
    if (legacyStat) return result("kept-legacy");
    mkdirSync(current, { mode: 0o700 });
    writeHomeMarker(current, null);
    ensureLegacyLink(legacy, current);
    return result("created");
  } catch {
    return result(isOrchestraHome(current) ? "already-migrated" : "kept-legacy");
  }
}

function result(status: GlobalHomeMigrationStatus, conflicts: string[] = []): GlobalHomeMigration {
  return { status, conflicts };
}

function moveLegacyHome(legacy: string, current: string): GlobalHomeMigration {
  writeHomeMarker(legacy, `~/${LEGACY_GLOBAL_CONFIG_DIR}`);
  try {
    renameSync(legacy, current);
  } catch {
    // Another process may have finished the move first.
    if (isOrchestraHome(current)) return linkOrReconcile(legacy, current, "already-migrated");
    return result("kept-legacy");
  }
  if (ensureLegacyLink(legacy, current)) return result("migrated");
  // Without the symlink, readers of ~/.understudy would lose everything:
  // put the directory back rather than half-migrate.
  try {
    renameSync(current, legacy);
    return result("kept-legacy");
  } catch {
    // Something recreated ~/.understudy in the meantime.
    return linkOrReconcile(legacy, current, "migrated");
  }
}

/**
 * Make `~/.understudy` the symlink to a migrated home. A real directory
 * found there is merged into `~/.orchestra` first (see migrateGlobalHome).
 */
function linkOrReconcile(legacy: string, current: string, status: GlobalHomeMigrationStatus): GlobalHomeMigration {
  const legacyStat = lstatOrNull(legacy);
  if (legacyStat?.isDirectory()) {
    const conflicts: string[] = [];
    mergeInto(legacy, current, conflicts, true);
    if (conflicts.length > 0) return result("split", conflicts);
    rmdirSync(legacy);
  }
  ensureLegacyLink(legacy, current);
  return result(status);
}

/** Move entries from `src` into `dst`, recursing into directories both have; never overwrite. */
function mergeInto(src: string, dst: string, conflicts: string[], top: boolean): void {
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    if (top && name === GLOBAL_HOME_MARKER) {
      // Left by an interrupted move; the migrated home has its own.
      rmSync(from, { force: true });
      continue;
    }
    const to = join(dst, name);
    const fromStat = lstatSync(from);
    const toStat = lstatOrNull(to);
    if (!toStat) {
      if (moveWithoutOverwrite(from, to, fromStat)) continue;
    } else if (fromStat.isDirectory() && toStat.isDirectory()) {
      mergeInto(from, to, conflicts, false);
      if (readdirSync(from).length === 0) rmdirSync(from);
      continue;
    }
    conflicts.push(from);
  }
}

/**
 * Move one entry to a path that did not exist a moment ago, failing
 * (false) rather than replacing anything created there since. A plain
 * rename would silently overwrite a file another process just wrote.
 */
function moveWithoutOverwrite(from: string, to: string, fromStat: Stats): boolean {
  try {
    if (fromStat.isSymbolicLink()) {
      // link() follows symlinks on macOS; recreate the link itself.
      symlinkSync(readlinkSync(from), to);
    } else if (fromStat.isFile()) {
      linkSync(from, to);
    } else {
      // A directory rename only replaces an empty directory: no data lost.
      renameSync(from, to);
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  unlinkSync(from);
  return true;
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
