#!/usr/bin/env node
// Aggregates ledger.jsonl into a per-angle scorecard and, where the evidence is strong enough,
// proposes a concrete measure. Read-only: it never edits an agent or the pipeline.
//
//   node stats.js                     every recorded task
//   node stats.js --last 30           the most recent 30 tasks
//   node stats.js --since 2026-09-15  only tasks after a date — use this after rewriting an angle,
//                                     or its pre-rewrite history keeps dragging the average down
//
// What it deliberately does NOT do: rank angles by how many findings they produce. Counting
// findings as value is the fastest way to get more findings and less signal — the measure that
// matters is UNIQUE findings that were acted on, weighted by severity, against what they cost.

const fs = require("fs");
const path = require("path");
const led = require("./lib/ledger");

const LEDGER = led.LEDGER;
// Below this many runs an angle's numbers are noise, and no measure is proposed for it.
const MIN_RUNS = 12;
// A single finding must not flip a verdict: 40% on ten findings moves 10 points per finding.
const MIN_JUDGED = 20;
// A high is worth more than a handful of lows, or the sort order contradicts the advice below it.
const SEVERITY_WEIGHT = { high: 10, medium: 3, low: 1 };

function readRows(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a half-written line from a killed process: skip it
    }
  }
  return rows;
}

// Append-only ledger: the same task may appear more than once (a turn ended twice). Keep the last
// row per task key, and drop rows built from a window whose start was never found.
function dedupe(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.windowComplete === false) continue;
    // No task key means a row from a schema older than dedupe: it cannot be matched to a task, so
    // counting it would double-count whatever task it belonged to.
    const k = r.taskKey || "";
    if (!k) continue;
    // The fullest row wins, not the last: a task whose turn ended twice appends a second row, and
    // taking the richer one avoids counting the same review twice or keeping a partial view.
    const prev = byKey.get(k);
    const size = (x) => (x.agents || []).length * 1000 + (x.findings || []).length;
    if (!prev || size(r) >= size(prev)) byKey.set(k, r);
  }
  return [...byKey.values()];
}

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

function fmt(n) {
  if (!isFinite(n)) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "K";
  return String(Math.round(n));
}

function blank() {
  return {
    runs: 0, judgedRuns: 0, tokens: 0, tokensJudged: 0, ms: 0, findings: 0, unique: 0, acted: 0,
    uniqueActed: 0, judged: 0, weighted: 0, silent: 0, malformed: 0,
    high: 0, medium: 0, low: 0, dupWith: new Map(),
  };
}

