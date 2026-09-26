#!/usr/bin/env node
// Leak review of FOREIGN commits before they are built. Five modes:
//   status          (SessionStart hook / by hand) - how many commits by other authors sit on
//                   origin/main past the reviewed marker; prints one line, never blocks
//   diff [--out f]  - writes those commits' code (git show per commit), the Cargo.lock delta,
//                   the fork-pin deltas, a signature pre-scan and the project's declared secret
//                   surface (the `## Secrets` section of its repo file) into one file for the
//                   `leak-review` agent, which has no shell
//   mark            - records origin/main as reviewed (.git/leak-reviewed: inside .git, so it is
//                   never tracked and never published)
//   others          - parallel work: every commit by others on origin/main since this
//                   developer's last own commit, with the files it touched, and the open pull
//                   requests (gh) — what to read BEFORE taking a task in a repo with other
//                   contributors, so the same thing is not built twice (rules §1). `status`
//                   prints one PARALLEL WORK line when there is anything to read.
//   ack-release     - records origin/main as read for the RELEASE SURFACE (.git/release-surface-seen):
//                   the paths the repo file declares under `## Release surface` (lib/release.js).
//                   `status` and `others` print a RELEASE SURFACE line for every commit by
//                   others past that marker and every open PR that touches one of them; `diff`
//                   lists them first in the report. `mark` does not move this marker on purpose.
//
// The marker is per clone on purpose: a review done on this machine says nothing about another.
// Build scripts, code generators and dependency code all run at COMPILE time, so the gate this
// serves is "reviewed before the first build that includes them" — a build "just to see" is
// already late. What counts as secret is the PROJECT's to say, not this script's: the repo file
// declares it (`secretsSection`), and the script only carries the stack-agnostic patterns.
//
// The git plumbing (identity, tips, marker, foreign commits) is lib/git.js; the parallel-work
// check is lib/parallel.js, the release surface lib/release.js and the repo-file sections
// lib/repofile.js. This file is the leak review itself and the modes.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { git, repoRoot, markerPath, mainTip, foreignCommits, fetchMain } = require("./lib/git");
const { parallelReport, statusLine, openPRs } = require("./lib/parallel");
const { readStdin, parseHook } = require("./lib/hook");
const { escapeRe } = require("./lib/stacks");
const { REPO_FILES, section } = require("./lib/repofile");
const { releaseChanges, releaseLines, matchRelease, ackRelease } = require("./lib/release");

