#!/usr/bin/env node
// Regression suite for the pipeline. Run it after ANY edit to gate-check.js, its lib/, leak-check,
// the ledger or the stats:
//   node ~/.claude/pipeline/test.js        (absolute path when a tool, not a shell, runs it)
// Non-zero exit means a case failed. Every case here is a defect that actually shipped once —
// keep them, and add one whenever a new hole is found rather than trusting a re-read.
//
// One file per subject under tests/, found by scanning the folder (a new test file cannot be
// forgotten the way a list forgets it); this file only runs them and sums the result.
// --prefix <root> tests a sandbox install (see tests/_harness.js for why HOME= is not enough).

const { state } = require("./tests/_harness");

const fs = require("fs");
const path = require("path");
const subjects = fs.readdirSync(path.join(__dirname, "tests")).filter((f) => f.endsWith(".test.js")).sort();
for (const subject of subjects.map((f) => f.replace(/\.test\.js$/, ""))) {
  // A subject whose file is present but cannot load (a module it requires renamed or missing
  // from a partial install) is one FAIL line in the same report the installers parse — never a
  // raw stack trace and exit 1 with no count. A test FILE missing from an install is not seen
  // here: the installer copies and prunes by its manifest, and that is where a missing file is
  // caught.
  try {
    require("./tests/" + subject + ".test.js");
  } catch (e) {
    state.cases += 1;
    state.failed += 1;
    console.log("FAIL", ("suite: " + subject + " could not run").padEnd(34), (e && e.message ? e.message : String(e)).split("\n")[0]);
  }
}

console.log(state.failed ? "\nFAILURES: " + state.failed + " of " + state.cases : "\nall " + state.cases + " cases passed");
process.exit(state.failed ? 1 : 0);
