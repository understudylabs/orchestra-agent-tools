import { input, select } from "@inquirer/prompts";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function finishClaudeSetup(start = true, deps = {
  interactive: Boolean(process.stdin.isTTY),
  cwd: process.cwd(),
  choose: () => select({ message: "What would you like to do next?", choices: [
    { name: "Open Claude Code here (recommended)", value: "open" },
    { name: "Open Claude Code in a project folder", value: "folder" },
    { name: "Finish for now — show me how to start later", value: "later" },
  ] }),
  folder: () => input({ message: "Project folder", validate: value => {
    try { return statSync(resolve(value.replace(/^~(?=$|\/)/, homedir()))).isDirectory() || "Enter an existing folder."; }
    catch { return "Enter an existing folder."; }
  } }),
  launch: (cwd: string) => new Promise<number>(done => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../bin.js", import.meta.url)), "claude-native-launch"], { cwd, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("close", code => done(code ?? 1));
  }),
  write: (message: string) => { process.stdout.write(message + "\n"); },
}) {
  deps.write("\nNext, open Claude Code to start chatting or working on code. Inside Claude, use /model to choose Orchestra Flash or another available model.");
  const action = start && deps.interactive ? await deps.choose() : "later";
  if (action !== "later") {
    const cwd = action === "folder" ? resolve((await deps.folder()).replace(/^~(?=$|\/)/, homedir())) : deps.cwd;
    deps.write(`Opening Claude Code in ${cwd}. Type your request after Claude opens. Exit Claude with /exit.`);
    const code = await deps.launch(cwd);
    if (code !== 0) deps.write("Claude did not exit successfully. Your Orchestra configuration is still installed. Check it with orchestra claude-setup status.");
  }
  deps.write("\nYou are back in your terminal, not in Claude. To start a conversation, open a new terminal and type this command, or run orchestra claude-native-launch here:\n\n  claude\n\nThen type your request inside Claude. To work on a project, first change into its folder. To resume a conversation later, run claude --resume.\n");
}
