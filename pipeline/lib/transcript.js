// Locating and reading the session transcript, and slicing the most recent task out of it.
// Everything here is about the JOURNAL's shape — which record opens a task, which one is a hook
// attachment, how much of a 150 MB file a hook may read — and nothing about what the task did.

const fs = require("fs");
const path = require("path");

const TAIL_BYTES = 12 * 1024 * 1024; // enough for one task; transcripts here reach 150 MB

// --- locate the transcript ----------------------------------------------------------------
function slugFor(cwd) {
  return cwd.toLowerCase().replace(/[:\\/_.]/g, "-");
}

function newestTranscriptIn(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const p = path.join(dir, f);
      return { p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].p : null;
}

// `root` is the pipeline root (the home, or a --prefix sandbox): transcripts live under its
// .claude/projects/<slug of cwd>/.
function findTranscript(hook, root) {
  if (hook.transcript_path && fs.existsSync(hook.transcript_path)) return hook.transcript_path;
  const projects = path.join(root, ".claude", "projects");
  const cwd = hook.cwd || process.cwd();
  const projDir = path.join(projects, slugFor(cwd));
  // `--session <id>` pins the transcript. Without it a by-hand run takes the NEWEST journal for
  // this directory, which — with several sessions live at once — is regularly someone else's: seen
  // for real, a digest built from a neighbour's task and reported as this one's.
  const sAt = process.argv.indexOf("--session");
  const wanted = sAt !== -1 ? process.argv[sAt + 1] || "" : "";
  if (sAt !== -1 && !wanted) {
    process.stderr.write("gate-check: --session given with no id; using the newest transcript\n");
  }
  if (wanted) {
    const direct = path.join(projDir, wanted + ".jsonl");
    if (fs.existsSync(direct)) return direct;
    // The report prints an 8-character id, and §10 tells the reader to pin THAT, so a prefix has to
    // work as well as a full uuid. Own project folder first, then the rest.
    const dirs = [projDir].concat(
      fs.existsSync(projects) ? fs.readdirSync(projects).map((dd) => path.join(projects, dd)) : []
    );
    for (const dd of dirs) {
      if (!fs.existsSync(dd)) continue;
      const hit = fs.readdirSync(dd).find((f) => f.endsWith(".jsonl") && f.startsWith(wanted));
      if (hit) return path.join(dd, hit);
    }
    process.stderr.write("gate-check: no transcript for session " + wanted + "\n");
    return null;
  }
  if (hook.session_id) {
    const guess = path.join(projDir, hook.session_id + ".jsonl");
    if (fs.existsSync(guess)) return guess;
    if (fs.existsSync(projects)) {
      for (const d of fs.readdirSync(projects)) {
        const p = path.join(projects, d, hook.session_id + ".jsonl");
        if (fs.existsSync(p)) return p;
      }
    }
  }
  // Run by hand: take the newest transcript for this working directory. If the cwd is not a
  // project root (running from the script's own folder, say), fall back to the newest transcript
  // anywhere - the by-hand mode prints which file it took, so a wrong pick is visible.
  const local = newestTranscriptIn(projDir);
  if (local) return local;
  if (!fs.existsSync(projects)) return null;
  let best = null;
  for (const d of fs.readdirSync(projects)) {
    const p = newestTranscriptIn(path.join(projects, d));
    if (!p) continue;
    const m = fs.statSync(p).mtimeMs;
    if (!best || m > best.m) best = { p, m };
  }
  return best ? best.p : null;
}

function sessionIdOf(hook, file) {
  if (hook.session_id) return hook.session_id;
  return file ? path.basename(file, ".jsonl") : "";
}

// Read only the tail: a 150 MB transcript must not be parsed inside a hook timeout.
function readTail(file) {
  const size = fs.statSync(file).size;
  if (size <= TAIL_BYTES) return { text: fs.readFileSync(file, "utf8"), truncated: false };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(TAIL_BYTES);
    // Use the ACTUAL byte count: a short read would otherwise decode NUL padding as content.
    const read = fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
    const text = buf.toString("utf8", 0, read);
    const nl = text.indexOf("\n");
    // No newline at all means one record larger than the whole window: nothing here is parseable,
    // and pretending otherwise would report "no writes, no angles" as if the task had been idle.
    if (nl === -1) return { text: "", truncated: true, unusable: true };
    return { text: text.slice(nl + 1), truncated: true };
  } finally {
    fs.closeSync(fd);
  }
}

