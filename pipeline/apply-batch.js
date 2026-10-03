#!/usr/bin/env node
// Lands a batch of text replacements across files ALL OR NOTHING (§6: the confirmed fixes go in as
// one batch, then one build).
//
//   node apply-batch.js <spec-file> [--root <dir>] [--check]
//
// Why it exists: the hand-rolled patch script — `for old, new in pairs: assert s.count(old) == 1`
// — dies at its first stale `old` with the earlier files already written. Measured on 03.10: one
// review round re-applied its remainder three times, and each time a clippy run beside it compiled
// the half-written tree. This tool checks EVERY hunk against the files first, reports every miss in
// one go, and writes nothing unless all of them match exactly once.
//
// The spec is plain text, written with the Write tool (no shell quoting, backslashes kept):
//
//   @@@ FILE crates/a/src/x.rs
//   @@@ OLD
//   let a = 1;
//   @@@ NEW
//   let a = 2;
//   @@@ END
//
// Any number of FILE sections, any number of OLD/NEW/END hunks under each, applied in order (a
// later hunk sees the earlier ones' result). The text between the markers is taken verbatim, line
// endings excepted: a CRLF file gets its hunks in CRLF. An empty OLD under a FILE that does not
// exist creates it with NEW. Lines outside a hunk are ignored, so a spec can carry notes.
// A created file ends with a newline. A file that is not valid UTF-8 is refused, never rewritten:
// decoding it would replace its bytes with U+FFFD.
// Exit 0: applied (or, with --check, would apply). Exit 1: nothing written, every miss listed.
// Exit 2: the spec or the command line is malformed. Exit 3: a write failed part-way (a file
// locked by an editor or a running exe); every file already replaced was put back.

const fs = require("fs");
const path = require("path");

const MARK = /^@@@ (FILE|OLD|NEW|END)(?: (.*))?$/;

function parseSpec(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const files = [];
  const errors = [];
  let file = null;
  let mode = ""; // "", "old", "new"
  let old = [];
  let neu = [];
  let hunkAt = 0;
  lines.forEach((line, i) => {
    const m = line.match(MARK);
    if (!m) {
      if (mode === "old") old.push(line);
      else if (mode === "new") neu.push(line);
      return;
    }
    const at = i + 1;
    if (m[1] === "FILE") {
      if (mode) errors.push("line " + at + ": FILE inside an unfinished hunk (from line " + hunkAt + ")");
      const p = (m[2] || "").trim();
      if (!p) errors.push("line " + at + ": FILE without a path");
      file = { path: p, hunks: [] };
      files.push(file);
      mode = "";
    } else if (m[1] === "OLD") {
      if (!file) errors.push("line " + at + ": OLD before any FILE");
      if (mode) errors.push("line " + at + ": OLD inside an unfinished hunk (from line " + hunkAt + ")");
      mode = "old";
      old = [];
      neu = [];
      hunkAt = at;
    } else if (m[1] === "NEW") {
      if (mode !== "old") errors.push("line " + at + ": NEW without an OLD before it");
      mode = "new";
    } else {
      if (mode !== "new") errors.push("line " + at + ": END without a NEW before it");
      else if (file) file.hunks.push({ old: old.join("\n"), new: neu.join("\n"), line: hunkAt });
      mode = "";
    }
  });
  if (mode) errors.push("end of spec: the hunk from line " + hunkAt + " has no END");
  for (const f of files) if (!f.hunks.length) errors.push("FILE " + f.path + ": no hunks");
  return { files, errors };
}

const countOf = (hay, needle) => {
  let n = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) n += 1;
  return n;
};

// Where the first non-empty line of a missed `old` does occur: usually the hunk is stale by a
// line or two, and the line numbers send the next read straight there.
function nearLines(content, old) {
  const first = old.split("\n").map((l) => l.trim()).find(Boolean);
  if (!first) return [];
  const out = [];
  content.split("\n").forEach((l, i) => {
    if (out.length < 5 && l.includes(first)) out.push(i + 1);
  });
  return out;
}

