#!/usr/bin/env node
// Idempotently registers the pipeline gate check in the global settings.json:
//   Stop             -> digest mode (writes the report, never blocks)
//   UserPromptSubmit -> report mode (surfaces an unread report on the next task)
//   UserPromptSubmit -> reply-lang.js (pins the reply language from reply-lang.local; silent without it)
//   SessionStart     -> leak-check.js status (one line when commits by others await a leak review)
//   PreToolUse       -> no-poll.js on Bash|PowerShell (refuses a sleep loop or a 30 s+ wait, §7)
// Run again after editing: it replaces its own entries and leaves every other hook untouched.

const fs = require("fs");
const path = require("path");
const os = require("os");

// An explicit --prefix, never an overridden HOME: on Windows os.homedir() reads USERPROFILE, so
// `HOME=/tmp/fake node install-hooks.js` silently edited the REAL settings.json instead of the
// sandbox — found by installing into a throwaway prefix and watching it touch the live file.
const prefixAt = process.argv.indexOf("--prefix");
const ROOT = prefixAt !== -1 && process.argv[prefixAt + 1] ? process.argv[prefixAt + 1] : os.homedir();

const SETTINGS = path.join(ROOT, ".claude", "settings.json");
const SCRIPT = path.join(ROOT, ".claude", "pipeline", "gate-check.js");
const LEAK = path.join(ROOT, ".claude", "pipeline", "leak-check.js");
const NO_POLL = path.join(ROOT, ".claude", "pipeline", "no-poll.js");
const REPLY_LANG = path.join(ROOT, ".claude", "pipeline", "reply-lang.js");
// Match our own scripts by folder + filename in either separator style. A bare filename would
// also claim an unrelated third-party hook that happens to be named gate-check.js; a marker with
// one fixed separator would match neither, and every run would append a duplicate.
const MARKS = ["gate-check.js", "leak-check.js", "no-poll.js", "reply-lang.js"].flatMap((f) => ["pipeline\\" + f, "pipeline/" + f]);
const isOurs = (c) => typeof c === "string" && MARKS.some((m) => c.includes(m));
// Which of our scripts a command runs, separator-neutral; "" for anything not ours.
const scriptOf = (c) => {
  const m = isOurs(c) ? MARKS.find((k) => c.includes(k)) : "";
  return m ? m.slice("pipeline/".length) : "";
};

// The absolute node binary, not a bare `node`: a hook is spawned without the login shell, so a
// PATH set up by nvm or a module system is not there, and a bare name would silently never run.
const NODE = process.execPath;
// When installing into a prefix that is not the real home, the hook must carry it: otherwise the
// installed hook would resolve its own paths against os.homedir() and write outside the sandbox.
const prefixArg = path.resolve(ROOT) === path.resolve(os.homedir()) ? "" : ' --prefix "' + ROOT + '"';
const cmd = (mode) => '"' + NODE + '" "' + SCRIPT + '" ' + mode + prefixArg;
const leakCmd = '"' + NODE + '" "' + LEAK + '" status';
const noPollCmd = '"' + NODE + '" "' + NO_POLL + '"';
const replyLangCmd = '"' + NODE + '" "' + REPLY_LANG + '"' + prefixArg;

if (!fs.existsSync(SETTINGS)) {
  console.error("no settings.json at " + SETTINGS + " - nothing to install into");
  process.exit(1);
}
// A dotfile-managed settings.json is often a symlink; writing through renameSync would replace the
// link with a plain file and detach it from whatever syncs it. Resolve it first.
let target = SETTINGS;
try {
  target = fs.realpathSync(SETTINGS);
} catch {
  // not resolvable: fall back to the literal path
}
// Only when a prefix was given explicitly: a symlink resolving outside a SANDBOX would make it
// write the live file. On a normal install a symlinked HOME or a settings.json kept in a dotfile
// repo is expected — comparing unresolved paths there would refuse the very case the resolve above
// exists to support. Both sides are resolved, and containment is tested on a separator boundary so
// a sibling directory (/home/u2 against /home/u) cannot pass as inside.
if (prefixAt !== -1) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(ROOT);
  } catch {
    realRoot = path.resolve(ROOT);
  }
  const withSep = realRoot.replace(/[\\/]?$/, path.sep);
  if (target !== realRoot && !target.startsWith(withSep)) {
    console.error("settings.json resolves outside the prefix (" + target + ") - refusing");
    process.exit(1);
  }
}
const original = fs.readFileSync(SETTINGS, "utf8");
const raw = original.replace(/^﻿/, ""); // a BOM would break JSON.parse
let settings;
try {
  settings = JSON.parse(raw);
} catch (e) {
  console.error("settings.json is not valid JSON (" + e.message + ") - refusing to rewrite it");
  process.exit(1);
}

