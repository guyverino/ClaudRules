#!/usr/bin/env node
// Pipeline gate check. Reads the session transcript straight from disk and compares what the
// orchestrator DECLARED against what the record SHOWS. Three ways in:
//   digest  (Stop hook, stdin payload)     - writes the digest + report for that session
//   digest  (run by hand, no stdin)        - picks the newest transcript for the current cwd,
//                                            so the report can go into the receipt's `check:`
//                                            line (the Stop hook fires too late for that)
//   report  (UserPromptSubmit hook)        - surfaces an unread report that found discrepancies
//
// Deliberately dumb and deterministic: list comparison only, no judgement — this IS the audit;
// the receipt is the orchestrator account of itself, the digest here is the evidence.
//
// Per-session filenames on purpose: several sessions run against this repo at once, and a shared
// report file means one session clean Stop erases another unread discrepancy.
//
// The work lives in lib/: transcript.js (find, read, slice the task), digest.js (what the task
// did), checks.js (the gates), late.js (reviewers that answered after the next prompt). This file
// is the entry: the paths, the two modes, and the crash breadcrumb; the payload is lib/hook.js.

const fs = require("fs");
const path = require("path");
const ledger = require("./lib/ledger");
const { pipelineRoot } = require("./lib/root");
const { readStdin, parseHook } = require("./lib/hook");
const { findTranscript, sessionIdOf, parseTranscript } = require("./lib/transcript");
const { buildDigest } = require("./lib/digest");
const { check } = require("./lib/checks");
const { lateRowsFor } = require("./lib/late");

const ROOT = pipelineRoot("gate-check");
const DIR = path.join(ROOT, ".claude", "pipeline");
const MODES = new Set(["digest", "report"]);
const MODE = process.argv[2] || "digest";

const shortId = (sid) => (sid || "unknown").slice(0, 8);
const digestPath = (sid) => path.join(DIR, "last-task-" + shortId(sid) + ".json");
const reportPath = (sid) => path.join(DIR, "gate-report-" + shortId(sid) + ".txt");
const seenPath = (sid) => path.join(DIR, ".report-seen-" + shortId(sid));
// A by-hand run writes here, so it can never clobber the hook-owned digest of another session.
const handPath = (sid) => path.join(DIR, "hand-" + shortId(sid) + ".json");

// Leave a breadcrumb the next run and the developer can find: a crash must not read as "all
// gates passed", and a hook writes {} to stdout, so a failure is otherwise invisible.
function breadcrumb(what, e) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DIR, "gate-check-error.txt"),
      [new Date().toISOString() + " " + what, e && e.stack ? e.stack : String(e), ""].join("\n"),
      "utf8"
    );
  } catch {
    // nowhere to write: stderr is the last resort
  }
}