// Pure: resolves every hunk against the current files and returns what would be written. No file
// is touched here, so a single miss anywhere leaves the whole tree as it was.
function planBatch(spec, root) {
  const misses = [];
  const writes = [];
  const seen = new Map(); // a file named in two FILE sections continues from the first's result
  for (const f of spec.files) {
    let abs = path.resolve(root, f.path);
    // Through a symlink to the real file: a rename over the link would replace it with a copy.
    try {
      abs = fs.realpathSync(abs);
    } catch {
      // not there yet: a file to create
    }
    // Windows paths are case-insensitive: two spellings of one file must share one state, or the
    // second's write would silently drop the first's hunks.
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    let state = seen.get(key);
    if (!state) {
      let raw = null;
      try {
        raw = fs.readFileSync(abs);
      } catch {
        raw = null;
      }
      const text = raw === null ? null : raw.toString("utf8");
      const invalid = text !== null && !Buffer.from(text, "utf8").equals(raw);
      const bom = text !== null && text.charCodeAt(0) === 0xfeff;
      state = { abs, rel: f.path, original: raw, exists: raw !== null, invalid, content: text === null ? null : bom ? text.slice(1) : text, bom };
      state.crlf = state.content !== null && state.content.includes("\r\n");
      if (invalid) misses.push(f.path + ": not valid UTF-8, left alone — edit it with a tool that knows its encoding");
      seen.set(key, state);
      writes.push(state);
    }
    for (const h of f.hunks) {
      if (state.invalid) continue; // reported once above
      const eol = (s) => (state.crlf ? s.replace(/\n/g, "\r\n") : s);
      if (state.content === null) {
        if (h.old === "") state.content = h.new === "" || h.new.endsWith("\n") ? h.new : h.new + "\n";
        else misses.push(f.path + " (hunk at spec line " + h.line + "): file does not exist");
        continue;
      }
      if (h.old === "") {
        misses.push(f.path + " (hunk at spec line " + h.line + "): empty OLD creates a file, and this one exists");
        continue;
      }
      const old = eol(h.old);
      const n = countOf(state.content, old);
      if (n !== 1) {
        const near = n === 0 ? nearLines(state.content.replace(/\r\n/g, "\n"), h.old) : [];
        misses.push(
          f.path + " (hunk at spec line " + h.line + "): OLD found " + n + " times" +
            (near.length ? "; its first line occurs at line(s) " + near.join(", ") : "")
        );
        continue;
      }
      const at = state.content.indexOf(old);
      state.content = state.content.slice(0, at) + eol(h.new) + state.content.slice(at + old.length);
      state.changed = true;
    }
  }
  return { misses, writes: writes.filter((w) => w.changed || (!w.exists && w.content !== null)) };
}

// All or nothing on disk too. Every new content is staged beside its target first; only when all
// are staged do the renames run, and a rename that fails (a file locked by an editor or a running
// exe — routine on Windows) puts back every file already replaced and removes every stage. What
// could not be put back is named in the error, never left for the caller to guess.
function writePlan(writes) {
  const staged = [];
  // Best effort, and never allowed to throw: an error here would replace the one being reported
  // and lose its list of files that could not be put back.
  const dropStages = () => {
    for (const s of staged) {
      try {
        fs.rmSync(s.tmp, { force: true });
      } catch {
        // a stray .apply-batch.tmp is harmless next to a restored file
      }
    }
  };
  try {
    for (const w of writes) {
      fs.mkdirSync(path.dirname(w.abs), { recursive: true });
      const tmp = w.abs + ".apply-batch.tmp";
      staged.push({ w, tmp });
      fs.writeFileSync(tmp, Buffer.from((w.bom ? "﻿" : "") + w.content, "utf8"));
      // Keep the target's mode: an executable script must stay executable after the rename.
      if (w.exists) fs.chmodSync(tmp, fs.statSync(w.abs).mode & 0o7777);
    }
  } catch (e) {
    dropStages();
    e.unrestored = [];
    throw e;
  }
  const done = [];
  try {
    for (const s of staged) {
      fs.renameSync(s.tmp, s.w.abs);
      done.push(s.w);
    }
  } catch (e) {
    e.unrestored = [];
    for (const w of done) {
      try {
        if (w.original === null) fs.rmSync(w.abs, { force: true });
        else fs.writeFileSync(w.abs, w.original);
      } catch {
        e.unrestored.push(w.rel);
      }
    }
    dropStages();
    throw e;
  }
}

function main(argv) {
  const args = argv.slice(2);
  const rootAt = args.indexOf("--root");
  const root = rootAt !== -1 ? args[rootAt + 1] : process.cwd();
  const check = args.includes("--check");
  const specPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--root");
  if (!specPath || !root || root.startsWith("--")) {
    console.error("usage: node apply-batch.js <spec-file> [--root <dir>] [--check]");
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(specPath, "utf8");
  } catch (e) {
    console.error("apply-batch: cannot read the spec: " + e.message);
    return 2;
  }
  const spec = parseSpec(text);
  if (spec.errors.length) {
    console.error("apply-batch: malformed spec, nothing written:\n  " + spec.errors.join("\n  "));
    return 2;
  }
  const plan = planBatch(spec, root);
  const hunks = spec.files.reduce((n, f) => n + f.hunks.length, 0);
  if (plan.misses.length) {
    console.error("apply-batch: " + plan.misses.length + " problem(s) across " + hunks + " hunk(s), NOTHING written:\n  " + plan.misses.join("\n  "));
    return 1;
  }
  if (check) {
    console.log("apply-batch: all " + hunks + " hunk(s) match exactly once in " + plan.writes.length + " file(s); --check, nothing written");
    return 0;
  }
  try {
    writePlan(plan.writes);
  } catch (e) {
    const lost = e.unrestored || [];
    console.error(
      "apply-batch: a write failed (" + e.message + "); " +
        (lost.length ? "COULD NOT RESTORE, check by hand: " + lost.join(", ") : "every file put back, nothing written")
    );
    return 3;
  }
  console.log("apply-batch: applied " + hunks + " hunk(s) to " + plan.writes.length + " file(s): " + plan.writes.map((w) => w.rel).join(", "));
  return 0;
}

if (require.main === module) process.exit(main(process.argv));

module.exports = { parseSpec, planBatch, main };
