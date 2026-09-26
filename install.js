#!/usr/bin/env node
// Installs the working pipeline from this checkout into a Claude Code home.
//
//   node install.js [--prefix <absolute home>] [--project <repo-root>]... [--dry-run] [--force-no-backup]
//
// Default home is the OS home directory (~/.claude). In order:
//   1. rewrite the {{CLAUDE_HOME}} placeholder the rules carry (export-rules.js put it where the
//      source machine's ~/.claude was) to the target home — root AND tail, in the target OS's
//      separators — and, on POSIX, the one PowerShell-specific sentence in the rules; an agent
//      has no shell, so `~` never expands
//   2. back up an existing ~/.claude/CLAUDE.md, agents/, pipeline/ (refuse without --force-no-backup
//      when the backup cannot be written); a first install has nothing to back up and says so
//   3. write CLAUDE.md, agents/*.md and pipeline/**/*.js (the entry points, lib/, tests/)
//      atomically; prune the agents this checkout retired, and the pipeline scripts a previous
//      install from here recorded (pipeline/.claudrules.json) that the manifest no longer names —
//      as the Linux bundle does from its own manifest, so a renamed module disappears on both paths
//   4. run pipeline/test.js — red suite → roll the install back (restore the backup, or remove
//      what was written on a first install) and exit 1; hooks are never registered over it
//   5. run pipeline/install-hooks.js (Stop / UserPromptSubmit / SessionStart, idempotent; a
//      minimal settings.json is created when none exists) — a refusal is reported and rolls back too
//   6. install project skills into each --project's .claude/skills/, recording which ones came
//      from here in .claude/skills/.claudrules.json so a later install can prune ONLY those
//   7. record where this checkout is (pipeline/rules-repo.local) so export-rules.js needs no path
// Never copies settings.json wholesale, never touches memory/.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at !== -1 && args[at + 1] && !args[at + 1].startsWith("--") ? args[at + 1] : "";
};
const projects = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--project") continue;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) {
    console.error("--project needs a path");
    process.exit(2);
  }
  projects.push(path.resolve(v));
}

if (args.includes("--prefix") && !value("--prefix")) {
  console.error("--prefix needs a path (a following flag or nothing was given); refusing to fall back to the real home");
  process.exit(2);
}
const rawPrefix = value("--prefix");
let prefix = rawPrefix || os.homedir();
if (rawPrefix) {
  if (rawPrefix.startsWith("~/") || rawPrefix.startsWith("~\\")) prefix = path.join(os.homedir(), rawPrefix.slice(2));
  else if (!path.isAbsolute(rawPrefix)) {
    console.error("--prefix must be absolute (got " + rawPrefix + "): a relative one would resolve against wherever this ran");
    process.exit(2);
  }
}
prefix = path.resolve(prefix);
const dry = flag("--dry-run");
const target = path.join(prefix, ".claude");
const posix = path.sep === "/";

// --- path rewrite -------------------------------------------------------------------------
// The rules carry absolute paths (an agent has no shell to expand `~`); export-rules.js replaced
// the source machine's ~/.claude with this placeholder. Every occurrence is the placeholder plus
// a tail of ordinary segments; both halves are rewritten, or a POSIX install would ship
// `/home/x/.claude\pipeline\gate-check.js` — backslash is a filename character there.
const ROOT_RE = /\{\{CLAUDE_HOME\}\}((?:[\\/][A-Za-z0-9_.-]+)*)/g;
function rewrite(text) {
  let out = text.replace(ROOT_RE, (m, tail) => target + tail.replace(/[\\/]/g, path.sep));
  if (posix) {
    // The rules explain a Windows quirk in one sentence; on POSIX the reason is a different one.
    out = out.replace("PowerShell does not expand `~` for a native argument, and", "a `~` is not expanded when the path reaches a tool rather than a shell, and");
    out = out.replace(/\r\n/g, "\n"); // a CRLF checkout must not ship a \r-terminated shebang
  }
  return out;
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
} catch (e) {
  console.error("manifest.json missing or malformed: " + e.message);
  process.exit(1);
}
const files = (manifest.files || []).filter((f) => f === "CLAUDE.md" || f.startsWith("agents/") || f.startsWith("pipeline/"));
if (!files.length) {
  console.error("manifest.json lists nothing to install");
  process.exit(1);
}