// --- slice out the most recent task ------------------------------------------------------
// A real user turn starts a task. Tool results arrive as type=user too, and so do slash-command
// expansions and interrupt notices - starting the window at one of those cuts the task in half
// and every downstream check then fires on a compliant run.
function userTurnText(rec) {
  if (rec.type !== "user" || !rec.message) return null;
  if (rec.isMeta || rec.isCompactSummary || rec.isSidechain) return null;
  const c = rec.message.content;
  let text = null;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b && b.type === "tool_result")) return null;
    const parts = c.filter((b) => b && b.type === "text").map((b) => b.text || "");
    text = parts.length ? parts.join("\n") : null;
  }
  if (text === null || !text.trim()) return null;
  return text;
}

function isTaskOpening(rec) {
  const text = userTurnText(rec);
  if (text === null) return false;
  const t = text.trim();
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) return false;
  if (t.startsWith("/")) return false; // a slash command the user typed, not a new task
  if (t.startsWith("[Request interrupted")) return false;
  if (t.startsWith("<local-command") || t.startsWith("<system-reminder")) return false;
  // A background agent finishing arrives as a user turn; it continues the task that launched it.
  // Taken as an opening it split every task with backgrounded reviewers — the default shape now —
  // into fragments with no class line and no angles, and the ledger scored each one.
  if (t.startsWith("<task-notification")) return false;
  return true;
}

// The hook_additional_context attachments of the SessionStart batch that precedes a task window.
// A task's window begins at its prompt, and the session-start output sits BEFORE that prompt —
// so without this the leak gate's trigger line ("LEAK REVIEW PENDING") could never reach check().
function sessionPreamble(recs, start) {
  const out = [];
  for (let i = start - 1; i >= 0 && i >= start - 400; i--) {
    const r = recs[i];
    if (r && r.type === "attachment" && r.attachment && r.attachment.type === "hook_additional_context" && /SessionStart/i.test(r.attachment.hookEvent || r.attachment.hookName || "")) {
      out.unshift(r);
    } else if (r && isTaskOpening(r)) {
      break; // an earlier task's prompt: whatever precedes it belongs to that task
    }
  }
  return out;
}

function parseTranscript(file) {
  const tail = readTail(file);
  const recs = [];
  for (const line of tail.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      // a partially written line, or a record split by the tail cut: skip it
    }
  }
  let start = 0;
  let found = false;
  for (let i = recs.length - 1; i >= 0; i--) {
    if (isTaskOpening(recs[i])) {
      start = i;
      found = true;
      break;
    }
  }
  // No opening in the window means the task began before the 12 MB tail: what follows is a
  // fragment, possibly merged with the previous task, and its gates cannot be judged.
  return {
    records: recs.slice(start),
    preamble: sessionPreamble(recs, start), // session-start hook output, outside every window
    all: recs, // the whole tail: a late agent answer is paired against the task BEFORE this one
    start,
    total: recs.length,
    truncated: tail.truncated,
    windowComplete: found && !tail.unusable,
  };
}

// A tool_use block that launches a subagent — the one predicate the digest, the ledger and the
// late-answer pairing all need.
const isAgentCall = (b) => Boolean(b && b.type === "tool_use" && (b.name === "Agent" || b.name === "Task"));

// Where a background agent's answer lands depends on WHEN it arrives: between turns it is a user
// turn (string or text blocks); mid-turn it is queued, and the transcript then holds it as a
// `queue-operation` record (`content`) and an `attachment` record (`attachment.prompt`). The
// text of any of those, or "" for a record of another kind.
function notificationText(rec) {
  if (!rec) return "";
  const c = rec.message && rec.message.content;
  if (rec.type === "user") return typeof c === "string" ? c : textOf(Array.isArray(c) ? c : []);
  if (rec.type === "queue-operation") return String(rec.content || "");
  if (rec.type === "attachment") {
    const pr = rec.attachment && rec.attachment.prompt;
    return typeof pr === "string" ? pr : textOf(Array.isArray(pr) ? pr : []);
  }
  return "";
}
const NOTIFY_ID_RE = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/;

// Plain text of an assistant/user content block list.
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("\n");
}

module.exports = { findTranscript, sessionIdOf, userTurnText, isTaskOpening, sessionPreamble, parseTranscript, textOf, isAgentCall, notificationText, NOTIFY_ID_RE };
