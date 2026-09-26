// The scorecard: aggregation, thresholds, dedupe, and the delta fixes that once double-counted.

const { t, pipeline } = require("./_harness");
const led = pipeline("lib/ledger.js");

// --- stats: aggregation, thresholds, dedupe -------------------------------------------------
const stats = pipeline("stats.js");
const row = (over) =>
  Object.assign(
    {
      ts: "2026-09-10T00:00:00Z", taskKey: "s1:aaa", windowComplete: true, weakAcceptSignal: false,
      orchestrator: { input: 10, output: 5 }, agents: [], findings: [],
    },
    over
  );

// A weak-signal task contributes cost but not acceptance.
const agg = stats.aggregate([
  row({
    agents: [{ type: "flow", role: "angle", tokens: 100, findings: 1, bySeverity: { high: 1, medium: 0, low: 0 } }],
    findings: [{ agent: "flow", role: "angle", file: "a.rs", line: 1, severity: "high", unique: true, editedAfter: true }],
  }),
  row({
    taskKey: "s1:bbb", weakAcceptSignal: true,
    agents: [{ type: "flow", role: "angle", tokens: 900, findings: 1, bySeverity: { high: 0, medium: 0, low: 1 } }],
    findings: [{ agent: "flow", role: "angle", file: "b.rs", line: 2, severity: "low", unique: true, editedAfter: true }],
  }),
]);
const flowStats = agg.byRole.angle.get("flow");
t(flowStats.runs === 2, "stats: both runs counted", flowStats.runs);
t(flowStats.judged === 1, "stats: weak task not judged", flowStats.judged);
t(flowStats.tokens === 1000 && flowStats.tokensJudged === 100, "stats: cost split by population", flowStats.tokensJudged);
t(flowStats.weighted === 10, "stats: high weighted 10", flowStats.weighted);

// Support agents never land in the angle scorecard.
const agg2 = stats.aggregate([
  row({ agents: [{ type: "verify-finding", role: "support", tokens: 50, findings: 0, bySeverity: {} }] }),
]);
t(agg2.byRole.angle.size === 0, "stats: support out of angle table", agg2.byRole.angle.size);
t(agg2.byRole.support.get("verify-finding").runs === 1, "stats: support counted separately", 1);

// dedupe keeps the last row per task and drops an incomplete window.
const deduped = stats.dedupe([
  row({ taskKey: "k1", writes: 1 }),
  row({ taskKey: "k1", writes: 2 }),
  row({ taskKey: "k2", windowComplete: false }),
]);
t(deduped.length === 1 && deduped[0].writes === 2, "stats: dedupe keeps last, drops fragment", deduped.length);

// Thresholds: no verdict below MIN_RUNS, and a low acted% needs a real sample.
const thin = Object.assign(stats.aggregate([]).byRole.angle.get("x") || {}, {
  runs: 5, judged: 4, acted: 0, uniqueActed: 0, unique: 0, findings: 4, malformed: 0, tokensJudged: 10, dupWith: new Map(),
});
t(/keep collecting/.test(stats.measureFor("x", thin, 100)), "stats: no verdict on 5 runs", "collecting");
const noValue = Object.assign({}, thin, { runs: 14, judged: 25, acted: 3, uniqueActed: 0 });
t(/move it out of the row/.test(stats.measureFor("x", noValue, 100)), "stats: zero value -> demote", "demote");

// --- delta fixes: one-segment paths, silence vs nothing-to-judge, overlap only between angles ---
t(led.editedAfter([{ step: 9, file: "tests.rs" }], 1, "crates/b/src/tests.rs") === null, "ledger: bare-name write is ambiguous", "null");
t(led.editedAfter([{ step: 9, file: "crates/b/src/tests.rs" }], 1, "tests.rs") === null, "ledger: bare-name finding is ambiguous", "null");
t(led.editedAfter([{ step: 9, file: "tests.rs" }], 1, "tests.rs") === true, "ledger: identical bare name", true);