// The whole aggregation, as one pure function so the tests can drive it with synthetic rows.
function aggregate(rows) {
  const byRole = { angle: new Map(), support: new Map(), generic: new Map() };
  let orchTokens = 0;
  let agentTokens = 0;
  let weakTasks = 0;

  for (const row of rows) {
    const o = row.orchestrator || {};
    orchTokens += (o.input || 0) + (o.output || 0);
    // On a single-file task "edited afterwards" is true for everything and means nothing.
    const weak = row.weakAcceptSignal === true;
    if (weak) weakTasks += 1;

    for (const a of row.agents || []) {
      // A row written before the role field existed: classify by type, not as generic.
      const role = a.role || led.roleOf(a.type);
      const map = byRole[role] || byRole.generic;
      if (!map.has(a.type)) map.set(a.type, blank());
      const s = map.get(a.type);
      s.runs += 1;
      if (!weak) s.judgedRuns += 1;
      s.tokens += a.tokens || 0;
      // Cost and value must come from the same population, or an angle that mostly runs on
      // single-file tasks looks expensive purely as a counting artefact.
      if (!weak) s.tokensJudged += a.tokens || 0;
      s.ms += a.durationMs || 0;
      s.findings += a.findings || 0;
      agentTokens += a.tokens || 0;
      if (!a.findings) s.silent += 1;
      if (a.malformed) s.malformed += 1;
      const sev = a.bySeverity || {};
      s.high += sev.high || 0;
      s.medium += sev.medium || 0;
      s.low += sev.low || 0;
    }

    const byKey = new Map();
    for (const f of row.findings || []) {
      const k = (f.file + ":" + f.line).toLowerCase();
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(f);
    }
    for (const f of row.findings || []) {
      const role = f.role || led.roleOf(f.agent);
      const map = byRole[role] || byRole.generic;
      if (!map.has(f.agent)) map.set(f.agent, blank());
      const s = map.get(f.agent);
      if (f.unique) s.unique += 1;
      // editedAfter === null means the evidence was ambiguous (a bare filename with a namesake
      // elsewhere): it belongs in neither the numerator nor the denominator.
      if (!weak && f.editedAfter !== null && f.editedAfter !== undefined) {
        s.judged += 1;
        if (f.editedAfter) s.acted += 1;
        if (f.unique && f.editedAfter) {
          s.uniqueActed += 1;
          s.weighted += SEVERITY_WEIGHT[f.severity] || 1;
        }
      }
      if (!f.unique) {
        const k = (f.file + ":" + f.line).toLowerCase();
        for (const other of byKey.get(k) || []) {
          if (other.agent === f.agent) continue;
          // Only another ANGLE counts as an overlap; folding an angle into a support agent is not
          // a measure that makes sense.
          if ((other.role || led.roleOf(other.agent)) !== "angle") continue;
          s.dupWith.set(other.agent, (s.dupWith.get(other.agent) || 0) + 1);
        }
      }
    }
  }
  return { byRole, orchTokens, agentTokens, weakTasks };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// One proposal per angle. Deliberately conservative, and never "delete": an angle with rare but
// serious catches always looks worse in a table than a chatty one.
function measureFor(type, s, medianCost) {
  if (s.runs < MIN_RUNS) return "only " + s.runs + " runs; keep collecting, decide nothing";
  const costPer = s.uniqueActed ? s.tokensJudged / s.uniqueActed : Infinity;
  const topDup = [...s.dupWith.entries()].sort((a, b) => b[1] - a[1])[0];
  if (s.malformed > s.runs / 2) return s.malformed + " of " + s.runs + " answers broke the return contract: fix the agent file, the numbers mean nothing yet";
  // No JUDGEABLE RUN is a different fact from no finding: the first cannot be judged, the second
  // is exactly what a demote verdict is for.
  if (s.judgedRuns === 0) return "every run landed on a single-file task, so nothing is judgeable; no verdict";
  if (s.uniqueActed === 0) return "0 unique findings acted on in " + s.runs + " runs: move it out of the row, keep it as a conditional";
  if (s.judged >= MIN_JUDGED && pct(s.acted, s.judged) < 40) return "only " + pct(s.acted, s.judged) + "% of findings led to an edit: narrow its search procedure";
  if (topDup && topDup[1] > s.unique) return "mostly duplicates `" + topDup[0] + "` (" + topDup[1] + " overlaps vs " + s.unique + " unique): consider folding the two";
  if (medianCost && costPer > medianCost * 3) return fmt(costPer) + " tok per useful finding, 3x the median: drop it to a cheaper model";
  return "holding its own, no change";
}

// Every angle broke its contract at once — that is the transcript's shape, not nine agents
// going wrong in the same hour. It happened on 2026-09-18, when the harness moved the report
// into a separate hand-back turn: three days of "0 findings, 100% malformed" read as agent
// failures, and the per-angle advice said "fix the agent file". Angles with fewer runs than
// MIN_RUNS are ignored, or a single broken answer on a rare angle would trip it.
function parserSuspect(byRole) {
  const judged = [...byRole.angle.values()].filter((s) => s.runs >= MIN_RUNS);
  return judged.length > 0 && judged.every((s) => s.malformed >= s.runs * 0.9);
}

function render(rows, out) {
  const { byRole, orchTokens, agentTokens, weakTasks } = aggregate(rows);
  const say = (s) => out.push(s);

  say("tasks: " + rows.length + " · orchestrator " + fmt(orchTokens) + " tok · agents " + fmt(agentTokens) + " tok");
  if (parserSuspect(byRole)) {
    say("");
    say("!! EVERY angle with " + MIN_RUNS + "+ runs is malformed in 90%+ of them: the transcript shape has changed,");
    say("!! not the agents. Read a fresh agent answer in the session journal and fix lib/ledger.js");
    say("!! (collectResults) before trusting one number below — the proposals are void until then.");
  }
  say("");
  say(
    "angle".padEnd(16) + "runs".padStart(5) + "quiet".padStart(6) + "find".padStart(6) +
      "uniq".padStart(6) + "acted".padStart(6) + "u+a".padStart(5) + "acted%".padStart(8) +
      "score".padStart(7) + "tok/run".padStart(9) + "tok/u+a".padStart(9)
  );
  say("-".repeat(83));

  const angles = [...byRole.angle.entries()].sort((a, b) => b[1].weighted - a[1].weighted);
  for (const [type, s] of angles) {
    say(
      type.padEnd(16) +
        String(s.runs).padStart(5) +
        String(s.silent).padStart(6) +
        String(s.findings).padStart(6) +
        String(s.unique).padStart(6) +
        String(s.acted).padStart(6) +
        String(s.uniqueActed).padStart(5) +
        (s.judged ? pct(s.acted, s.judged) + "%" : "—").padStart(8) +
        String(s.weighted).padStart(7) +
        fmt(s.tokens / (s.runs || 1)).padStart(9) +
        (s.uniqueActed ? fmt(s.tokensJudged / s.uniqueActed) : "—").padStart(9)
    );
  }
  if (!angles.length) say("(no review angle has run yet)");

  const support = [...byRole.support.entries(), ...byRole.generic.entries()];
  if (support.length) {
    say("");
    say("support / generic agents — cost only, never scored as angles:");
    for (const [type, s] of support) {
      say("  " + type.padEnd(16) + String(s.runs).padStart(4) + " runs · " + fmt(s.tokens) + " tok · " + Math.round(s.ms / 1000) + "s");
    }
  }

  say("");
  say("quiet = runs with no finding · uniq = no OTHER angle cited that same file:line · acted =");
  say("the cited file was edited afterwards · u+a = both · score = u+a weighted 10/3/1 by severity.");
  if (weakTasks) {
    say("");
    say(weakTasks + " of " + rows.length + " tasks touched one project file or none — there \"edited");
    say("afterwards\" is true by construction, so those tasks are excluded from acted, acted%, u+a,");
    say("score and tok/u+a. They ARE counted in runs, quiet, find, uniq and tok/run — so read uniq");
    say("against find, never against u+a.");
  }

  const costs = angles.filter(([, s]) => s.uniqueActed).map(([, s]) => s.tokensJudged / s.uniqueActed);
  const medianCost = median(costs);
  say("");
  say("proposed measures (a verdict needs " + MIN_RUNS + "+ runs; an acted% verdict " + MIN_JUDGED + "+ judged findings):");
  for (const [type, s] of angles) say("  " + type.padEnd(16) + "— " + measureFor(type, s, medianCost));

  say("");
  say("A measure is a proposal, not an action: read the angle's own file before applying one, and");
  say("re-run with --since after a rewrite so the old history stops dragging the average.");
  say("Two things this table cannot see: it dedupes by exact file:line, so two angles describing");
  say("one defect at different lines both count as unique; and misses — what the review let");
  say("through — are not in it at all.");
  return out;
}

module.exports = { aggregate, measureFor, dedupe, render, readRows, parserSuspect, SEVERITY_WEIGHT, MIN_RUNS, MIN_JUDGED };

if (require.main === module) {
  if (!fs.existsSync(LEDGER)) {
    console.log("no ledger yet: " + LEDGER);
    console.log("It fills up on its own — one line per task, written by the Stop hook.");
    process.exit(0);
  }
  const args = process.argv.slice(2);
  const lastAt = args.indexOf("--last");
  const sinceAt = args.indexOf("--since");
  let rows = dedupe(readRows(LEDGER));
  if (sinceAt !== -1 && args[sinceAt + 1]) {
    const since = args[sinceAt + 1];
    rows = rows.filter((r) => String(r.ts || "") >= since);
  }
  if (lastAt !== -1) rows = rows.slice(-(Number(args[lastAt + 1]) || 0));
  if (!rows.length) {
    console.log("no tasks match");
    process.exit(0);
  }
  console.log(render(rows, []).join("\n"));
}