// --- signature pre-scan --------------------------------------------------------------------
// What data exfiltration looks like in a diff, as text patterns. A hit is a place for the agent
// to start, not a verdict; an empty scan is not a pass either — the agent reads the code anyway.
const SIGNATURES = [
  ["network endpoint", /\b(?:https?:\/\/[^\s"')]+|wss?:\/\/[^\s"')]+|\b\d{1,3}(?:\.\d{1,3}){3}\b)/],
  ["network API", /\b(?:reqwest|hyper|ureq|curl|TcpStream|UdpSocket|std::net|tokio::net|smol::net|async_std::net|websocket|tungstenite|ToSocketAddrs|lookup_host)\b/],
  // Bare `token`/`seed` are everyday identifiers (peer-token, seeded_from) — too noisy. The
  // project's own secret files and types come from its `## Secrets` section, not from here.
  ["secrets / credentials", /\b(?:key_slot|api_key|apikey|secret|password|passwd|credential|private_key|mnemonic|auth_token|access_token)\b/i],
  ["environment / process", /\b(?:env::var|std::env|getenv|Command::new|process::Command|spawn\(|std::process)\b/],
  ["file system outside data dir", /\b(?:home_dir|USERPROFILE|APPDATA|LOCALAPPDATA|read_dir|walkdir|glob::)\b|[/\\]\.(?:ssh|aws|gnupg|config)[/\\"]/],
  ["encoding / obfuscation", /\b(?:base64|from_hex|hex::|xor|obfusc|decode\(|include_bytes!|include_str!)\b|[A-Za-z0-9+/]{80,}={0,2}/],
  ["input capture", /\b(?:clipboard|Clipboard|screenshot|capture_screen|keylog|SetWindowsHookEx|GetAsyncKeyState|RawInput)\b/],
  ["build-time code", /^(?:\+\+\+|---) .*(?:build\.rs|proc_macro|\.cargo\/config|\.github\/workflows|Makefile|xtask)/m],
  ["telemetry / logging of data", /\b(?:telemetry|sentry|posthog|mixpanel|log::(?:info|debug|trace|warn)!\([^)]*(?:key|secret|password|token))/i],
  ["unsafe / FFI", /\b(?:unsafe\s*\{|extern\s+"C"|libc::|windows::Win32|dlopen|LoadLibrary)\b/],
];

// --- the project's declared secret surface --------------------------------------------------
// The repo file (any of REPO_FILES, all that exist) may carry a `## Secrets` section naming the
// files, types and paths that hold credentials, key material or encrypted config. It travels into
// the report verbatim, so the agent protects what THIS project protects, and its backticked names
// feed the pre-scan the way a hardcoded vault file name used to. Which copy is read (reviewed
// base vs working tree) is lib/repofile.js's rule, shared with the release surface.
function secretsSection(root, base) {
  return section(root, base, "Secrets");
}
// Backticked names from the section that look like a file, path, symbol or type: a separator
// inside (`servers.enc`, `config/crypto/`, `read_servers`, `schema.rs::ServersFile`) or 8+ chars
// (`ServersFile`). A short plain word (`open`, `Debug`, `high`) is prose the section uses for
// severity or an example and would hit every other line, drowning the real ones. A qualified
// name (`schema.rs::ServersFile`) also registers its last segment: code says `ServersFile`.
function declaredTokens(sections) {
  const out = new Set();
  const keep = (tok) => {
    if (/[\/.:_-]/.test(tok) || tok.length >= 8) out.add(tok);
  };
  for (const s of sections) {
    for (const m of s.text.matchAll(/`([^`\n]{4,80})`/g)) {
      const tok = m[1].trim();
      keep(tok);
      const at = tok.lastIndexOf("::");
      if (at !== -1 && at + 2 < tok.length) keep(tok.slice(at + 2));
    }
  }
  return [...out];
}
function declaredRe(tokens) {
  if (!tokens.length) return null;
  const esc = tokens.map(escapeRe);
  return new RegExp("(?:" + esc.join("|") + ")");
}

function prescan(diffText, tokens) {
  const hits = [];
  const declared = declaredRe(tokens || []);
  const declarationHit = new Set(); // one hit per declaring file, whether it was edited, deleted or renamed
  let file = "";
  let newLine = 0;
  for (const raw of diffText.split("\n")) {
    // The file that CARRIES the declaration is a hit however it was touched — the `---` side
    // catches a deletion or a rename, whose `+++` side is /dev/null or another name.
    if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
      const side = raw.slice(4).replace(/^[ab]\//, "");
      if (REPO_FILES.includes(side) && !declarationHit.has(side)) {
        declarationHit.add(side);
        const gone = raw.startsWith("--- ");
        hits.push({ label: "declaration edited", file: side, line: 0, text: gone ? "(repo file that may carry ## Secrets was changed, deleted or renamed — compare its section against the reviewed base)" : "(repo file that may carry ## Secrets was added — the reviewed base has no copy)" });
      }
    }
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      // A touched file that the project itself names as secret is a starting point on its own,
      // whatever its added lines say.
      if (declared && declared.test(file)) hits.push({ label: "declared secret file", file, line: 0, text: "(file named in the project's ## Secrets section)" });
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      newLine = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith("-") ) continue; // removed code cannot leak
    if (raw.startsWith("+")) newLine += 1;
    else if (!raw.startsWith("\\")) newLine += 1;
    if (!raw.startsWith("+")) continue; // only ADDED lines are the new surface
    const line = raw.slice(1);
    for (const [label, re] of SIGNATURES) {
      if (re.test(line)) hits.push({ label, file, line: newLine, text: line.trim().slice(0, 160) });
    }
    if (declared && declared.test(line)) hits.push({ label: "declared secret surface", file, line: newLine, text: line.trim().slice(0, 160) });
  }
  return hits;
}

// Cargo.lock: new packages and changed sources are supply-chain surface — the code that runs is
// not in this diff at all.
function lockDelta(root, base, tip) {
  // A repo with no Cargo.lock at all (the hook is global) has no supply-chain delta to report —
  // that is "absent", not "unreadable".
  const exists = (rev) => git(["cat-file", "-e", rev + ":Cargo.lock"], { cwd: root }) !== null;
  if (!exists(tip) && !exists(base)) return Object.assign(lockDiff("", ""), { unread: [], absent: true });
  const before = git(["show", base + ":Cargo.lock"], { cwd: root });
  const after = git(["show", tip + ":Cargo.lock"], { cwd: root });
  // A read that failed is not an empty lock: "no new packages" on a blob git could not show
  // would pass a real dependency change off as clean. Say which side was unreadable — and do not
  // diff against "" for that side, which would list the whole lock as NEW.
  const unread = [];
  if (before === null) unread.push(base.slice(0, 12));
  if (after === null) unread.push(tip.slice(0, 12));
  if (unread.length) return Object.assign(lockDiff("", ""), { unread, absent: false });
  return Object.assign(lockDiff(before, after), { unread, absent: false });
}

// Pure: two Cargo.lock texts in, the supply-chain delta out.
function lockDiff(before, after) {
  const parse = (txt) => {
    const m = new Map();
    for (const block of txt.split("\n[[package]]\n").slice(1)) {
      const name = (block.match(/^name = "([^"]+)"/m) || [])[1];
      const version = (block.match(/^version = "([^"]+)"/m) || [])[1];
      const source = (block.match(/^source = "([^"]+)"/m) || [])[1] || "path";
      if (name) m.set(name + "@" + version, source);
    }
    return m;
  };
  const a = parse(before);
  const b = parse(after);
  const added = [];
  const sourceChanged = [];
  for (const [k, src] of b) {
    if (!a.has(k)) {
      const name = k.split("@")[0];
      const hadOtherVersion = [...a.keys()].some((x) => x.split("@")[0] === name);
      added.push((hadOtherVersion ? "bumped " : "NEW ") + k + " <- " + src);
    } else if (a.get(k) !== src) {
      // A moved git rev on the same URL is a pin move, listed once below with the fork's diff;
      // a changed URL or registry is the supply-chain signal this list is for.
      const stripRev = (x) => x.replace(/#[0-9a-f]+$/, "");
      if (stripRev(a.get(k)) !== stripRev(src)) sourceChanged.push(k + ": " + a.get(k) + " -> " + src);
    }
  }
  // fork pins: git sources whose rev moved
  const pins = [];
  const gitRev = (src) => (src.match(/^git\+([^#?]+)(?:\?[^#]*)?#([0-9a-f]+)/) || []).slice(1);
  const byRepo = (m) => {
    const r = new Map();
    for (const [k, src] of m) {
      const [url, rev] = gitRev(src);
      if (url) r.set(url, rev);
    }
    return r;
  };
  const ra = byRepo(a);
  const rb = byRepo(b);
  for (const [url, rev] of rb) if (ra.has(url) && ra.get(url) !== rev) pins.push({ url, from: ra.get(url), to: rev });
  return { added, sourceChanged, pins };
}

// A moved fork pin: the fork's own diff, from cargo's bare git db (every fetched rev is there).
// Returns { diff, stat } or { why } — the three ways this fails are three different actions for
// the reader (no db at all / no clone of this fork / rev not fetched), so they are named apart.
function forkDiff(pin) {
  const db = path.join(os.homedir(), ".cargo", "git", "db");
  if (!fs.existsSync(db)) return { why: "no cargo git db on this machine" };
  const slug = pin.url.replace(/\.git$/, "").split("/").pop().toLowerCase();
  // Exact slug + "-" + hash: `moonui-…` must not be taken for `moon-ui-…`.
  const dir = fs.readdirSync(db).find((d) => new RegExp("^" + escapeRe(slug) + "-[0-9a-f]+$", "i").test(d));
  if (!dir) return { why: "no clone of this fork in the cargo git db" };
  const repo = path.join(db, dir);
  const has = (rev) => git(["cat-file", "-e", rev + "^{commit}"], { cwd: repo }) !== null;
  // The new rev is usually NOT here yet: cargo fetches it at the build this gate precedes. A
  // fetch by SHA is a download, not a compile, so it is the safe way to get the diff first.
  if (!has(pin.to) || !has(pin.from)) git(["fetch", "--quiet", pin.url, pin.to, pin.from], { cwd: repo, timeout: 60000 });
  if (!has(pin.to) || !has(pin.from)) return { why: "rev not fetched locally (git fetch by sha failed): run `cargo fetch` — download only, no compile — and re-run diff" };
  const stat = git(["diff", "--stat", pin.from + ".." + pin.to], { cwd: repo });
  const diff = git(["diff", pin.from + ".." + pin.to], { cwd: repo });
  return diff === null ? { why: "git diff failed in " + repo } : { repo, stat: stat || "", diff };
}

function buildReport(root) {
  const f = foreignCommits(root);
  const head = [];
  const body = [];
  const incomplete = []; // anything the report could NOT include — the reader must see it
  head.push("# leak review input · " + new Date().toISOString());
  head.push(
    "repo: " + root + " · reviewed marker: " + f.base.slice(0, 12) +
      (f.markerBroken ? " (STORED MARKER NO LONGER RESOLVES — history rewritten? base fell back to your last own commit)" : f.firstRun ? " (first run: your last own commit)" : "") +
      " · origin/main: " + f.tip.slice(0, 12)
  );
  head.push("me: " + f.me + " · commits past marker: " + f.all.length + " · by others: " + f.foreign.length);
  if (!f.foreign.length) {
    head.push("", "nothing by other authors to review");
    return { text: head.join("\n"), foreign: f.foreign, tip: f.tip, incomplete };
  }
  body.push("## commits by other authors");
  for (const c of f.foreign) body.push("- " + c.sha.slice(0, 12) + " " + c.name + " <" + c.email + "> " + c.subject);
  const secrets = secretsSection(root, f.base);
  body.push("", "## secrets declared by the project (protect these FIRST)");
  if (secrets.length) for (const sct of secrets) body.push("### from " + sct.file + " (" + sct.at + ")", sct.text, "");
  else body.push("- no `## Secrets` section in " + REPO_FILES.join(" / ") + ": hunt credentials, key material and encrypted config on your own, and say in the verdict that the project declares none — the section is the finding to write into the repo file");
  // The release surface: the paths that decide what users install. Judged over the SAME commits
  // as the rest of the report (the leak window), whatever the release marker says — the agent
  // reads these diffs first and names each touched file in its verdict.
  const rel = releaseChanges(root, f.base);
  body.push("", "## release surface declared by the project (what users install — read these diffs FIRST; every touched file is `high` until shown otherwise)");
  if (rel.declared) {
    for (const sct of rel.sections) body.push("### from " + sct.file + " (" + sct.at + ")", sct.text, "");
    const touched = [];
    for (const c of f.foreign) {
      // first-parent: a plain diff-tree of a merge commit lists no files at all.
      const names = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-merges=first-parent", c.sha], { cwd: root });
      if (names === null) {
        incomplete.push("commit " + c.sha.slice(0, 12) + ": file list unreadable — whether it touched the release surface is UNKNOWN");
        continue;
      }
      const files = matchRelease(names.split("\n"), rel.patterns);
      if (files.length) touched.push("- " + c.sha.slice(0, 12) + " " + c.name + " — " + c.subject.slice(0, 70) + " — " + files.join(", "));
    }
    body.push(touched.length ? "### touched by the commits under review" : "### touched by the commits under review: none", ...touched);
  } else body.push("- no `## Release surface` section in " + REPO_FILES.join(" / ") + ": treat the CI/release workflow files, their scripts and any self-update code as that surface, and say in the verdict that the project declares none");
  let combined = "";
  for (const c of f.foreign) {
    // first-parent: a plain `show` of a merge commit prints no diff, and the touched list above
    // would then name a file the code section never shows.
    const show = git(["show", "--format=commit %H%nauthor %an <%ae>%ndate %ad%n%n    %s%n", "--stat", "-p", "--diff-merges=first-parent", c.sha], { cwd: root });
    if (show === null) {
      // A blank where a commit's code should be is the one thing a reviewer cannot notice.
      incomplete.push("commit " + c.sha.slice(0, 12) + " (" + c.subject.slice(0, 60) + "): git show failed — shallow clone, missing object or output past 64 MB");
      combined += "commit " + c.sha + "\n!! NOT READ: git show failed for this commit — its code is NOT in this report\n\n";
      continue;
    }
    combined += show + "\n";
  }
  const hits = prescan(combined, declaredTokens(secrets));
  const lock = lockDelta(root, f.base, f.tip);
  for (const rev of lock.unread) incomplete.push("Cargo.lock at " + rev + " could not be read: the dependency delta below is UNKNOWN, not empty");
  body.push("", "## pre-scan (" + hits.length + " hit(s) on ADDED lines — starting points, not verdicts)");
  for (const h of hits.slice(0, 200)) body.push("- [" + h.label + "] " + h.file + ":" + h.line + " — " + h.text);
  if (hits.length > 200) body.push("- … " + (hits.length - 200) + " more");
  body.push("", "## Cargo.lock");
  if (lock.absent) body.push("- no Cargo.lock in this repository");
  else if (lock.unread.length) body.push("- UNKNOWN: Cargo.lock unreadable at " + lock.unread.join(", "));
  else body.push(lock.added.length ? lock.added.map((x) => "- " + x).join("\n") : "- no new or bumped packages");
  if (lock.sourceChanged.length) body.push(lock.sourceChanged.map((x) => "- SOURCE CHANGED " + x).join("\n"));
  for (const pin of lock.pins) {
    const fd = forkDiff(pin);
    if (fd.diff !== undefined) {
      pin.diff = fd.diff;
      body.push("- fork pin moved: " + pin.url + " " + pin.from.slice(0, 10) + " -> " + pin.to.slice(0, 10) + " (fork diff below, " + fd.stat.split("\n").pop().trim() + ")");
    } else {
      incomplete.push("fork " + pin.url + " " + pin.from.slice(0, 10) + ".." + pin.to.slice(0, 10) + ": " + fd.why);
      body.push("- fork pin moved: " + pin.url + " " + pin.from.slice(0, 10) + " -> " + pin.to.slice(0, 10) + " — DIFF NOT INCLUDED: " + fd.why);
    }
  }
  body.push("", "## code (git show per commit)");
  body.push(combined);
  for (const pin of lock.pins) {
    if (!pin.diff) continue;
    body.push("## fork diff " + pin.url + " " + pin.from.slice(0, 10) + ".." + pin.to.slice(0, 10));
    body.push(pin.diff);
  }
  // The size and the code offset go FIRST: a reader with a 2000-line window that stops at the
  // pre-scan has reviewed nothing, and nothing else in the file would tell it so. Both numbers
  // are measured on the assembled text (elements hold multi-line strings), then corrected for the
  // one line this insertion adds.
  const assembled = head.concat(incompleteBlock(incomplete)).concat([""]).concat(body).join("\n").split("\n");
  const codeStart = assembled.findIndex((l) => l.startsWith("## code (git show per commit)")) + 2; // 1-based + the LINES line
  const total = assembled.length + 1;
  assembled.splice(1, 0, "LINES: " + total + " — read ALL of them (offset+limit until the end); the code starts at line " + codeStart + ". A verdict on a partial read is not a verdict.");
  return { text: assembled.join("\n"), foreign: f.foreign, tip: f.tip, hits, lock, incomplete };
}

function incompleteBlock(incomplete) {
  if (!incomplete.length) return [];
  return ["", "## INCOMPLETE — the report could not include:"].concat(incomplete.map((x) => "- " + x));
}

// A hook is spawned with the payload on stdin and its own idea of a working directory; the
// payload's cwd is the project. By hand there is no payload and reading fd 0 would block.

// The SessionStart payload's cwd, or "" by hand: the hook runs from wherever the harness puts it.
const hookCwd = () => parseHook(readStdin()).cwd || "";

function main() {
  const mode = process.argv[2] || "status";
  const cwd = mode === "status" ? hookCwd() : "";
  if (cwd && fs.existsSync(cwd)) process.chdir(cwd);
  const root = repoRoot();
  if (!root) {
    if (mode !== "status") process.stderr.write("leak-check: not inside a git repository\n");
    return;
  }
  // Its own fetch, bounded: the order of the global and the project SessionStart hooks is not
  // fixed anywhere, and reading a stale origin/main would report nothing for a whole session —
  // and `others` is the command the rule prescribes before the first edit, where a stale
  // origin/main would miss exactly the commits it exists to show. Only where origin/main exists
  // at all: a repo without it has nothing to say, and must not pay a remote round trip to learn so.
  const hasMain = git(["rev-parse", "--verify", "origin/main"], { cwd: root }) !== null;
  // `ack-release` and `mark` deliberately do NOT fetch: they record the tip the developer was
  // SHOWN. A fetch here could pull a commit that landed since the listing and pin the marker past
  // it — acknowledged unread. A stale tip errs the other way: what landed since stays ahead of
  // the marker and is reported next time.
  if ((mode === "status" || mode === "others") && hasMain) fetchMain(root);
  if (mode === "status") {
    if (!hasMain) return; // no such remote branch: nothing to say
    const f = foreignCommits(root);
    if (f.markerBroken) {
      const marker = markerPath(root);
      process.stdout.write("LEAK REVIEW: the stored marker (" + marker + ") no longer resolves — history rewritten or object dropped; base fell back to your last own commit " + f.base.slice(0, 8) + ".\n");
      // Nothing by others to review from that base → the recomputed base is a safe place to
      // re-anchor; otherwise the same warning would print at every session start forever.
      if (!f.foreign.length && f.tip) {
        fs.writeFileSync(marker, f.tip + "\n", "utf8");
        process.stdout.write("LEAK REVIEW: marker re-anchored at " + f.tip.slice(0, 12) + " (no unreviewed commits by others since your last own commit).\n");
      }
    }
    if (!f.foreign.length) {
      if (process.argv.includes("--verbose")) process.stdout.write("leak-check: no unreviewed commits by others on origin/main\n");
    } else {
      const who = [...new Set(f.foreign.map((c) => c.name))].join(", ");
      process.stdout.write(
        "LEAK REVIEW PENDING: " + f.foreign.length + " commit(s) by others on origin/main not yet reviewed (" + who + "). Before the first build that includes them: " +
          'node "' + __filename + '" diff --out <file>, then the leak-review agent on that file, then `mark`. Commits: ' +
          f.foreign.map((c) => c.sha.slice(0, 8)).join(" ") + "\n"
      );
    }
    // One gh call serves both lines: the release check needs the open PRs whenever the project
    // declares a surface, the parallel-work line only where others commit. Bounded, so a slow
    // forge cannot hold the session start; "unavailable" is said by both, never swallowed.
    const rel = releaseChanges(root);
    const prs = rel.declared ? openPRs(root, 5000) : undefined;
    process.stdout.write(statusLine(root, f, __filename, prs));
    if (rel.declared) process.stdout.write(releaseLines(rel, prs.prs, prs.why, __filename));
    return;
  }
  if (mode === "others") {
    const rep = parallelReport(root);
    process.stdout.write(rep.text + "\n");
    const rel = releaseChanges(root);
    if (rel.declared) {
      process.stdout.write(
        releaseLines(rel, rep.prs, rep.prsWhy, __filename) ||
          "release surface: nothing by others since " + rel.base.slice(0, 8) + (rel.firstRun ? " (your last own commit)" : " (last ack-release)") + ", no open PR touches it\n"
      );
    }
    return;
  }
  if (mode === "ack-release") {
    const tip = mainTip(root);
    if (!tip) {
      process.stderr.write("leak-check: no origin/main to acknowledge\n");
      process.exitCode = 1;
      return;
    }
    const rel = releaseChanges(root);
    if (!rel.declared) {
      process.stderr.write("leak-check: no `## Release surface` section in " + REPO_FILES.join(" / ") + " — nothing to acknowledge\n");
      process.exitCode = 1;
      return;
    }
    const marker = ackRelease(root, tip);
    process.stdout.write("release surface read up to " + tip.slice(0, 12) + " -> " + marker + (rel.commits.length ? " — acknowledged: " + rel.commits.map((c) => c.sha.slice(0, 8) + " " + c.files.join(",")).join(" · ") : " (nothing was pending)") + "\n");
    return;
  }
  if (mode === "diff") {
    const at = process.argv.indexOf("--out");
    const out = at !== -1 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : path.join(os.tmpdir(), "leak-review-" + Date.now() + ".md");
    const r = buildReport(root);
    fs.writeFileSync(out, r.text, "utf8");
    process.stdout.write("written: " + out + "\n" + r.text.split("\n").slice(0, 5).join("\n") + "\n");
    if (r.hits) {
      const lockNote = r.lock.unread.length ? "UNKNOWN (unreadable at " + r.lock.unread.join(", ") + ")" : r.lock.absent ? "no Cargo.lock in this repo" : "+" + r.lock.added.length + " packages, " + r.lock.pins.length + " pin(s) moved";
      process.stdout.write("pre-scan hits: " + r.hits.length + " · lock: " + lockNote + "\n");
    }
    if (r.incomplete.length) process.stdout.write("INCOMPLETE (" + r.incomplete.length + "):\n" + r.incomplete.map((x) => "  - " + x).join("\n") + "\n");
    return;
  }
  if (mode === "mark") {
    const tip = mainTip(root); // the same tip the judgement used: the private fetched ref when ahead
    if (!tip) {
      process.stderr.write("leak-check: no origin/main to mark\n");
      process.exitCode = 1;
      return;
    }
    const marker = markerPath(root);
    fs.writeFileSync(marker, tip + "\n", "utf8");
    process.stdout.write("marked reviewed: " + tip.slice(0, 12) + " -> " + marker + "\n");
    return;
  }
  process.stderr.write("leak-check: unknown mode " + mode + " (status|diff|mark|others|ack-release)\n");
  process.exitCode = 2;
}

if (require.main === module) main();
module.exports = { prescan, lockDiff, SIGNATURES, secretsSection, declaredTokens, REPO_FILES, buildReport };