// --- modes ------------------------------------------------------------------------------
function digest() {
  const hook = parseHook(readStdin());
  const file = findTranscript(hook, ROOT);
  if (!file) {
    process.stdout.write("{}");
    return;
  }
  const sid = sessionIdOf(hook, file);
  const parsed = parseTranscript(file);
  const d = buildDigest(parsed.preamble.concat(parsed.records));
  d.meta = {
    transcript: file,
    session: sid,
    cwd: hook.cwd || process.cwd(),
    recordsInTask: parsed.records.length,
    recordsScanned: parsed.total,
    tailTruncated: parsed.truncated,
    windowComplete: parsed.windowComplete,
    invokedBy: hook.session_id ? "hook" : "hand",
    at: new Date().toISOString(),
  };
  // The §6 batch size, from the agents' own answers: the verify-finding gate reads it. Left
  // undefined when the answers cannot be read, so the gate stays silent rather than wrong.
  try {
    d.reviewFindings = ledger.angleFindingCount(parsed.records);
  } catch (e) {
    breadcrumb("findings", e);
  }
  const res = check(d, d.meta.cwd);
  fs.mkdirSync(DIR, { recursive: true });
  // A by-hand run may well have picked another session's transcript (newest for this cwd), so it
  // writes its own file and never overwrites that session's hook-owned digest or report.
  const out = hook.session_id ? digestPath(sid) : handPath(sid);
  fs.writeFileSync(out, JSON.stringify(d, null, 1), "utf8");
  const body = [
    "pipeline gate check - " + d.meta.at,
    "session: " + shortId(sid) + " · digest: " + out,
    "task prompt: " + d.prompt.slice(0, 160).replace(/\s+/g, " "),
    "",
  ]
    .concat(res.lines)
    .concat(["", "summary: " + res.summary])
    .join("\n");
  if (hook.session_id) {
    fs.writeFileSync(reportPath(sid), body, "utf8");
    // Only the hook owns the seen marker. A by-hand run may well have picked another session's
    // transcript (newest for this cwd), and re-arming that session's report would misattribute it.
    try {
      fs.unlinkSync(seenPath(sid));
    } catch {
      // no previous marker for this session
    }
    if (res.warnings.length === 0) fs.writeFileSync(seenPath(sid), "clean", "utf8");
  }
  // Accounting rides the same pass: what each angle cost and what it caught, straight from the
  // transcript. Its own failure must never take the gate check down with it. A by-hand run
  // writes no row: the Stop hook records the same task moments later, and the hand digest is
  // taken before the final message anyway — one row per task, not three.
  let ledgerNote = hook.session_id ? "" : "ledger: not written by hand (the Stop hook records the task)";
  try {
    if (!hook.session_id) throw Object.assign(new Error("by hand"), { byHand: true });
    // Every task is recorded, including one that fired no agent: otherwise "no review was needed"
    // and "every agent invocation failed" look identical in the statistics.
    const row = ledger.buildRow(parsed.records, d, d.meta, res);
    ledger.appendRow(row);
    // Reviewers of the PREVIOUS task that answered inside this window: re-record that task.
    const late = lateRowsFor(parsed.all, parsed.start, d.meta);
    for (const r of late) ledger.appendRow(r);
    ledgerNote =
      "ledger: " + row.agents.length + " agent(s), " + row.findings.length + " finding(s) -> " + ledger.LEDGER +
      (late.length ? " · " + late.length + " earlier task(s) re-recorded with late agent answers" : "");
  } catch (e) {
    if (!(e && e.byHand)) {
      ledgerNote = "ledger: FAILED - " + (e && e.message ? e.message : String(e));
      breadcrumb("ledger", e);
    }
  }
  // running by hand: print the report, naming the transcript actually taken
  process.stdout.write(
    hook.session_id ? "{}" : "transcript: " + file + "\n" + body + "\n" + (ledgerNote ? ledgerNote + "\n" : "")
  );
}

function report() {
  const hook = parseHook(readStdin());
  const sid = hook.session_id || "";
  const rp = reportPath(sid);
  if (!fs.existsSync(rp) || fs.existsSync(seenPath(sid))) {
    process.stdout.write("");
    return;
  }
  const body = fs.readFileSync(rp, "utf8");
  // Only announce a failed gate when the report actually carries one.
  if (!/^WARN/m.test(body)) {
    fs.writeFileSync(seenPath(sid), "clean", "utf8");
    process.stdout.write("");
    return;
  }
  fs.writeFileSync(seenPath(sid), "shown", "utf8");
  process.stdout.write(
    "<pipeline-gate-check>\n" +
      "The previous task in this session did not satisfy every gate it declared. Read this, and\n" +
      "if a gate was really skipped, say so plainly to the user before starting the new task.\n" +
      "Full report: " + rp + "\n\n" +
      body +
      "\n</pipeline-gate-check>\n"
  );
}

if (!MODES.has(MODE)) {
  process.stderr.write("gate-check: unknown mode " + MODE + " (expected digest|report)\n");
  process.stdout.write("{}");
  process.exit(0);
}

try {
  if (MODE === "report") report();
  else digest();
} catch (e) {
  breadcrumb(MODE, e);
  process.stderr.write("gate-check failed: " + (e && e.message ? e.message : String(e)) + "\n");
  process.stdout.write(MODE === "report" ? "" : "{}");
}
