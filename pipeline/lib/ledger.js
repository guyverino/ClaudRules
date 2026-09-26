#!/usr/bin/env node
// Per-task accounting for the review pipeline: what each angle cost and what it actually caught.
//
// Everything here is derived from the session transcript, never from the orchestrator's own
// report — the orchestrator is the party being measured, so its account cannot be the evidence.
// The transcript already carries, per agent invocation: subagent_tokens, duration_ms, tool_uses,
// and the agent's full answer, i.e. the findings themselves.
//
// One JSON line per task is APPENDED to ledger.jsonl — never a read-modify-write, because two
// sessions ending a turn at the same moment would otherwise overwrite each other's row. Rows for
// the same task can therefore appear twice; stats.js keeps the fullest one per task key. A
// by-hand digest (gate-check.js `digest --hand`) writes no row at all — that was one of the
// three rows a task used to leave.

const fs = require("fs");
const path = require("path");
const { pipelineDir } = require("./root");
const { SCRATCH_RE, REVIEW_AGENTS, SUPPORT_AGENTS } = require("./stacks");
const { textOf, isAgentCall, notificationText, NOTIFY_ID_RE } = require("./transcript");

const DIR = pipelineDir("ledger");
const LEDGER = path.join(DIR, "ledger.jsonl");

// `path/to/file.rs:123 — one-line claim — high`, usually wrapped in backticks. The claim itself
// contains dashes, so severity is anchored at the END and the claim takes what is left.
// A line RANGE (`msg_ring.rs:244-245`) is accepted and keyed on its first line: the contract says
// one line, but three live batches cited ranges and lost their findings to a strict parser. A
// `(…)` aside after the range is tolerated the same way; the claim itself begins after the dash.
// The tail tolerates two contract slips seen live, because losing the finding is worse than
// reading past them: `— severity: medium` instead of the bare word, and a parenthesis AFTER the
// severity (a seams run closed with `— severity: medium (wrong placement, not a crash …)` and
// was recorded as a malformed answer with nothing in it). The claim stays lazy, so the severity
// found is the LAST dash-separated word of the line, never one inside the claim.
const FINDING_RE =
  /^\s*[`'"]?\s*(.+?):(\d+)(?:[-–]\d+)?[`'"]?\s*(?:\([^)]*\))?\s*[—-]\s*(.+?)\s*[—-]\s*(?:severity\s*:\s*)?(high|medium|low)\.?\s*(?:\(.*\))?\.?\s*[`'"]?\s*$/i;
// leak-review's contract is a verdict line, not a finding list: `VERDICT: CLEAN — …` is a complete
// answer with zero findings, and used to be recorded as a broken one on every clean review.
const VERDICT_RE = /^\s*VERDICT\s*:\s*(CLEAN|SUSPECT|UNSURE)\b/im;
// Two spellings: `subagent_tokens: N` in a synchronous tool_result, `<subagent_tokens>N</…>` in a
// task notification. Read from a live transcript — the colon form alone left tokens at 0.
const USAGE_RE = /subagent_tokens[>:]\s*(\d+)[\s\S]*?tool_uses[>:]\s*(\d+)[\s\S]*?duration_ms[>:]\s*(\d+)/;

// A review angle is measured as an angle; the support agents are measured separately, or a
// per-finding helper like verify-finding would flood the scorecard and trigger measures against
// something that was never a §6 angle.
const roleOf = (type) => (REVIEW_AGENTS.has(type) ? "angle" : SUPPORT_AGENTS.has(type) ? "support" : "generic");

const normPath = (p) => String(p || "").toLowerCase().replace(/\\/g, "/").trim();

// Two angles citing the same file:line found the same thing. This cannot see two DIFFERENT
// defects reported at one line, nor one defect reported at two lines — stats.js says so.
function findingKey(file, line) {
  return normPath(file).replace(/\s+/g, "") + ":" + line;
}

// Cheap stable hash, so the task key does not depend on a truncated prompt prefix: two different
// tasks in one session can easily share their first 160 characters.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function parseAgentResult(text) {
  const usage = text.match(USAGE_RE);
  const findings = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(FINDING_RE);
    if (!m) continue;
    const [, file, line, claim, severity] = m;
    // A path needs a separator or an extension; "note: 12 — something — low" is not a finding.
    if (!/[\\/.]/.test(file)) continue;
    findings.push({
      file: file.trim(),
      line: Number(line),
      claim: claim.trim().slice(0, 200),
      severity: severity.toLowerCase(),
    });
  }
  return {
    tokens: usage ? Number(usage[1]) : 0,
    toolUses: usage ? Number(usage[2]) : 0,
    durationMs: usage ? Number(usage[3]) : 0,
    findings,
    zero: /^\s*0 findings\s*\.?\s*$/im.test(text),
    verdict: (text.match(VERDICT_RE) || [])[1] ? text.match(VERDICT_RE)[1].toUpperCase() : "",
  };
}

