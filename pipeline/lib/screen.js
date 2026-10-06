// The public-export screen. The rules repo is public and its main refuses force-pushes, so a
// project's identifier that rides an export is published for good — it happened once, through
// two test fixtures, and a later "neutral" commit did not take it back. export-rules.js runs
// `gate` before anything is staged — every file the commit could carry, by content and by name,
// the Linux bundle DECODED (its files ride as base64, where a plain grep sees nothing), the commit
// message and the author — and `pushGate` before a push, over every commit the push would send.
//
// The term list, pipeline/private-terms.local, lives beside the scripts and is never exported:
// export-rules.js copies the *.js of pipeline/, lib/ and tests/ (lib/root.js pipelineScripts), the
// agents, the bundle and the mods minus any *.local; make-bundle.js packs the same script list.
// It is this machine's list of what its projects call themselves — publishing it would be the
// very leak it exists to stop.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const TERMS_FILE = "private-terms.local";
// Shorter terms are typo-sized: "dex" matches "index", and a screen that refuses every export
// gets switched off. They are reported as ignored, never silently dropped.
const MIN_TERM = 4;
// The separator-blind pass (below) only for terms this long once reduced to letters and digits:
// shorter ones would start matching inside unrelated words.
const MIN_FOLDED = 6;
const BIG = { maxBuffer: 256 * 1024 * 1024 };

// Text from bytes as an editor on this machine may have saved them: UTF-8 with or without a BOM,
// or UTF-16 with its BOM (Windows PowerShell 5 `>` and Out-File write UTF-16LE). Read as UTF-8,
// a UTF-16 file is NUL-interleaved garbage that matches nothing — a false clean.
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.slice(2));
    for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
    return le.toString("utf16le");
  }
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// One literal term per line, matched case-insensitively; blank lines and `#` comments skipped.
// `terms` is null when the list could not be used: `missing` (no file) or `error` (unreadable,
// a directory, or an encoding that leaves NULs in the terms). Never an empty list read as clean.
function loadTerms(pipeDir) {
  const file = path.join(pipeDir, TERMS_FILE);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e && e.code === "ENOENT") return { file, terms: null, short: [], missing: true };
    return { file, terms: null, short: [], error: (e && (e.code || e.message)) || "unreadable" };
  }
  const all = decodeText(buf)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (all.some((t) => t.includes("\u0000"))) return { file, terms: null, short: [], error: "encoding leaves NUL bytes in the terms (save it as UTF-8)" };
  return { file, terms: all.filter((t) => t.length >= MIN_TERM), short: all.filter((t) => t.length < MIN_TERM) };
}

const fold = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// Every place in `text` that carries a term, as { line, term }. Two passes: the literal one per
// line (with its line number), then a separator-blind one over the whole text for the terms the
// first pass missed — `acme_branch`, `acme branch`, a term wrapped across a line break — reported
// at line 0, since a folded match has no single line.
function screenText(text, terms) {
  const s = String(text);
  const hits = [];
  const found = new Set();
  const low = terms.map((t) => t.toLowerCase());
  s.split(/\r?\n/).forEach((l, i) => {
    const ll = l.toLowerCase();
    low.forEach((t, k) => {
      if (ll.includes(t)) {
        hits.push({ line: i + 1, term: terms[k] });
        found.add(k);
      }
    });
  });
  let folded = null;
  terms.forEach((t, k) => {
    const f = fold(t);
    if (found.has(k) || f.length < MIN_FOLDED) return;
    if (folded === null) folded = fold(s);
    if (folded.includes(f)) hits.push({ line: 0, term: t, folded: true });
  });
  return hits;
}

// The bundle's `write_file '<dst>' '<base64>'` lines (make-bundle.js), decoded. `lines` counts
// every CALL line — `write_file` followed by a space, which leaves out the `write_file() {`
// definition the bundle also carries — and a count above `files.length` means the format moved
// and something was NOT decoded: the caller refuses instead of reading it as clean.
const CALL_RE = /^write_file\s+(?!\()/;
function decodeBundle(text) {
  const files = [];
  for (const m of String(text).matchAll(/^write_file '([^']+)' '([A-Za-z0-9+/=]*)'\r?$/gm)) {
    files.push({ dst: m[1], text: decodeText(Buffer.from(m[2], "base64")) });
  }
  const lines = String(text).split(/\r?\n/).filter((l) => CALL_RE.test(l)).length;
  return { files, lines };
}
// The bundle's own text with its base64 payload lines blanked (kept as empty lines, so line
// numbers hold): the payload is screened decoded, and raw base64 is noise to the folded pass.
const bundleShell = (text) =>
  String(text)
    .split("\n")
    .map((l) => (CALL_RE.test(l) ? "" : l))
    .join("\n");

