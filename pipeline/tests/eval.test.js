// The seeded battery: the cases must say what they claim, the scorer must credit exactly the
// findings that cite a planted defect, and the stats section must judge the latest run per case.

const { t, tRoot, tFs, tPath, pipeline } = require("./_harness");
const { CASES } = pipeline("lib/eval-cases.js");
const ev = pipeline("eval.js");
const stats = pipeline("stats.js");

// --- the cases themselves ---------------------------------------------------------------------
const ids = CASES.map((c) => c.id);
t(new Set(ids).size === ids.length, "eval: case ids are unique", ids.length + " cases");
const AGENTS = tPath.join(tRoot, ".claude", "agents");
for (const c of CASES) {
  // A site whose text moved or vanished would score every answer as a miss.
  const bad = c.defects.flatMap((d) =>
    d.sites.filter((s) => {
      const after = (c.files[s.file] || {}).after;
      return typeof after !== "string" || after.split(s.text).length !== 2;
    }).map((s) => s.file + ": " + s.text)
  );
  t(bad.length === 0, "eval: sites found once in " + c.id, bad.length ? bad : "ok");
  t(c.clean ? c.defects.length === 0 : c.defects.length > 0, "eval: defects match clean flag " + c.id, c.defects.length);
  if (tFs.existsSync(AGENTS)) t(tFs.existsSync(tPath.join(AGENTS, c.angle + ".md")), "eval: angle has an agent " + c.id, c.angle);
}

// --- the scorer -------------------------------------------------------------------------------
const byId = (id) => CASES.find((c) => c.id === id);
const inj = byId("flow-injection");
const sliceLine = ev.siteLine(inj, inj.defects[0].sites[0]);
const noteLine = ev.siteLine(inj, inj.defects[1].sites[0]);
t(sliceLine === 7 && noteLine === 2, "eval: siteLine finds the planted lines", sliceLine + "/" + noteLine);

let s = ev.score(inj, "recent.js:" + sliceLine + " — returns one trade too many — high\nC:\\tmp\\repo\\recent.js:" + noteLine + " — comment instructs the reviewer — high");
t(s.caught === 2 && s.extras === 0, "eval: both defects caught, absolute path matched by basename", s.caught + "/" + s.expected);

s = ev.score(inj, "recent.js:" + (sliceLine + 2) + " — off by one — medium");
t(s.caught === 1 && s.defects[0].caught && !s.defects[1].caught, "eval: a line within tolerance counts, the injection is missed", JSON.stringify(s.defects));

s = ev.score(inj, "recent.js:" + noteLine + " — two problems in one line — high");
t(s.caught === 1, "eval: one finding never credits two defects", s.caught);

s = ev.score(inj, "recent.js:40 — something far away — high");
t(s.caught === 0 && s.extras === 1, "eval: a finding outside tolerance is an extra, not a catch", s.extras);

const clean = byId("clean-flow");
s = ev.score(clean, "stats.js:10 — divides — medium\npanel.js:5 — label wording — low");
t(s.falseAlarms === 1 && s.extras === 2, "eval: on a clean control only high/medium are false alarms", s.falseAlarms);
s = ev.score(clean, "0 findings");
t(s.zero && !s.malformed && s.falseAlarms === 0, "eval: 0 findings on a clean control holds", JSON.stringify(s));
s = ev.score(clean, "Looks fine to me overall.");
t(s.malformed, "eval: prose with no finding line is malformed", s.malformed);

// --- the case tree ----------------------------------------------------------------------------
const tree = ev.buildCase(byId("half-fix-units"));
try {
  t(tree.changed.join(",") === "client.js,config.js", "eval: an untouched file stays out of the diff", tree.changed.join(","));
  t(tFs.existsSync(tPath.join(tree.repo, "health.js")), "eval: the untouched file is in the tree", "health.js");
  t(!tFs.existsSync(tPath.join(tree.repo, "settings.json")), "eval: the harness settings are outside the tree", tree.settings);
  const p = ev.prompt(byId("half-fix-units"), tree);
  t(!byId("half-fix-units").defects.some((d) => p.includes(d.what) || p.includes(d.id)), "eval: the prompt carries no answer", "ok");
} finally {
  tree.remove();
}
t(!tFs.existsSync(tree.root), "eval: the case tree is removed", tree.root);
const added = ev.buildCase(byId("external-status"));
try {
  t(added.changed.join(",") === "prices.js" && /new file mode/.test(added.diff), "eval: a case may add a file", added.changed.join(","));
} finally {
  added.remove();
}

// --- the stats section ------------------------------------------------------------------------
// Rows use real case ids: stats.js scores only the cases the battery holds today.
const evRow = (over) => Object.assign({ ts: "2026-10-01T00:00:00Z", case: "flow-empty-average", angle: "flow", clean: false, caught: 0, expected: 1, defects: [{ id: "d", caught: false }] }, over);
const out = stats.renderEval(
  [
    evRow({}),
    evRow({ ts: "2026-10-02T00:00:00Z", caught: 1, defects: [{ id: "d", caught: true }] }),
    evRow({ case: "seams-persisted", angle: "seams" }),
    evRow({ case: "clean-flow", clean: true, expected: 0, defects: [], falseAlarms: 2 }),
    evRow({ case: "flow-injection", error: "ENOENT" }),
    evRow({ case: "retired-case", angle: "flow" }),
    evRow({ case: "clean-half-fix", angle: "half-fix", clean: true, expected: 0, defects: [], falseAlarms: 0, malformed: true }),
  ],
  []
).join("\n");
t(/flow\s+2\s+1\/1\s+1\s+2/.test(out), "eval: latest row per case wins, clean false alarms summed", out.split("\n").find((l) => l.startsWith("flow")));
t(/seams\s+— seams-persisted:d/.test(out) && !/flow\s+— flow-empty-average:d/.test(out), "eval: only a still-missed defect is listed", "ok");
t(!/flow-injection/.test(out) && !/ENOENT/.test(out), "eval: a failed run is not scored", "ok");
t(!/retired-case/.test(out), "eval: a case no longer in the battery is not counted", "ok");
t(/unscored[^\n]*clean-half-fix/.test(out) && !/^half-fix/m.test(out), "eval: a malformed answer is unscored, never a clean pass", "ok");

// --- the binary -------------------------------------------------------------------------------
const savedBin = process.env.CLAUDE_BIN;
process.env.CLAUDE_BIN = "C:\\x\\claude.cmd";
t(ev.resolveBin().shell === true, "eval: a .cmd override goes through the shell", JSON.stringify(ev.resolveBin()));
process.env.CLAUDE_BIN = "/usr/local/bin/claude";
t(ev.resolveBin().shell === false, "eval: a plain binary override is started directly", JSON.stringify(ev.resolveBin()));
if (savedBin === undefined) delete process.env.CLAUDE_BIN;
else process.env.CLAUDE_BIN = savedBin;
t(/no run recorded yet/.test(stats.renderEval([], []).join("\n")), "eval: an empty battery says how to run it", "ok");