if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
  console.error("hooks in " + SETTINGS + " is not an object - refusing to touch it");
  process.exit(1);
}
settings.hooks = settings.hooks || {};

// The backup is written only once every refusal path is behind us: a run that changes nothing must
// not litter a .bak beside the user's settings. Beside the ORIGINAL path, not the resolved one, so
// it lands where the user looks rather than inside their dotfile repo.
const backup = SETTINGS + ".bak." + new Date().toISOString().replace(/[:.]/g, "-");
fs.writeFileSync(backup, original, "utf8"); // byte-faithful: restoring must give back the original

function install(event, mode, timeout, command, matcher) {
  // An older or hand-edited settings.json may hold this event in another shape; pushing onto a
  // non-array would throw halfway through registration and leave the file half-updated.
  if (settings.hooks[event] && !Array.isArray(settings.hooks[event])) {
    console.error("hooks." + event + " is not an array in " + SETTINGS + " - refusing to touch it");
    process.exit(1);
  }
  const list = (settings.hooks[event] = settings.hooks[event] || []);
  const full = command || cmd(mode);
  const script = scriptOf(full);
  // Drop only OUR hook entries of the SAME script, never the group: a group can hold a sibling
  // hook belonging to something else, and splicing the whole group would silently delete it. Per
  // script, because UserPromptSubmit carries two of ours — dropping every one of ours there
  // would let the second registration remove the first.
  for (let i = list.length - 1; i >= 0; i--) {
    const group = list[i];
    if (!group || !Array.isArray(group.hooks)) continue;
    group.hooks = group.hooks.filter((h) => !(h && scriptOf(h.command) === script));
    if (group.hooks.length === 0) list.splice(i, 1);
  }
  // A tool hook carries the tool matcher on the group; the lifecycle hooks carry none.
  const group = { hooks: [{ type: "command", command: full, timeout }] };
  if (matcher) group.matcher = matcher;
  list.push(group);
}

install("Stop", "digest", 20);
install("UserPromptSubmit", "report", 10);
// The reply language, one line per prompt (§0's English example decided it by chance once).
install("UserPromptSubmit", "", 5, replyLangCmd);
// Foreign commits on origin/main not yet leak-reviewed: one line at session start, or nothing.
// It fetches main into a private ref (bounded to 6 s) and reads local git state; 15 s is plenty.
install("SessionStart", "status", 15, leakCmd);
// A shell command that polls with sleep is refused before it runs (§7): the checker's WARN comes
// a task too late to save the turn that waited. Only the two shell tools; a Read never sleeps.
install("PreToolUse", "", 10, noPollCmd, "Bash|PowerShell");

// Atomic replace: a crash mid-write must not leave the global settings truncated.
const tmp = target + ".tmp." + process.pid;
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
fs.renameSync(tmp, target);

const check = JSON.parse(fs.readFileSync(target, "utf8"));
const count = (e) =>
  (check.hooks[e] || []).filter((g) => (g.hooks || []).some((h) => isOurs(h.command))).length;
console.log("backup:", backup);
console.log("Stop entries:", count("Stop"), "| UserPromptSubmit entries:", count("UserPromptSubmit"), "| SessionStart entries:", count("SessionStart"), "| PreToolUse entries:", count("PreToolUse"));
console.log("other Stop hooks kept:", (check.hooks.Stop || []).length - count("Stop"));
console.log("keys intact:", Object.keys(check).join(", "));