// Did the orchestrator touch THIS file after the finding was reported? Matching by bare filename
// would be wrong: a tree routinely holds several `mod.rs`, `tests.rs`, `commands.rs`, and an edit
// to one would credit a finding in another. Compare full paths, or a suffix of at least two
// segments so a repo-relative path still matches the same file written absolutely.
// Returns true (this file was touched later), false (it was not), or null — the evidence is
// ambiguous, which happens when one side is a bare filename (a shell write recorded as `tests.rs`)
// and the tree holds several files by that name. Guessing either way would bias acted%; null keeps
// the finding out of the judged population instead.
function editedAfter(writes, step, file) {
  const target = normPath(file);
  if (!target) return false;
  // One path may be absolute and the other repo-relative, so the shorter must be a whole-segment
  // suffix of the longer. A fixed two-segment tail is not enough: `src/tests.rs` is identical in
  // every crate, and `crates/a/src/tests.rs` would then credit a finding in `crates/b/...`.
  const isSuffix = (long, short) =>
    long === short || (short.includes("/") && long.endsWith("/" + short));
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  let ambiguous = false;
  for (const w of writes || []) {
    if (!w || w.step <= step) continue;
    const f = normPath(w.file);
    if (!f) continue;
    if (isSuffix(f, target) || isSuffix(target, f)) return true;
    // Ambiguity requires that one side has NO directory at all: a bare `tests.rs` could be this
    // file or its namesake elsewhere. When both paths carry directories and still do not match,
    // that is a definite "different file", not a doubt.
    if (base(f) === base(target) && (!f.includes("/") || !target.includes("/"))) ambiguous = true;
  }
  return ambiguous ? null : false;
}

function sumOrchestratorUsage(records) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const rec of records) {
    const u = rec && rec.message && rec.message.usage;
    if (!u) continue;
    t.input += u.input_tokens || 0;
    t.output += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheCreate += u.cache_creation_input_tokens || 0;
  }
  return t;
}

// Build one ledger row. `digest` is what gate-check already extracted (agents, writes, gates);
// `records` is the raw task window, needed for the agents' results and the usage totals.
// A BACKGROUND agent answers twice: its tool_result is only the launch stub, and the real answer
// arrives later as a `<task-notification>` user turn carrying the tool-use id, the result and the
// usage. Pairing on tool_result alone recorded every backgrounded reviewer — the default shape
// now — as a run with 0 findings and 0 tokens: on one feature task 8 of 11 agents, and a
// scorecard that would have "narrowed" every angle on numbers that were never there.
const LAUNCH_STUB_RE = /Async agent launched/;
const NOTIFICATION_RE = /<task-notification>/;
const STATUS_RE = /<status>\s*([^<\s]+)\s*<\/status>/;
const AGENT_ID_RE = /agentId:\s*([A-Za-z0-9_-]+)/;
const unescapeHtml = (s) => s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

// The FOURTH shape, since 2026-09-18: the harness hands a subagent's report over as its own
// `<agent-message from="<agentId>">` turn — "[Subagent hand-back] … The report follows:" and then
// the report with every line indented by two spaces — and the tool_result, the notification and
// a TaskOutput fetch all carry only a POINTER to it ("report was delivered to you as a message
// from …") plus the usage. Read as before, the pointer parsed as prose: three days of every angle
// at 0 findings and 100% malformed, and a scorecard proposing to "fix the agent file" of agents
// that were answering fine.
const HANDBACK_RE = /<agent-message\s+from="([A-Za-z0-9_-]+)"\s*>[\s\S]*?\[Subagent hand-back\][\s\S]*?The report follows:[^\n]*\n([\s\S]*?)(?:<\/agent-message>|$)/;
const POINTER_RE = /report was delivered to you as a message from/;

function usageOf(text) {
  const usage = text.match(USAGE_RE);
  return usage ? { tokens: Number(usage[1]), toolUses: Number(usage[2]), durationMs: Number(usage[3]) } : null;
}

// The hand-back's report, de-indented, keyed by the agentId it came from. The frame line and the
// notes above it are the harness's words, never the agent's, and stay outside the parsed text.
function parseHandback(text) {
  const m = text.match(HANDBACK_RE);
  if (!m) return null;
  const body = m[2].split("\n").map((l) => l.replace(/^ {2}/, "")).join("\n");
  return { agentId: m[1], parsed: parseAgentResult(body) };
}

