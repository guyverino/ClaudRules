// Shared by every test file: the assertion, the pipeline root under test, and the modules.
//
// --prefix for the same reason install-hooks.js takes one: overriding HOME does not redirect
// os.homedir() on Windows, so a sandbox check would silently test the live installation. The
// modules are required from THAT root, so a sandbox install is tested as installed, not the
// checkout the runner happens to sit in.

const tFs = require("fs");
const tPath = require("path");
const tOs = require("os");

const tPrefixAt = process.argv.indexOf("--prefix");
const tRoot = tPrefixAt !== -1 && process.argv[tPrefixAt + 1] ? process.argv[tPrefixAt + 1] : tOs.homedir();
const PIPE = tPath.join(tRoot, ".claude", "pipeline");

const state = { failed: 0, cases: 0 };
const t = (ok, label, got) => {
  state.cases += 1;
  if (!ok) state.failed += 1;
  console.log(ok ? "ok  " : "FAIL", String(label).padEnd(34), got);
};

// A pipeline module by its path under pipeline/ ("lib/digest.js", "stats.js"). Relative to this
// folder: the installers run `<root>/.claude/pipeline/test.js`, so the runner, the tests and the
// modules are always one tree — --prefix only redirects the DATA roots (agents/, the ledger).
const pipeline = (rel) => require(tPath.join(__dirname, "..", rel));

// Transcript records the way the journal holds them, for digests built by hand.
const rec = {
  hook: (text) => ({ type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "SessionStart", content: [text] } }),
  user: (text) => ({ type: "user", message: { content: [{ type: "text", text }] } }),
  assistant: (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  bash: (id, cmd) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } }),
  edit: (id, file) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] } }),
};

// A throwaway git repo for the tests that need one. The fixture must not inherit this user's
// signing or hook config: a gpg prompt or a global hook would throw out of the suite instead of
// failing one case.
function tempGitRepo(prefix) {
  const dir = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), prefix));
  const g = (a) =>
    require("child_process")
      .execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "init.templateDir="].concat(a), {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      .trim();
  return { dir, g, remove: () => tFs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { t, state, tRoot, tFs, tPath, tOs, pipeline, tempGitRepo, rec };