const isBundle = (rel) => /(^|\/)install-pipeline\.sh$/.test(rel);

function screenBundle(where, text, terms, hits, unread) {
  const b = decodeBundle(text);
  if (b.lines !== b.files.length) unread.push(where + " — " + b.lines + " write_file line(s), " + b.files.length + " decoded: the bundle format changed");
  for (const f of b.files) {
    for (const h of screenText(f.dst + "\n" + f.text, terms)) hits.push({ where: where + " -> " + f.dst + " (decoded)", line: h.line && h.line - 1, term: h.term });
  }
}

// Screens repo-relative files of a checkout — content (the bundle decoded too) and the path
// itself — and extra named texts (commit message, author). A file that exists but cannot be read
// lands in `unread`: a screen that quietly read nothing would report clean. A path that no
// longer exists (a retired file the export removed) carries no text into the commit.
function screenExport(repo, rels, terms, extra) {
  const hits = [];
  const unread = [];
  for (const h of screenText(rels.join("\n"), terms)) hits.push({ where: "file names", line: h.line, term: h.term });
  for (const rel of rels) {
    const abs = path.join(repo, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      let present = false;
      try {
        fs.lstatSync(abs); // a broken symlink is present: git commits the link
        present = true;
      } catch {
        present = false;
      }
      if (present) unread.push(rel + " — could not be read");
      continue;
    }
    const text = decodeText(buf);
    for (const h of screenText(isBundle(rel) ? bundleShell(text) : text, terms)) hits.push({ where: rel, line: h.line, term: h.term });
    if (isBundle(rel)) screenBundle(rel, text, terms, hits, unread);
  }
  for (const [name, text] of Object.entries(extra || {})) {
    for (const h of screenText(text, terms)) hits.push({ where: name, line: h.line, term: h.term });
  }
  return { hits, unread };
}

const git = (repo, args) => execFileSync("git", args, Object.assign({ cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }, BIG));

// Everything a `git add -A -- <owned>` could stage: tracked and untracked-not-ignored files,
// NUL-separated so a non-ASCII path comes back as itself, not C-quoted.
function listFiles(repo, owned) {
  return git(repo, ["ls-files", "-z", "-co", "--exclude-standard", "--"].concat(owned)).split("\0").filter(Boolean);
}

function usableTerms(t) {
  if (t.error) return "the term list " + t.file + " cannot be used: " + t.error;
  if (t.missing) return "there is no term list " + t.file;
  if (!t.terms.length) return "the term list " + t.file + " holds no usable term" + (t.short.length ? " (" + t.short.length + " under " + MIN_TERM + " characters ignored)" : "");
  return "";
}

// The pre-staging gate. { ok, lines }: `ok` false means refuse — nothing may be staged. Without a
// usable term list a dry export (no commit message) only warns; a commit is refused, because a
// commit is what the push publishes.
function gate({ repo, pipeDir, owned, commitMsg }) {
  const lines = [];
  const t = loadTerms(pipeDir);
  const why = usableTerms(t);
  if (why) {
    if (commitMsg) return { ok: false, lines: ["REFUSED: " + why + " — an unscreened export is not committed (rules §11, Gate (public export)). One term per line, UTF-8; the file is never exported."] };
    return { ok: true, lines: ["WARNING: " + why + " — this export is NOT screened for project identifiers (rules §11); a --commit would be refused."] };
  }
  if (t.short.length) lines.push("note: " + t.short.length + " term(s) under " + MIN_TERM + " characters ignored in " + t.file);
  let files;
  try {
    files = listFiles(repo, owned.filter((rel) => fs.existsSync(path.join(repo, rel))));
  } catch (e) {
    return { ok: false, lines: lines.concat(["REFUSED: could not list the checkout's files, nothing was screened: " + String((e && (e.stderr || e.message)) || e).trim().split("\n")[0]]) };
  }
  const extra = {};
  if (commitMsg) {
    extra["commit message"] = commitMsg;
    extra["commit author"] = [safe(() => git(repo, ["config", "user.name"])), safe(() => git(repo, ["config", "user.email"]))].join("\n");
  }
  const r = screenExport(repo, files, t.terms, extra);
  if (r.hits.length || r.unread.length) return { ok: false, lines: lines.concat(refusal("the export", r)) };
  lines.push("screened: " + files.length + " file(s) by content and name + the decoded bundle" + (commitMsg ? " + the commit message and author" : "") + " against " + t.terms.length + " term(s) — clean");
  return { ok: true, lines, terms: t.terms };
}

