#!/usr/bin/env node
// Packs the pipeline (CLAUDE.md + agents + scripts) into ONE self-contained shell installer that
// can be scp'd onto a Linux box — a VS Code Remote-SSH session runs Claude Code THERE, with its
// own $HOME, so nothing from this machine's ~/.claude is in scope.
//
//   node make-bundle.js                 -> ~/.claude/pipeline/install-pipeline.sh
//   node make-bundle.js --out <path>    -> somewhere else
//
// The installer: checks its prerequisites, backs up what it replaces (and says plainly when the
// backup failed), unpacks, prunes files a previous bundle installed that this one dropped, runs
// the regression suite, and only THEN registers the hooks — a checker that fails its own tests
// must never end up wired into every turn.

const fs = require("fs");
const path = require("path");
const os = require("os");

const { pipelineScripts } = require("./lib/root");
const { escapeRe } = require("./lib/stacks");

const HOME = os.homedir();
const CLAUDE = path.join(HOME, ".claude");
const PIPE = path.join(CLAUDE, "pipeline");

// What travels: CLAUDE.md, every agent, and every .js under pipeline/, lib/ and tests/
// (lib/root.js pipelineScripts — the same list export-rules.js ships). settings.json deliberately
// does NOT travel: on the source machine it carries Windows-only hooks and permission entries
// full of local paths; the installer edits the target's settings.json in place instead, adding
// just the five pipeline hooks. The list is built inside build(), so requiring this module for
// rewriteForPosix has no side effect on a home with no agents/.
function filesToPack() {
  return [
    { src: path.join(CLAUDE, "CLAUDE.md"), dst: ".claude/CLAUDE.md" },
    ...fs
      .readdirSync(path.join(CLAUDE, "agents"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ src: path.join(CLAUDE, "agents", f), dst: ".claude/agents/" + f })),
    ...pipelineScripts(PIPE).map((f) => ({ src: path.join(PIPE, f), dst: ".claude/pipeline/" + f })),
  ];
}

// The handful of places that name this machine. An agent has no shell, so its paths must be
// ABSOLUTE on the target too — the installer substitutes the real prefix at write time rather
// than leaving a `~` no Read tool would expand. The anchor is THIS machine's ~/.claude, whatever
// the user is called, in either separator; the tail of ordinary segments is carried over with
// forward slashes.
const HOME_RE = new RegExp("(?:" + escapeRe(CLAUDE) + "|" + escapeRe(CLAUDE.replace(/\\/g, "/")) + ")((?:[\\/][\\w.-]+)*)", "g");
function rewriteForPosix(text, homePlaceholder) {
  let out = text;
  out = out.replace(HOME_RE, (_m, tail) => homePlaceholder + "/.claude" + tail.replace(/\\/g, "/"));
  // Normalise separators that survive right after a substituted path — a trailing one, as in
  // "…\pipeline\", is not part of the path pattern above and would ship as `pipeline\`.
  const tailRe = new RegExp(escapeRe(homePlaceholder) + "[\\w./\\\\-]*", "g");
  out = out.replace(tailRe, (m) => m.replace(/\\/g, "/"));
  // The tilde caveat named PowerShell; the rule (absolute path + --hand) is the same everywhere.
  out = out.replace(
    /PowerShell does not expand `~` for a native argument, and/g,
    "a `~` is not expanded when the path reaches a tool rather than a shell, and"
  );
  return out;
}

