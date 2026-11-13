#!/usr/bin/env node
// SessionStart hook: one line per marketplace with news, one more for a repo that owes the
// bootstrap, or nothing.
//
//   NEW PLUGINS  — plugins a known marketplace lists now that it did not list the last time this
//                  hook looked. Named once, then remembered: the next session is silent again.
//   NEW PROJECT  — the session opens inside a git repo whose rule file (CLAUDE.md, AGENTS.md,
//                  .claude/CLAUDE.md) has no "## Commands" block: the §5 bootstrap is owed, and
//                  claude-code-setup is the cheap read-only first look at what to automate there.
//                  Repeats every session until the block exists, because the bootstrap is owed.
//
// Local files only, never the network: Claude Code refreshes the marketplace clones itself, and a
// hook that fetched would add its latency and its failures to every session start. The list read
// is each marketplace's own .claude-plugin/marketplace.json (the catalog the installer resolves
// against), not a scan of its folders — a folder can hold a plugin the catalog does not offer.
//
// A new plugin is a name to read, never something to install from here: a plugin is foreign code
// that runs with this user's rights, so the notice points at `claude plugin details` first.
//
// The memory of what was seen lives in plugin-watch.local beside this script — this machine's
// state, never exported (export-rules.js copies scripts only, and *.local nowhere). The first
// sight of a marketplace records it silently: a baseline of three hundred names is not news.
//
// A session start must never fail because of this hook: every error prints nothing and exits 0.

const fs = require("fs");
const path = require("path");
const { pipelineRoot } = require("./lib/root");

const LIST_MAX = 10;
const DESC_MAX = 90;
const NAME_MAX = 60;

const ROOT = pipelineRoot("plugin-watch");
const CLAUDE = path.join(ROOT, ".claude");
const STATE = path.join(CLAUDE, "pipeline", "plugin-watch.local");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));

// { marketplace name -> [{ name, description }] } for every marketplace whose catalog reads.
function catalogs() {
  const out = {};
  let known;
  try {
    known = readJson(path.join(CLAUDE, "plugins", "known_marketplaces.json"));
  } catch {
    return out;
  }
  if (!known || typeof known !== "object") return out;
  for (const [name, entry] of Object.entries(known)) {
    const where = entry && typeof entry.installLocation === "string" ? entry.installLocation : "";
    if (!where) continue;
    try {
      const m = readJson(path.join(where, ".claude-plugin", "marketplace.json"));
      if (!m || !Array.isArray(m.plugins)) continue;
      out[name] = m.plugins
        .filter((p) => p && typeof p.name === "string" && p.name)
        .map((p) => ({ name: p.name, description: typeof p.description === "string" ? p.description : "" }));
    } catch {
      // one unreadable catalog must not hide the others
    }
  }
  return out;
}

// Catalog text is foreign: a name or description that carried a newline would print a line of
// its own into the session's context, so every control character folds into a space, and every
// field is capped.
function clean(text, max) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const one = String(text).replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

// The news lines and the state to save once they are out, or null when the state could not be
// read this time: a file locked by another session's save must not re-baseline over news that
// was never printed.
function pluginNotice() {
  const now = catalogs();
  if (!Object.keys(now).length) return null;
  let raw = null;
  try {
    raw = fs.readFileSync(STATE, "utf8");
  } catch (e) {
    if (!e || e.code !== "ENOENT") return null; // busy or unreadable: try again next session
  }
  let seen = {};
  if (raw !== null) {
    try {
      const s = JSON.parse(raw.replace(/^﻿/, ""));
      if (s && typeof s === "object" && s.seen && typeof s.seen === "object") seen = s.seen;
    } catch {
      // damaged beyond reading: re-baseline. What arrived since the last good save goes unnamed;
      // the alternative, a file that silences the hook for good, is worse.
    }
  }
  const lines = [];
  const next = { ...seen };
  for (const [mp, plugins] of Object.entries(now)) {
    const names = plugins.map((p) => p.name);
    const before = Array.isArray(seen[mp]) ? new Set(seen[mp]) : null;
    next[mp] = names;
    if (!before) continue; // first sight: baseline, silently
    const fresh = plugins.filter((p) => !before.has(p.name));
    if (!fresh.length) continue;
    const shown = fresh.slice(0, LIST_MAX).map((p) => clean(p.name, NAME_MAX) + (p.description ? " — " + clean(p.description, DESC_MAX) : ""));
    const more = fresh.length > LIST_MAX ? "; +" + (fresh.length - LIST_MAX) + " more" : "";
    const where = clean(mp, NAME_MAX);
    lines.push(
      "NEW PLUGINS in " + where + " (" + fresh.length + "): " + shown.join("; ") + more +
        ". Read before installing: claude plugin details <name>@" + where + " — a plugin runs with your rights."
    );
  }
  return { text: lines.join("\n"), next: JSON.stringify(next) !== JSON.stringify(seen) ? next : null };
}

// Atomic, and never fatal: a rename refused because another session or a virus scan holds the
// file leaves the old state, so the news is named again next session rather than lost.
function saveState(next) {
  const tmp = STATE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ seen: next }), "utf8");
    fs.renameSync(tmp, STATE);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // nothing was written
    }
  }
}

// The git repo the session sits in, or "" — found by walking up to a .git (a folder, or a file
// in a worktree or submodule), without spawning git on every session start.
function repoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return "";
    dir = up;
  }
}

function projectNotice() {
  const repo = repoRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!repo) return "";
  const files = ["CLAUDE.md", "AGENTS.md", path.join(".claude", "CLAUDE.md")];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(repo, f), "utf8").replace(/^﻿/, "");
      if (/^##[ \t]+Commands\b/m.test(text)) return "";
    } catch {
      // absent: try the next one
    }
  }
  let installed = false;
  try {
    const list = readJson(path.join(CLAUDE, "plugins", "installed_plugins.json"));
    installed = Object.keys((list && list.plugins) || {}).some((k) => k.startsWith("claude-code-setup@"));
  } catch {
    // no record of installed plugins: say how to get it
  }
  return (
    "NEW PROJECT: " + repo + " has no \"## Commands\" block in CLAUDE.md/AGENTS.md. Before the first task " +
    "here: the §5 bootstrap (find, run and write down build/lint/format/test/run), and claude-code-setup " +
    "for a read-only look at what to automate" +
    (installed ? " (ask: \"recommend automations for this project\")." : " (claude plugin install claude-code-setup@claude-plugins-official).")
  );
}

// Every step guarded on its own: one failing must not take the other's line with it. The state is
// saved only after the lines are written, so a session killed before printing names the news
// again. No process.exit: on a pipe it can cut the write short.
const out = [];
let pending = null;
try {
  const news = pluginNotice();
  if (news) {
    if (news.text) out.push(news.text);
    pending = news.next;
  }
} catch {
  // never fail a session start
}
try {
  const line = projectNotice();
  if (line) out.push(line);
} catch {
  // never fail a session start
}
try {
  if (out.length) process.stdout.write(out.join("\n") + "\n");
} catch {
  // a closed stdout: nothing to tell
}
if (pending) saveState(pending);
