import { existsSync, lstatSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { globalConfigDir } from "./config/paths.js";
const start = "# >>> Orchestra Claude terminal >>>";
const end = "# <<< Orchestra Claude terminal <<<";
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const statePath = () => join(globalConfigDir(), "claude-terminal-shell.json");
function saved(): Record<string, string> { return existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), "utf8")) : {}; }
function read(file: string) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("Shell startup file is a symlink; configure its owner directly.");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
export function validateClaudeShell() {
  if (process.platform === "win32" || (process.env.SHELL && !/\/(?:ba|z)sh$/.test(process.env.SHELL))) throw new Error("Persistent terminal setup supports bash and zsh. Use orchestra claude for an explicit gateway session.");
  const old = saved();
  const bashProfile = [".bash_profile", ".bash_login", ".profile"].map(name => join(homedir(), name)).find(existsSync) ?? join(homedir(), ".bash_profile");
  const current = process.env.SHELL?.endsWith("/bash")
    ? [join(homedir(), ".bashrc"), bashProfile]
    : [join(process.env.ZDOTDIR || homedir(), ".zshrc")];
  const files = [...new Set([...Object.keys(old), ...current])];
  for (const file of files) {
    const text = read(file);
    if ((old[file] && !text.includes(old[file])) || (!old[file] && text.includes(start))) throw new Error("Orchestra's shell launcher has edits or is untracked. Preserve them before reconfiguring.");
  }
  return files;
}
export function configureClaudeShell(cli: string, node: string) {
  const files = validateClaudeShell(), old = saved(), next: Record<string, string> = {};
  for (const file of files) {
    const text = read(file);
    const clean = old[file] ? text.replace(old[file], "") : text;
    const launch = `\n${start}\nfunction claude { ${quote(node)} ${quote(cli)} claude-native-launch "$@"; }\n${end}\n`;
    next[file] = launch;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, clean + launch, { mode: 0o600 });
  }
  writeFileSync(statePath(), JSON.stringify(next), { mode: 0o600 });
}
export function removeClaudeShell() {
  const old = saved();
  for (const [file, block] of Object.entries(old)) {
    const text = read(file);
    if (!text.includes(block)) throw new Error("Orchestra's shell launcher was edited; preserve it before removal.");
  }
  for (const [file, block] of Object.entries(old)) writeFileSync(file, read(file).replace(block, ""), { mode: 0o600 });
  rmSync(statePath(), { force: true });
}