const safe = (f) => {
  try {
    return f().trim();
  } catch {
    return "";
  }
};

function refusal(what, r) {
  const out = ["REFUSED: " + what + " failed the public-export screen (rules §11):"];
  for (const h of r.hits.slice(0, 50)) out.push("  " + h.where + ":" + h.line + " — " + h.term);
  if (r.hits.length > 50) out.push("  … +" + (r.hits.length - 50) + " more");
  for (const u of r.unread) out.push("  " + u + " — not screened");
  return out;
}

// What a commit ADDS, from `git show --format=<header> --patch`: the header lines (author,
// committer, message — everything before the first `diff --git`) and the patch's `+` lines,
// minus the `+++` file headers and the bundle's base64 payload (screened decoded instead).
// Removed lines are not screened: a commit that takes an already-published term OUT must not
// be refused for it.
function addedText(show) {
  const lines = String(show).split("\n");
  const firstDiff = lines.findIndex((l) => l.startsWith("diff --git "));
  const head = firstDiff === -1 ? lines : lines.slice(0, firstDiff);
  const added = (firstDiff === -1 ? [] : lines.slice(firstDiff)).filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).filter((l) => !CALL_RE.test(l));
  return head.concat(added).join("\n");
}

// Every commit the upstream lacks — what a push would send.
function unpushed(repo) {
  git(repo, ["rev-parse", "--verify", "--quiet", "@{u}"]);
  return git(repo, ["rev-list", "--reverse", "@{u}..HEAD"]).split("\n").filter(Boolean);
}

// The pre-push gate: a push sends EVERY commit the upstream lacks, not only the one this run
// made — a hand commit in the checkout, or one made before this screen existed. Each is read: its
// author, committer and message, the lines its patch adds, and the bundle as that commit holds
// it, decoded. No upstream means no way to know what a push would send: refuse.
function pushGate({ repo, terms }) {
  let range;
  try {
    range = unpushed(repo);
  } catch (e) {
    return { ok: false, lines: ["REFUSED: cannot tell what the push would send (no upstream for this branch) — not pushed (rules §11)"] };
  }
  const hits = [];
  const unread = [];
  for (const c of range) {
    const where = "commit " + c.slice(0, 8);
    let text;
    try {
      text = git(repo, ["show", "--format=%an%n%ae%n%cn%n%ce%n%B", "--patch", "--no-color", c]);
    } catch {
      unread.push(where + " — git show failed");
      continue;
    }
    for (const h of screenText(addedText(text), terms)) hits.push({ where, line: h.line, term: h.term });
    const bundle = safe(() => git(repo, ["show", c + ":pipeline/install-pipeline.sh"]));
    if (bundle) screenBundle(where + " pipeline/install-pipeline.sh", bundle, terms, hits, unread);
  }
  if (hits.length || unread.length) return { ok: false, lines: refusal("the push (" + range.length + " unpushed commit(s))", { hits, unread }).concat(["Not pushed: the commits stay local; fix them (amend/rebase, unpushed only) and run the export with --push again — it pushes pending commits even when nothing new changed."]) };
  return { ok: true, lines: ["screened: " + range.length + " unpushed commit(s) — clean"] };
}

module.exports = { TERMS_FILE, MIN_TERM, decodeText, loadTerms, screenText, decodeBundle, screenExport, listFiles, gate, pushGate, unpushed };
