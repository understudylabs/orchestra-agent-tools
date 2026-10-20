import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Doc-only guards for the shipped skill library (no dist import needed:
// these read the Markdown sources directly and run without a build).

const skillsDir = "skills";
const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
  .map((d) => d.name)
  .sort();

test("every top-level skill is registered in the authoritative skills index", () => {
  const index = readFileSync(join(skillsDir, "README.md"), "utf8");
  const missing = skillDirs.filter((name) => !index.includes(`](${name}/SKILL.md)`));
  assert.deepEqual(missing, []);
});

test("every SKILL.md declares the metadata.understudy frontmatter block", () => {
  const missing = skillDirs.filter((name) => {
    const text = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    const end = text.indexOf("\n---", 4);
    const frontmatter = text.slice(0, end === -1 ? text.length : end);
    return !(
      /\n\s+mode: /.test(frontmatter) &&
      /\n\s+safety: /.test(frontmatter) &&
      /\n\s+cli_required: (true|false)/.test(frontmatter)
    );
  });
  assert.deepEqual(missing, []);
});

test("cursor install shim never deletes an arbitrary path and gates on the manifest", () => {
  const text = readFileSync(join(skillsDir, "install-cursor-plugin", "SKILL.md"), "utf8");
  assert.doesNotMatch(text, /rm -rf/);
  assert.match(text, /\.cursor-plugin\/plugin\.json"/);
  assert.match(text, /readlink "\$dest"/);
});

test("simulate-before-launch hook recipe does not point at a missing relative script", () => {
  const text = readFileSync(join(skillsDir, "simulate-before-launch", "reference.md"), "utf8");
  assert.doesNotMatch(text, /detect-model-level-diff/);
  assert.doesNotMatch(text, /"command": "scripts\//);
});

test("public skills do not expose internal object-store layout", () => {
  const text = readFileSync(join(skillsDir, "onboard", "SKILL.md"), "utf8");
  assert.doesNotMatch(text, /r2:\/\//);
});

test("dead cli-bootstrap helper is gone", () => {
  assert.equal(existsSync(join(skillsDir, "_resources", "cli-bootstrap.md")), false);
});
