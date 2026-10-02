#!/usr/bin/env node
// Remembers the working tree a full test suite last passed on, so the same tree is never tested
// twice in a row (rules §6, and a project's publish step: before the push and after the merge).
//   run -- <command...>    runs the suite command with the terminal attached; when it exits 0 AND
//                          the tree is the same before and after the run, records that tree in
//                          <git common dir>/tested-tree. Exits with the command's own status.
//   check -- <command...>  exit 0 and one line when the current tree is the recorded one AND it
//                          passed under this very command; exit 1 otherwise — nothing recorded,
//                          the tree moved, another command, not a git repo, a local cargo [patch]
//                          override active. Exit 2 is a malformed call. Only 0 means "skip".
//
// The "tree" is the working tree as a git tree object: tracked and untracked files, staged or not,
// minus what .gitignore drops — hashed through a throwaway copy of the index, so the real index
// is never touched. What it cannot see: gitignored inputs and the environment (toolchain, env
// vars). Features and profile are in the command, which must match too — a targeted run's green
// says nothing about the whole suite. The one blind spot that bites is a cargo `[patch]` path
// override: it builds sources from outside the tree, whose edits never move the hash, so while one
// is active nothing is recorded and nothing is skipped.
// The record lives in the COMMON git dir: a tree hash is content, valid in every linked worktree.
//
// Why: on 2026-10-02 the journals showed 58 % of all foreground cargo time in test runs, the
// suite running 3–5 times per landed change on trees that were mostly identical (RATIONALE R8).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const git = (args, opts) => execFileSync("git", args, Object.assign({ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }, opts)).trim();

function topLevel() {
  try {
    return git(["rev-parse", "--show-toplevel"]);
  } catch {
    return "";
  }
}

// The working tree's hash, or "" when it cannot be taken (not a repo, git missing).
function worktreeTree(top) {
  let tmp = "";
  try {
    const index = path.resolve(top, git(["rev-parse", "--git-path", "index"], { cwd: top }));
    tmp = path.join(os.tmpdir(), "tested-tree-" + process.pid + "-" + Date.now() + ".idx");
    // A copy, not a fresh index: the stat cache in it is what keeps `add -A` fast on a big tree.
    if (fs.existsSync(index)) fs.copyFileSync(index, tmp);
    const env = Object.assign({}, process.env, { GIT_INDEX_FILE: tmp });
    git(["add", "-A"], { cwd: top, env });
    return git(["write-tree"], { cwd: top, env });
  } catch {
    return "";
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}

// A cargo `[patch]` table in any config cargo reads for this tree: the repo and every folder above
// it, then CARGO_HOME. Returns the file that carries one, or "".
function patchOverride(top) {
  const dirs = [];
  for (let d = top; ; d = path.dirname(d)) {
    dirs.push(path.join(d, ".cargo"));
    if (path.dirname(d) === d) break;
  }
  dirs.push(process.env.CARGO_HOME || path.join(os.homedir(), ".cargo"));
  for (const dir of dirs) {
    for (const name of ["config.toml", "config"]) {
      const file = path.join(dir, name);
      try {
        if (/^\s*\[patch\b/m.test(fs.readFileSync(file, "utf8"))) return file;
      } catch {
        // no such file
      }
    }
  }
  return "";
}

const recordPath = (top) => path.resolve(top, git(["rev-parse", "--git-common-dir"], { cwd: top }), "tested-tree");

// One spelling per command, so `cargo  test` and `cargo test` are the same run.
const normalise = (argv) => argv.join(" ").replace(/\s+/g, " ").trim();

function readRecord(top) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(top), "utf8"));
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const mode = args[0];
const dash = args.indexOf("--");
const command = dash === -1 ? [] : args.slice(dash + 1);

if ((mode !== "run" && mode !== "check") || !command.length) {
  process.stderr.write("usage: tested-tree.js run|check -- <suite command...>\n");
  process.exit(2);
}
// What cmd.exe cannot pass through faithfully, quoted or not: a quote inside an argument, a `%`
// (expanded even inside quotes), a trailing backslash (it escapes the closing quote for the
// child's argv parser). Such a command would run as something other than what is recorded; a
// suite command never needs one.
if (process.platform === "win32" && command.some((a) => /["%]|\\$/.test(a))) {
  process.stderr.write("tested-tree.js: an argument with a double quote, a % or a trailing backslash cannot be passed through cmd.exe faithfully\n");
  process.exit(2);
}

const short = (h) => (h ? h.slice(0, 12) : "none");
const top = topLevel();
const patched = top ? patchOverride(top) : "";

if (mode === "check") {
  const now = top ? worktreeTree(top) : "";
  const rec = top ? readRecord(top) : null;
  if (now && !patched && rec && rec.tree === now && rec.command === normalise(command)) {
    console.log("tested-tree: " + short(now) + " already passed `" + rec.command + "` at " + rec.at + " — the suite need not run again");
    process.exit(0);
  }
  const why = !now
    ? "no tree (not a git repo?)"
    : patched
      ? "a [patch] override is active (" + patched + "): sources outside the tree are not in the hash"
      : !rec
        ? "nothing recorded"
        : rec.tree !== now
          ? "tree moved: tested " + short(rec.tree) + ", now " + short(now)
          : "tested under another command: `" + rec.command + "`";
  console.log("tested-tree: run the suite — " + why);
  process.exit(1);
}

// run
const before = top ? worktreeTree(top) : "";
// A shell on Windows only: cargo/npm/pytest resolve through PATHEXT there (npm is a .cmd), and a
// bare spawn finds only .exe. One string, quoted here — Node deprecates an args array beside
// `shell: true` (DEP0190). Whitespace and cmd's metacharacters are quoted; a quote itself was
// refused above. Elsewhere the argv goes through untouched.
const quote = (a) => (/[\s&|<>^()%!]/.test(a) ? '"' + a + '"' : a);
const res =
  process.platform === "win32"
    ? spawnSync(command.map(quote).join(" "), { stdio: "inherit", shell: true })
    : spawnSync(command[0], command.slice(1), { stdio: "inherit" });
const status = res.status === null ? 1 : res.status;
if (status === 0) {
  const after = top ? worktreeTree(top) : "";
  if (!before || !after) {
    console.log("tested-tree: green, but the tree could not be hashed (not a git repo, or git failed) — not recorded");
  } else if (patched) {
    console.log("tested-tree: green, but a [patch] override is active (" + patched + ") — not recorded");
  } else if (before !== after) {
    console.log("tested-tree: green, but the tree changed during the run — not recorded");
  } else {
    try {
      fs.writeFileSync(recordPath(top), JSON.stringify({ tree: after, command: normalise(command), at: new Date().toISOString() }) + "\n");
      console.log("tested-tree: recorded " + short(after) + " as green");
    } catch (e) {
      console.log("tested-tree: green, but not recorded — " + e.message);
    }
  }
} else if (top && before) {
  // Red on a tree recorded green (a flaky test, a different environment): the old green no longer
  // speaks for it, and a later `check` must not skip on the strength of it.
  const rec = readRecord(top);
  if (rec && rec.tree === before) {
    try {
      fs.rmSync(recordPath(top), { force: true });
    } catch {
      console.log("tested-tree: red, and the green record of this tree could not be removed");
    }
  }
}
process.exit(status);