function parseNotification(text) {
  const id = text.match(NOTIFY_ID_RE);
  if (!id) return null;
  // A failed run is the background twin of a synchronous is_error result, and it gets the same
  // treatment: it never ran. Counting it as a run with no findings would inflate the angle's
  // "broke the contract" rate — which is exactly what stats.js decides on.
  const status = text.match(STATUS_RE);
  // Anything but completed — failed, killed, cancelled — is the same non-run.
  if (status && status[1].toLowerCase() !== "completed") return { id: id[1], parsed: null };
  const body = text.match(/<result>([\s\S]*?)<\/result>/);
  // A pointer is not the answer: the hand-back is, and only the usage is taken from here.
  if (body && POINTER_RE.test(body[1])) return { id: id[1], pointer: true, usage: usageOf(text) };
  // Usage sits outside <result>; parse it from the whole notification.
  const parsed = parseAgentResult(unescapeHtml(body ? body[1] : ""));
  Object.assign(parsed, usageOf(text) || {});
  return { id: id[1], parsed };
}

// Every agent answer in the window, paired with its call: {type, findings, zero, verdict, tokens…}.
// Shared by buildRow and by the checker, which needs the raw finding count of the §6 batch BEFORE
// the row exists (the row wants the check result, the check wants the count — so the count is
// taken from this list, not from the row).
function collectResults(records) {
  const calls = new Map(); // tool_use id -> type, in call order
  const byId = new Map(); // tool_use id -> parsed result; the LAST report per id wins
  const agentByTask = new Map(); // agentId (from the launch stub) -> Agent tool_use id
  const fetches = new Map(); // TaskOutput tool_use id -> Agent tool_use id it fetches
  // Hand-back shape: the report by agentId and the usage by call id, joined once the window is
  // read — the hand-back lands BEFORE the stub that names its agentId on a synchronous call, and
  // before the notification on a background one, so neither order can be assumed in the loop.
  const handbacks = new Map(); // agentId -> parsed report; a resumed agent hands back again, last wins
  const usageByCall = new Map(); // Agent tool_use id -> usage read from a pointer
  for (const rec of records || []) {
    const c = rec && rec.message && rec.message.content;
    // Where a notification lands depends on WHEN it arrives (transcript.notificationText): on
    // the feature task above, 6 of the 8 background answers were queued mid-turn. The same text
    // appears more than once (enqueue + remove, or a repeated notification) — hence last-wins.
    const userText = notificationText(rec);
    if (userText && NOTIFICATION_RE.test(userText)) {
      const n = parseNotification(userText);
      if (n && calls.has(n.id)) {
        if (n.pointer) {
          if (n.usage) usageByCall.set(n.id, n.usage);
        } else if (n.parsed) byId.set(n.id, n.parsed);
        else byId.delete(n.id); // failed: no run to record
      }
    }
    if (userText && HANDBACK_RE.test(userText)) {
      const h = parseHandback(userText);
      if (h) handbacks.set(h.agentId, h.parsed);
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (isAgentCall(b)) {
        calls.set(b.id, b.input && b.input.subagent_type ? b.input.subagent_type : "general-purpose");
      }
      // The third way an answer arrives: the orchestrator BLOCKS on `TaskOutput {task_id}` and
      // the answer is that call's tool_result — no notification follows. Seen live: three angles
      // fired, two fetched this way, one recorded. task_id is the agentId the launch stub names.
      if (b && b.type === "tool_use" && b.name === "TaskOutput" && b.input && agentByTask.has(String(b.input.task_id))) {
        fetches.set(b.id, agentByTask.get(String(b.input.task_id)));
      }
      if (b && b.type === "tool_result" && fetches.has(b.tool_use_id)) {
        const callId = fetches.get(b.tool_use_id);
        const text = textOf(b.content);
        const status = text.match(STATUS_RE);
        // Only a completed fetch is an answer: an errored fetch, a running agent, or a result with
        // no status tag at all would otherwise record the angle as a malformed run.
        if (b.is_error || !status || status[1].toLowerCase() !== "completed") continue;
        const body = text.match(/<output>([\s\S]*?)<\/output>/);
        const out = body ? body[1] : text;
        // A fetch that only points at the hand-back adds nothing the hand-back does not hold —
        // except the usage, which a blocking fetch is the only carrier of (no notification
        // follows it). No such fetch has been seen since the hand-back shape arrived; the branch
        // is by analogy with the older TaskOutput shape.
        if (POINTER_RE.test(out)) {
          const usage = usageOf(text);
          if (usage) usageByCall.set(callId, usage);
          continue;
        }
        const parsed = parseAgentResult(unescapeHtml(out));
        // TaskOutput carries no usage; keep whatever a notification already recorded.
        const prev = byId.get(callId);
        if (prev && !parsed.tokens) Object.assign(parsed, { tokens: prev.tokens, toolUses: prev.toolUses, durationMs: prev.durationMs });
        byId.set(callId, parsed);
      }
      if (b && b.type === "tool_result" && calls.has(b.tool_use_id)) {
        // An invocation that errored out (a nonexistent agent type) never ran: counting it as a
        // silent run would make that angle look useless in the statistics.
        if (b.is_error) continue;
        const text = textOf(b.content);
        const agentId = text.match(AGENT_ID_RE);
        // The launch stub is not an answer: the notification or a TaskOutput fetch fills the slot
        // later. An agent whose answer is not in this window leaves no trace — the same as a
        // synchronous failure — and a later window that holds it writes the fuller row.
        if (LAUNCH_STUB_RE.test(text)) {
          if (agentId) agentByTask.set(agentId[1], b.tool_use_id);
          continue;
        }
        // A synchronous call under the hand-back shape: the result names the agentId and carries
        // the usage, the report is the hand-back keyed by that agentId.
        if (POINTER_RE.test(text)) {
          if (agentId) agentByTask.set(agentId[1], b.tool_use_id);
          const usage = usageOf(text);
          if (usage) usageByCall.set(b.tool_use_id, usage);
          continue;
        }
        byId.set(b.tool_use_id, parseAgentResult(text));
      }
    }
  }
  // Join the hand-backs to their calls. An older-shape answer already in byId wins over a
  // hand-back for the same call: it is the fuller record, and the two never coexist live.
  for (const [agentId, parsed] of handbacks) {
    const callId = agentByTask.get(agentId);
    if (!callId || byId.has(callId)) continue;
    byId.set(callId, { ...parsed, ...(usageByCall.get(callId) || {}) });
  }
  const results = [];
  for (const [id, type] of calls) {
    if (byId.has(id)) results.push({ type, ...byId.get(id) });
  }
  return results;
}

