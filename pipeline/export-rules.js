#!/usr/bin/env node
// Exports the working pipeline from ~/.claude into a rules repository checkout, so every edit to
// the rules can be committed with one command and installed on another machine with `install.js`.
//
//   node export-rules.js [<repo-dir>] [--project <repo-root>]... [--commit "message"] [--push]
//
// <repo-dir> defaults to the checkout install.js recorded in ~/.claude/pipeline/rules-repo.local.
//
// What goes in: CLAUDE.md, agents/*.md, pipeline/*.js, the mods under pipeline/mods/, the Linux bundle, and — per --project —
// that repo's gitignored .claude/skills/*/SKILL.md (they live outside the public tree and would
// otherwise be lost with the machine). What stays out, on purpose: settings.json (machine-local
// permissions and hooks), memory/ (project-private knowledge), ledger/digests (accounting data),
// rules-repo.local (where THIS machine keeps the checkout).
// The one rewrite on the way out: this machine's ~/.claude path becomes the placeholder spelled
// in PLACEHOLDER below (the rules carry absolute paths because an agent has no shell to expand
// `~`), so the repo names no user and install.js substitutes the target home. Everything else is
// copied verbatim.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { pipelineScripts } = require("./lib/root");

const HOME = os.homedir();
const CLAUDE = path.join(HOME, ".claude");
// Assembled, never written out in one piece: install.js rewrites every literal occurrence of the
// placeholder to the target home — this file included — and a spelled-out constant would come
// back as a real path, after which the next export from that machine would depersonalise nothing.
const PLACEHOLDER = "{{" + "CLAUDE_HOME" + "}}";
const REPO_POINTER = path.join(CLAUDE, "pipeline", "rules-repo.local");
const args = process.argv.slice(2);
// The repo is the first positional that no flag consumed — by position, not by value: a repo
// path equal to a --project value must still count.
const TAKES_VALUE = new Set(["--project", "--commit"]);
let repo = "";
for (let i = 0; i < args.length; i++) {
  if (TAKES_VALUE.has(args[i])) {
    i++;
    continue;
  }
  if (!args[i].startsWith("--")) {
    repo = args[i];
    break;
  }
}
if (!repo) {
  try {
    repo = fs.readFileSync(REPO_POINTER, "utf8").trim();
  } catch {
    // no pointer: install.js was never run from a checkout on this machine
  }
}
if (!repo) {
  console.error("usage: node export-rules.js <repo-dir> [--project <repo-root>]... [--commit \"msg\"] [--push]\n(no <repo-dir> and no " + REPO_POINTER + " — run install.js from the checkout once, or pass the path)");
  process.exit(2);
}
const projects = [];
const commitAt = args.indexOf("--commit");
const commitMsg = commitAt !== -1 ? args[commitAt + 1] : "";
if (commitAt !== -1 && (!commitMsg || commitMsg.startsWith("--"))) {
  console.error("--commit needs a message");
  process.exit(2);
}
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--project") continue;
  if (!args[i + 1] || args[i + 1].startsWith("--")) {
    console.error("--project needs a path");
    process.exit(2);
  }
  // A path that is not there is a typo (`--project moon-terminal` from another cwd), not a
  // project with no skills: told about projects, the prune below would otherwise remove every
  // skill of that project from the repo as "retired" — it did, once, on a bare folder name.
  if (!fs.existsSync(path.join(args[i + 1], ".claude"))) {
    console.error("--project " + args[i + 1] + ": no .claude folder there — a repo ROOT path is expected, and its skills would be pruned as retired");
    process.exit(2);
  }
  projects.push(args[i + 1]);
}
const push = args.includes("--push");

if (!fs.existsSync(path.join(repo, ".git"))) {
  console.error("not a git checkout: " + repo);
  process.exit(1);
}

// The Linux bundle embeds CLAUDE.md, the agents and the scripts as base64 — regenerate it, or the
// repo ships a bundle older than the files beside it.
try {
  execFileSync(process.execPath, [path.join(CLAUDE, "pipeline", "make-bundle.js")], { stdio: ["ignore", "pipe", "inherit"] });
} catch (e) {
  console.error("make-bundle.js failed; not exporting a stale bundle: " + e.message);
  process.exit(1);
}

// This machine's ~/.claude in every spelling a text file may carry: native separators, forward
// slashes, and the doubled backslashes of a JS/JSON string literal.
const homeSpellings = [CLAUDE, CLAUDE.replace(/\\/g, "/"), CLAUDE.replace(/\\/g, "\\\\")].filter((v, i, a) => a.indexOf(v) === i);
function depersonalise(text) {
  let out = text;
  for (const h of homeSpellings) out = out.split(h).join(PLACEHOLDER);
  return out;
}

const copied = [];
function put(src, rel) {
  const dst = path.join(repo, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, depersonalise(fs.readFileSync(src, "utf8")), "utf8");
  copied.push(rel);
}