// An angle silent on judgeable tasks must reach the demote verdict, not "nothing to judge".
const silentAngle = { runs: 14, judgedRuns: 14, judged: 0, acted: 0, uniqueActed: 0, unique: 0, findings: 0, malformed: 0, tokensJudged: 100, dupWith: new Map() };
t(/move it out of the row/.test(stats.measureFor("x", silentAngle, 100)), "stats: silent angle demoted", "demote");
const allWeak = { runs: 14, judgedRuns: 0, judged: 0, acted: 0, uniqueActed: 0, unique: 0, findings: 3, malformed: 0, tokensJudged: 0, dupWith: new Map() };
t(/nothing is judgeable/.test(stats.measureFor("x", allWeak, 100)), "stats: all-weak gets no verdict", "no verdict");

// A support agent citing the same line must not become a fold-into candidate.
const aggDup = stats.aggregate([
  row({
    agents: [
      { type: "flow", role: "angle", tokens: 10, findings: 1, bySeverity: { high: 0, medium: 0, low: 1 } },
      { type: "fix-diff", role: "support", tokens: 10, findings: 1, bySeverity: { high: 0, medium: 0, low: 1 } },
    ],
    findings: [
      { agent: "flow", role: "angle", file: "a.rs", line: 3, severity: "low", unique: false, editedAfter: true },
      { agent: "fix-diff", role: "support", file: "a.rs", line: 3, severity: "low", unique: false, editedAfter: true },
    ],
  }),
]);
t(aggDup.byRole.angle.get("flow").dupWith.size === 0, "stats: support is not an overlap", aggDup.byRole.angle.get("flow").dupWith.size);

// Every angle malformed at once is the transcript's shape, not the agents: the hand-back format
// of 2026-09-18 read as three days of agent failures with per-angle "fix the agent file" advice.
{
  const blind = (i) => row({
    taskKey: "s1:blind" + i,
    agents: [
      { type: "flow", role: "angle", tokens: 100, findings: 0, malformed: true, bySeverity: {} },
      { type: "half-fix", role: "angle", tokens: 100, findings: 0, malformed: true, bySeverity: {} },
    ],
  });
  const many = Array.from({ length: stats.MIN_RUNS }, (_, i) => blind(i));
  t(stats.parserSuspect(stats.aggregate(many).byRole), "stats: all angles malformed trips the parser alarm", true);
  const banner = stats.render(many, []).some((l) => /transcript shape has changed/.test(l));
  t(banner, "stats: the alarm is printed above the table", banner);
  const few = many.slice(0, stats.MIN_RUNS - 1);
  t(!stats.parserSuspect(stats.aggregate(few).byRole), "stats: under MIN_RUNS the alarm stays quiet", false);
  const oneFine = many.concat([row({
    taskKey: "s1:fine",
    agents: [{ type: "flow", role: "angle", tokens: 100, findings: 1, malformed: false, bySeverity: { high: 1 } }],
    findings: [{ agent: "flow", role: "angle", file: "a.rs", line: 1, severity: "high", unique: true, editedAfter: true }],
  })]);
  // 12 of 13 flow runs malformed is still 92%: one healthy answer does not clear the alarm...
  t(stats.parserSuspect(stats.aggregate(oneFine).byRole), "stats: one healthy answer does not clear the alarm", true);
  // ...but an angle answering fine in a third of its runs does — that is one agent broken, not the parser.
  const mixed = many.concat(Array.from({ length: 6 }, (_, i) => row({
    taskKey: "s1:ok" + i,
    agents: [{ type: "flow", role: "angle", tokens: 100, findings: 0, malformed: false, saidZero: true, bySeverity: {} }],
  })));
  t(!stats.parserSuspect(stats.aggregate(mixed).byRole), "stats: one healthy angle clears the alarm", false);
}
