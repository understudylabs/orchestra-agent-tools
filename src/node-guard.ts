// Imported first by bin.ts, so it runs before any module that needs a newer
// Node (every command loads node:sqlite, which Node < 22.5 does not have).
// npm only warns about `engines`, so an old Node still gets the CLI installed.
import { nodeVersionProblem } from "./node-version.js";

const problem = nodeVersionProblem();
if (problem) {
  process.stderr.write(`orchestra: ${problem.split("\n").join("\n  ")}\n`);
  process.exit(1);
}