function build(outPath) {
  const parts = [];
  for (const f of filesToPack()) {
    if (!fs.existsSync(f.src)) {
      // Never ship an incomplete bundle: the missing file would drop out of the manifest, and the
      // installer's prune would then DELETE the copy already installed on the target.
      throw new Error("cannot pack a missing file: " + f.src);
    }
    const body = rewriteForPosix(fs.readFileSync(f.src, "utf8"), "__CLAUDE_HOME__");
    parts.push({ dst: f.dst, b64: Buffer.from(body, "utf8").toString("base64") });
  }
  const generatedAt = new Date().toISOString();
  const manifest = JSON.stringify({ generatedAt, files: parts.map((p) => p.dst) });

  const script = `#!/usr/bin/env bash
# Installs the Claude review pipeline into ~/.claude on this machine.
# Generated ${generatedAt} by make-bundle.js — do not edit by hand, regenerate.
#
# Usage:
#   bash install-pipeline.sh               install into $HOME
#   bash install-pipeline.sh --prefix DIR  install into DIR (absolute path; for a sandbox check)
#   bash install-pipeline.sh --dry-run     report what would happen, write nothing
#   bash install-pipeline.sh --force-no-backup   proceed even if the backup could not be made
set -euo pipefail

PREFIX="\$HOME"
DRY=0
FORCE=0
while [ \$# -gt 0 ]; do
  case "\$1" in
    --prefix)
      [ \$# -ge 2 ] || { echo "--prefix needs a directory" >&2; exit 2; }
      PREFIX="\$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force-no-backup) FORCE=1; shift ;;
    -h|--help) sed -n '4,9p' "\$0"; exit 0 ;;
    *) echo "unknown argument: \$1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\\n' "\$*"; }
die() { printf '%s\\n' "\$*" >&2; exit 1; }

# A quoted '~/foo' is never expanded by the shell, and a relative prefix would install into a
# directory nobody meant. Resolve one and refuse the other.
case "\$PREFIX" in
  "~") PREFIX="\$HOME" ;;
  "~/"*) PREFIX="\$HOME/\${PREFIX#\\~/}" ;;
esac
case "\$PREFIX" in
  /*) ;;
  [A-Za-z]:*) ;;               # a Windows path, when run from Git Bash
  *) die "--prefix must be an absolute path (got: \$PREFIX)" ;;
esac
[ -e "\$PREFIX" ] && [ ! -d "\$PREFIX" ] && die "--prefix exists and is not a directory: \$PREFIX"

# --- prerequisites ---------------------------------------------------------------------------
for tool in node base64 tar; do
  command -v "\$tool" >/dev/null 2>&1 || die "\$tool is required and was not found on PATH"
done
NODE_MAJOR="\$(node -p 'process.versions.node.split(".")[0]')"
[ "\$NODE_MAJOR" -ge 16 ] || die "node \$NODE_MAJOR is too old; 16+ is needed"
say "node \$(node -v) · target \$PREFIX/.claude"

TMPS=()
cleanup() { for t in "\${TMPS[@]:-}"; do [ -n "\$t" ] && rm -f "\$t"; done; }
trap cleanup EXIT

# --- backup ----------------------------------------------------------------------------------
STAMP="\$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="\$PREFIX/.claude/pipeline-backup-\$STAMP.tar.gz"
if [ "\$DRY" -eq 0 ] && [ -d "\$PREFIX/.claude" ]; then
  EXISTING=()
  for p in CLAUDE.md agents pipeline settings.json; do
    [ -e "\$PREFIX/.claude/\$p" ] && EXISTING+=("\$p")
  done
  if [ \${#EXISTING[@]} -gt 0 ]; then
    # Report the truth: a swallowed failure here would promise a safety net that does not exist,
    # right before the next step overwrites the files it was supposed to protect. And never ask an
    # interactive question — the intended invocation is \`ssh host 'bash install-pipeline.sh'\`,
    # where there is no tty to answer it.
    TAR_ERR="\$(tar -czf "\$BACKUP" -C "\$PREFIX/.claude" "\${EXISTING[@]}" 2>&1)" && TAR_OK=1 || TAR_OK=0
    if [ "\$TAR_OK" -eq 1 ]; then
      say "backup: \$BACKUP"
    else
      say "backup FAILED: \$(printf '%s' "\$TAR_ERR" | head -1)"
      if [ "\$FORCE" -eq 1 ]; then
        say "continuing without a backup because --force-no-backup was given."
      else
        die "refusing to overwrite \$PREFIX/.claude with no backup. Fix the cause, or rerun with --force-no-backup if you accept the risk."
      fi
    fi
  fi
fi

# --- unpack ----------------------------------------------------------------------------------
# node does the placeholder substitution, not sed: a prefix containing & or | is a sed
# metacharacter and would corrupt every path it wrote, silently and with exit 0.
write_file() {
  local dst="\$PREFIX/\$1"
  if [ "\$DRY" -eq 1 ]; then say "would write: \$dst"; return; fi
  mkdir -p "\$(dirname "\$dst")"
  local tmp="\$dst.tmp.\$\$"
  TMPS+=("\$tmp")
  printf '%s' "\$2" | base64 -d > "\$tmp"
  PREFIX="\$PREFIX" node -e '
    const fs = require("fs");
    const f = process.argv[1];
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").split("__CLAUDE_HOME__").join(process.env.PREFIX));
  ' "\$tmp"
  mv "\$tmp" "\$dst"
}

${parts.map((p) => `write_file '${p.dst}' '${p.b64}'`).join("\n")}

[ "\$DRY" -eq 1 ] || say "files: ${parts.length} written"

# --- prune what a previous bundle left behind ------------------------------------------------
# An angle that was renamed or retired would otherwise keep loading forever: the harness reads
# every file in agents/, not the ones this bundle happens to ship.
if [ "\$DRY" -eq 0 ]; then
  PREFIX="\$PREFIX" MANIFEST_NEW='${manifest.replace(/'/g, "'\\''")}' node -e '
    const fs = require("fs"), path = require("path");
    const root = process.env.PREFIX;
    const mfPath = path.join(root, ".claude", "pipeline", "bundle-manifest.json");
    const next = JSON.parse(process.env.MANIFEST_NEW);
    let prev = { files: [] };
    try { prev = JSON.parse(fs.readFileSync(mfPath, "utf8")); } catch {}
    const keep = new Set(next.files);
    const stale = (prev.files || []).filter((f) => !keep.has(f));
    for (const rel of stale) {
      const p = path.join(root, rel);
      try { fs.unlinkSync(p); console.log("pruned: " + rel); } catch {}
    }
    fs.writeFileSync(mfPath, JSON.stringify(next, null, 1), "utf8");
  '
fi

# --- acceptance BEFORE wiring anything up ----------------------------------------------------
if [ "\$DRY" -eq 1 ]; then
  say "would run the regression suite, then register the Stop, UserPromptSubmit, SessionStart and PreToolUse (no-poll, ask-lang) hooks"
  say "dry run: nothing was written"
  exit 0
fi
if node "\$PREFIX/.claude/pipeline/test.js" --prefix "\$PREFIX" >/dev/null 2>&1; then
  say "regression suite: pass"
else
  say "regression suite: FAILED — the files are installed but NO hooks were registered, so"
  say "nothing of this runs automatically. See why:"
  say "  node \$PREFIX/.claude/pipeline/test.js --prefix \$PREFIX"
  exit 1
fi

# --- hooks -----------------------------------------------------------------------------------
if [ ! -f "\$PREFIX/.claude/settings.json" ]; then
  printf '{}\\n' > "\$PREFIX/.claude/settings.json"
  say "created an empty settings.json"
fi
node "\$PREFIX/.claude/pipeline/install-hooks.js" --prefix "\$PREFIX"

say ""
say "done. Three things this bundle deliberately did NOT do:"
say "  1. copy settings.json wholesale — only the five pipeline hooks were added; your"
say "     permissions, sounds and machine-specific hooks are untouched."
say "  2. bring the PROJECT CLAUDE.md — it is gitignored and its build commands are"
say "     Windows-specific. Write the Linux one in the repo checkout: build/lint/test/run as a"
say "     '## Commands' block, which is what stage 5 bootstraps against."
say "  3. verify how this machine names transcript directories. gate-check derives that from the"
say "     working directory; if it differs here, the by-hand digest falls back to the newest"
say "     transcript it can find and says which file it took — check that line on the first run."
say ""
say "Restart the Claude session afterwards: the named agents are read at session start."
`;

  fs.writeFileSync(outPath, script, "utf8");
  try {
    fs.chmodSync(outPath, 0o755);
  } catch {
    // chmod is meaningless on Windows; the installer is invoked as `bash install-pipeline.sh`
  }
  return { out: outPath, files: parts.length, bytes: script.length };
}

module.exports = { rewriteForPosix, build };

if (require.main === module) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const out = outAt !== -1 && args[outAt + 1] ? args[outAt + 1] : path.join(PIPE, "install-pipeline.sh");
  const r = build(out);
  console.log("bundle: " + r.out);
  console.log("packed " + r.files + " files, " + Math.round(r.bytes / 1024) + " KB");
  console.log("\nput it on the server and run:");
  console.log('  scp "' + r.out + '" user@host:~/');
  console.log("  ssh user@host 'bash ~/install-pipeline.sh'");
}