// The agentIds this window's own Agent calls were given (launch stubs and pointer results), so a
// hand-back can be told apart from one belonging to an earlier task — late.js needs that the
// way it needs the notification's tool-use id.
function ownAgentIds(records) {
  const calls = new Set();
  const ids = new Set();
  for (const rec of records || []) {
    const c = rec && rec.message && rec.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (isAgentCall(b)) calls.add(b.id);
      if (b && b.type === "tool_result" && calls.has(b.tool_use_id)) {
        const m = textOf(b.content).match(AGENT_ID_RE);
        if (m) ids.add(m[1]);
      }
    }
  }
  return ids;
}

// The agentId a record's hand-back came from, or "" when it is not one.
function handbackAgentId(rec) {
  const text = notificationText(rec);
  if (!text.includes("[Subagent hand-back]")) return "";
  const m = text.match(/<agent-message\s+from="([A-Za-z0-9_-]+)"/);
  return m ? m[1] : "";
}

// The §6 batch as the rule counts it: every finding the review ANGLES returned, before dedupe
// (R4 — past 5, verify-finding is not optional). Support agents are not the batch.
function angleFindingCount(records) {
  let n = 0;
  for (const r of collectResults(records)) if (roleOf(r.type) === "angle") n += r.findings.length;
  return n;
}