// --- backup ------------------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(target, "backup-" + stamp);
const existing = ["CLAUDE.md", "agents", "pipeline"].filter((p) => fs.existsSync(path.join(target, p)));
let backedUp = false;
if (existing.length && !dry) {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const p of existing) fs.cpSync(path.join(target, p), path.join(backupDir, p), { recursive: true });
    backedUp = true;
    console.log("backup: " + backupDir + " (" + existing.join(", ") + ")");
  } catch (e) {
    if (!flag("--force-no-backup")) {
      console.error("could not write a backup (" + e.message + "); pass --force-no-backup to install anyway");
      process.exit(1);
    }
    console.log("WARNING: installing without a backup (--force-no-backup)");
  }
} else if (!existing.length) {
  console.log("first install into " + target + " — nothing to back up");
}

function atomicWrite(dst, text) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + ".tmp." + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, dst);
}

// Undo everything this run wrote: restore the backup when there is one, else remove the copies —
// a half-installed home (rules present, hooks missing, or a checker that fails its own suite)
// is the state this script promises never to leave.
const written = [];
function rollback(why) {
  console.error("\nROLLBACK — " + why);
  try {
    if (backedUp) {
      for (const p of existing) {
        fs.rmSync(path.join(target, p), { recursive: true, force: true });
        fs.cpSync(path.join(backupDir, p), path.join(target, p), { recursive: true });
      }
      // What this run wrote into folders the backup did not hold (a home that had CLAUDE.md but
      // no agents/) is not covered by the restore: remove it, or the half-install stays.
      for (const rel of written) {
        const top = rel.split("/")[0];
        if (!existing.includes(top)) fs.rmSync(path.join(target, rel), { force: true });
      }
      console.error("restored " + existing.join(", ") + " from " + backupDir);
    } else {
      for (const rel of written) fs.rmSync(path.join(target, rel), { force: true });
      for (const d of ["agents", "pipeline"]) {
        const dir = path.join(target, d);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      }
      console.error("removed the " + written.length + " file(s) this run wrote");
    }
  } catch (e) {
    console.error("rollback itself failed: " + e.message + " — inspect " + target + " by hand");
  }
  process.exit(1);
}

// --- copy --------------------------------------------------------------------------------
for (const rel of files) {
  const src = path.join(HERE, rel);
  const dst = path.join(target, rel);
  const text = rewrite(fs.readFileSync(src, "utf8"));
  if (dry) {
    console.log("would write " + dst);
    continue;
  }
  try {
    atomicWrite(dst, text);
  } catch (e) {
    rollback("could not write " + dst + ": " + e.message); // a half-copied home is the state this must never leave
  }
  written.push(rel);
}
// Prune what the checkout retired. Agents: any .md the manifest no longer names (the folder is
// this pipeline's). Pipeline scripts: only the ones a PREVIOUS install from here recorded in
// pipeline/.claudrules.json — a script the developer keeps beside ours is never touched, and a
// retired module of ours (one that would still load under its old name, a stale test that would
// keep running) goes. The same manifest-of-what-I-wrote the Linux bundle keeps.
const agentsDir = path.join(target, "agents");
if (fs.existsSync(agentsDir)) {
  for (const f of fs.readdirSync(agentsDir)) {
    if (f.endsWith(".md") && !files.includes("agents/" + f)) {
      if (dry) console.log("would remove retired agent " + f);
      else {
        fs.rmSync(path.join(agentsDir, f), { force: true });
        console.log("removed retired agent: " + f);
      }
    }
  }
}
const pipelineSidecar = path.join(target, "pipeline", ".claudrules.json");
const previouslyInstalled = (() => {
  try {
    return JSON.parse(fs.readFileSync(pipelineSidecar, "utf8")).files || [];
  } catch {
    return [];
  }
})();
for (const rel of previouslyInstalled) {
  if (!rel.startsWith("pipeline/") || files.includes(rel)) continue;
  if (dry) console.log("would remove retired script " + rel);
  else {
    fs.rmSync(path.join(target, rel), { force: true });
    console.log("removed retired script: " + rel);
  }
}
if (!dry) atomicWrite(pipelineSidecar, JSON.stringify({ from: "ClaudRules", installedAt: new Date().toISOString(), files: files.filter((f) => f.startsWith("pipeline/")) }, null, 2) + "\n");
if (dry) {
  for (const p of projects) console.log("would install project skills into " + path.join(p, ".claude", "skills"));
  console.log("dry run: nothing written");
  process.exit(0);
}
console.log("written " + written.length + " file(s) into " + target);

