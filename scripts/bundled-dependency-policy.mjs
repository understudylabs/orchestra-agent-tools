import { readFileSync } from "node:fs";

// npm ci verifies registry integrity before these public dependency files are bundled.
// Do not apply Orchestra's customer-name policy to upstream examples and locales.
export function validateBundledDependency(path, lockfile, read = readFileSync) {
  if (!path.startsWith("node_modules/")) return false;
  const matches = [...path.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g)];
  const last = matches.at(-1);
  if (!last || path.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid bundled dependency path");
  const root = path.slice(0, last.index + last[0].length);
  const locked = lockfile.packages?.[root];
  if (!locked || locked.link || !/^https:\/\/registry\.npmjs\.org\//.test(locked.resolved ?? "") || !/^sha512-[A-Za-z0-9+/]+=*$/.test(locked.integrity ?? "")) {
    throw new Error(`Bundled dependency is not pinned to npm registry integrity: ${root}`);
  }
  const installed = JSON.parse(read(`${root}/package.json`, "utf8"));
  const name = root.slice(root.lastIndexOf("node_modules/") + "node_modules/".length);
  if (installed.name !== name || installed.version !== locked.version) throw new Error(`Bundled dependency differs from lockfile: ${root}`);
  return true;
}