// 1. the rules and the agents
put(path.join(CLAUDE, "CLAUDE.md"), "CLAUDE.md");
for (const f of fs.readdirSync(path.join(CLAUDE, "agents"))) if (f.endsWith(".md")) put(path.join(CLAUDE, "agents", f), "agents/" + f);
// 2. the pipeline scripts — the same list the bundle packs (lib/root.js pipelineScripts), plus the
//    generated Linux bundle. Nothing else from pipeline/: digests, reports, the ledger and
//    rules-repo.local are this machine's.
const PIPE = path.join(CLAUDE, "pipeline");
for (const rel of pipelineScripts(PIPE).concat(["install-pipeline.sh"])) put(path.join(PIPE, rel), "pipeline/" + rel);
// 2b. the mods (Claude Code function-hooks plugins) under pipeline/mods/<name>/, every file of each
//     but the declarations the engine lays into .claude-plugin/types/ at each load — they belong to
//     the Claude Code build that wrote them, and the next load writes them again.
const MODS = path.join(PIPE, "mods");
function modFiles(dir, rel) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const r = rel ? rel + "/" + d.name : d.name;
    if (d.isDirectory()) return r.endsWith(".claude-plugin/types") ? [] : modFiles(path.join(dir, d.name), r);
    return d.isFile() ? [r] : [];
  });
}
if (fs.existsSync(MODS)) for (const rel of modFiles(MODS, "")) put(path.join(MODS, rel), "pipeline/mods/" + rel);
// 3. project skills, keyed by the repo folder name
for (const p of projects) {
  const skills = path.join(p, ".claude", "skills");
  if (!fs.existsSync(skills)) continue;
  const name = path.basename(p);
  for (const s of fs.readdirSync(skills)) {
    const file = path.join(skills, s, "SKILL.md");
    if (fs.existsSync(file)) put(file, "project-skills/" + name + "/" + s + "/SKILL.md");
  }
}
// 4. a manifest, so a stale file in the repo (an agent retired here) is visible as such
// No timestamp (it would make every export a change — the commit date says when) and no
// hostname (the repo names no machine).
const manifest = { files: copied.sort() };
fs.writeFileSync(path.join(repo, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
// Anything the manifest no longer lists but the repo still holds was retired: remove it, so the
// repo never installs an agent this machine has already dropped.
const tracked = (() => {
  try {
    return execFileSync("git", ["ls-files", "CLAUDE.md", "agents", "pipeline", "project-skills"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
})();
const removed = [];
for (const t of tracked) {
  const rel = t.replace(/\\/g, "/");
  // project-skills are pruned only when this run was told about projects at all: an export
  // without --project must not retire every skill the repo holds.
  if (!projects.length && rel.startsWith("project-skills/")) continue;
  if (!copied.includes(rel)) {
    fs.rmSync(path.join(repo, t), { force: true });
    removed.push(t);
  }
}
console.log("exported " + copied.length + " file(s) to " + repo + (removed.length ? " · removed retired: " + removed.join(", ") : ""));

// What a rules commit may carry: the exported tree, plus the files that live ONLY in the repo
// and are edited there by hand (the installer, the README, a licence, docs). Without the latter
// an install.js fix sat uncommitted through two exports — the commit filter was the exported
// paths only. Anything else pending in the checkout still stays out.
const OWNED = ["CLAUDE.md", "agents", "pipeline", "project-skills", "manifest.json", "install.js", "README.md", "LICENSE", "docs"];

if (commitMsg) {
  const git = (a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  // Only what this script owns: an unrelated pending edit in the checkout must not ride the commit.
  // Paths that do not exist yet (no LICENSE, no docs/) are fine for `add -A -- <path>` only when
  // they exist; filter, or git refuses the whole command.
  const owned = OWNED.filter((rel) => fs.existsSync(path.join(repo, rel)));
  git(["add", "-A", "--"].concat(owned));
  // Judge the STAGED set, not the whole tree: an unrelated dirty file must neither trigger nor
  // block. The bundle carries its generation time in two lines; a change made only of those is
  // not a change (git -I ignores lines matching the pattern).
  const status = git(["diff", "--cached", "--name-only", "-I", "Generated [0-9TZ:.-]+ by make-bundle|generatedAt"]).trim();
  if (!status) {
    git(["reset", "-q", "--", "pipeline/install-pipeline.sh", "manifest.json"]);
    git(["checkout", "-q", "--", "pipeline/install-pipeline.sh", "manifest.json"]);
    console.log("nothing changed since the last export");
  } else {
    git(["commit", "-q", "--only", "-m", commitMsg, "--"].concat(owned));
    console.log("committed: " + git(["log", "-1", "--format=%h %s"]).trim());
    if (push) {
      git(["push", "-q"]);
      console.log("pushed");
    }
  }
}