// --- verify, then wire in ------------------------------------------------------------------
const node = process.execPath;
const run = (script, extra) => execFileSync(node, [path.join(target, "pipeline", script)].concat(extra || []), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const prefixArgs = path.resolve(prefix) === path.resolve(os.homedir()) ? [] : ["--prefix", prefix];
try {
  run("test.js", prefixArgs);
  console.log("regression suite: pass");
} catch (e) {
  const out = String(e.stdout || "");
  rollback("regression suite FAILED:\n" + out.split("\n").filter((l) => l.startsWith("FAIL")).join("\n") + (e.stderr ? "\n" + String(e.stderr) : ""));
}
// Where this checkout lives, for export-rules.js: the pointer is machine-local and is never
// exported (export-rules.js copies only *.js and the bundle out of pipeline/).
const pointer = path.join(target, "pipeline", "rules-repo.local");
try {
  atomicWrite(pointer, HERE + "\n");
  written.push("pipeline/rules-repo.local");
} catch (e) {
  rollback("could not write " + pointer + ": " + e.message);
}
const settings = path.join(target, "settings.json");
let createdSettings = false;
if (!fs.existsSync(settings)) {
  atomicWrite(settings, "{\n}\n");
  createdSettings = true;
  console.log("created an empty " + settings);
}
try {
  console.log(run("install-hooks.js", prefixArgs).trim());
} catch (e) {
  if (createdSettings) fs.rmSync(settings, { force: true });
  rollback("install-hooks.js refused:\n" + String(e.stderr || e.stdout || e.message).trim());
}

// --- project skills -----------------------------------------------------------------------
for (const p of projects) {
  const name = path.basename(p);
  const from = path.join(HERE, "project-skills", name);
  const skillsDir = path.join(p, ".claude", "skills");
  const sidecar = path.join(skillsDir, ".claudrules.json");
  if (!fs.existsSync(from)) {
    console.log("no project skills for " + name + " in this checkout");
    continue;
  }
  const prev = fs.existsSync(sidecar) ? JSON.parse(fs.readFileSync(sidecar, "utf8")).skills || [] : [];
  const now = [];
  for (const s of fs.readdirSync(from)) {
    const src = path.join(from, s, "SKILL.md");
    if (!fs.existsSync(src)) continue;
    atomicWrite(path.join(skillsDir, s, "SKILL.md"), rewrite(fs.readFileSync(src, "utf8")));
    now.push(s);
  }
  // Prune only what THIS repo installed before: the project may hold skills of its own.
  for (const s of prev) {
    if (!now.includes(s)) {
      fs.rmSync(path.join(skillsDir, s), { recursive: true, force: true });
      console.log("removed retired project skill: " + name + "/" + s);
    }
  }
  fs.mkdirSync(skillsDir, { recursive: true });
  atomicWrite(sidecar, JSON.stringify({ from: "ClaudRules", installedAt: new Date().toISOString(), skills: now }, null, 2) + "\n");
  console.log("project skills for " + name + ": " + now.join(", "));
  if (posix && name === "moon-terminal") {
    console.log("NOTE: the moon-terminal skills carry Windows/MSVC build commands (PowerShell, x86_64-pc-windows-msvc); on this OS follow the repo's Linux ## Commands block instead of the skill's commands");
  }
}

console.log("\ndone. Agents load at session start: restart Claude Code (or /compact in an open chat) to pick up the rules.");