function buildRow(records, digest, meta, checkResult) {
  const results = collectResults(records);

  // Each agent type's FIRST invocation bounds "edited after" for its findings. A second call of
  // the same type in one task is rare; when it happens the bound is conservative, never later.
  const stepByType = new Map();
  for (const a of digest.agents || []) if (!stepByType.has(a.type)) stepByType.set(a.type, a.step);

  // How many DIFFERENT angles cited each file:line — a finding only one angle saw is unique.
  // Support agents are excluded: fix-diff repeating an angle's finding is not a second opinion.
  const seenBy = new Map();
  for (const r of results) {
    if (roleOf(r.type) !== "angle") continue;
    for (const f of r.findings) {
      const k = findingKey(f.file, f.line);
      if (!seenBy.has(k)) seenBy.set(k, new Set());
      seenBy.get(k).add(r.type);
    }
  }

  const writes = digest.writes || [];
  const agents = [];
  const findings = [];
  for (const r of results) {
    const role = roleOf(r.type);
    const step = stepByType.get(r.type) || 0;
    const bySeverity = { high: 0, medium: 0, low: 0 };
    let unique = 0;
    let accepted = 0;
    for (const f of r.findings) {
      const k = findingKey(f.file, f.line);
      const isUnique = role === "angle" ? (seenBy.get(k) || new Set()).size === 1 : false;
      const wasEdited = editedAfter(writes, step, f.file);
      if (bySeverity[f.severity] !== undefined) bySeverity[f.severity] += 1;
      if (isUnique) unique += 1;
      if (wasEdited === true) accepted += 1;
      findings.push({
        agent: r.type,
        role,
        file: f.file,
        line: f.line,
        severity: f.severity,
        claim: f.claim,
        unique: isUnique,
        editedAfter: wasEdited,
      });
    }
    agents.push({
      type: r.type,
      role,
      tokens: r.tokens,
      durationMs: r.durationMs,
      toolUses: r.toolUses,
      findings: r.findings.length,
      bySeverity,
      unique,
      editedAfter: accepted,
      saidZero: r.zero,
      // Neither findings nor the agreed "0 findings" line: the answer broke its own contract.
      // A verdict line completes only leak-review's contract — for an angle it is prose.
      malformed: r.findings.length === 0 && !r.zero && !(r.verdict && r.type === "leak-review"),
    });
  }

  // "The file was edited afterwards" only discriminates when the task touched several files. On a
  // task that rewrites ONE file over and over, every finding in it trivially scores as accepted —
  // mark it so the aggregator can drop this task from that average. Scratch files do not count as
  // project files here, for the same reason gate-check excludes them.
  const projectFiles = new Set(
    writes.map((w) => normPath(w.file)).filter((f) => f && !SCRATCH_RE.test(f))
  );
  const prompt = (digest.prompt || "").slice(0, 2000);

  return {
    ts: new Date().toISOString(),
    session: (meta.session || "").slice(0, 8),
    // No timestamp in the key: an hour stamp split a task whose turn ended across the hour into
    // two rows, which double-counts — worse than the case it fixed. Two identical prompts in one
    // session therefore share a key and the fuller row wins (see dedupe), so such a pair is
    // under-counted by one task. Losing data is acceptable; inflating an angle's score is not.
    taskKey: (meta.session || "").slice(0, 8) + ":" + hash(prompt),
    cwd: meta.cwd || "",
    prompt: prompt.slice(0, 160).replace(/\s+/g, " "),
    class: digest.classLine || "",
    // A row built from a window whose start was never found may merge the previous task.
    windowComplete: meta.windowComplete !== false,
    weakAcceptSignal: projectFiles.size <= 1,
    filesTouched: projectFiles.size,
    orchestrator: sumOrchestratorUsage(records || []),
    gates: {
      built: /· build yes/.test((checkResult && checkResult.summary) || ""),
      // From the digest, not the summary line: check() stopped printing code-review when it left
      // every lane, and a grep on the old text would have recorded `false` forever.
      codeReview:
        (digest.skills || []).some((s) => /code-review/i.test(s.skill || "")) ||
        (digest.slashCommands || []).some((s) => /code-review/.test(s)),
      receipt: Boolean(digest.hasReceipt),
      warnings: ((checkResult && checkResult.warnings) || []).length,
    },
    writes: writes.length,
    // The most expensive habit measured so far belongs in the durable record, not only in a report
    // the next task overwrites.
    sleepSeconds: Math.round(digest.sleepSeconds || 0),
    sleepCalls: digest.sleepCalls || 0,
    sleepLoop: Boolean(digest.sleepLoop),
    agents,
    findings,
  };
}

// Append-only: one line, one syscall. A concurrent hook appends its own line rather than
// overwriting ours, and a task that ends its turn twice simply leaves two rows — stats.js keeps
// the fullest per taskKey. Nothing here rewrites history: a rewrite-the-last-row variant was
// tried and dropped, because two sessions ending a turn together would race on the whole file.
// The one residual risk is a half-written or interleaved line, which the reader drops as
// unparseable — and the next row starts on a fresh line even after a torn one.
function appendRow(row) {
  fs.mkdirSync(DIR, { recursive: true });
  return appendRowTo(LEDGER, row);
}
function appendRowTo(file, row) {
  let lead = "";
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size) {
      const fd = fs.openSync(file, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) lead = "\n";
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  fs.appendFileSync(file, lead + JSON.stringify(row) + "\n", "utf8");
  return file;
}

module.exports = { buildRow, appendRow, appendRowTo, parseAgentResult, collectResults, angleFindingCount, ownAgentIds, handbackAgentId, editedAfter, roleOf, hash, LEDGER, FINDING_RE };
