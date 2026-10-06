// The deterministic gates: a digest in, the report lines out. List comparison only, no judgement
// — this IS the audit; the receipt is the orchestrator's account of itself, the digest is the
// evidence. One function per gate, all fed the same context, in the order the report prints.

const { CODE_FILE_RE, TEST_OR_DOC_RE, SCRATCH_RE, TEST_RUN_RE, TREE_MOVE_RE, FMT_RE, LEAK_MARK_RE, OTHERS_RE, PULL_RE, RELEASE_ACK_RE, SHIP_RE, REVIEW_AGENTS, SUPPORT_AGENTS, testTargeted, testKey } = require("./stacks");

// A shell flag decided at digest time on the full command; an older digest lacks the flag, and
// the (truncated) stored command is judged instead.
const flag = (s, key, re) => (s[key] !== undefined ? s[key] : re.test(s.command));
const stepsWhere = (shell, key, re) => shell.filter((s) => flag(s, key, re)).map((s) => s.step);
const firstOf = (steps, empty) => (steps.length ? Math.min(...steps) : empty);
const distinctFiles = (ws) => new Set(ws.map((w) => String(w.file).toLowerCase())).size;

// A receipt line may declare a gate skipped WITH a reason - that is the pipeline working as
// written, not a silent omission. The checker must read those instead of re-reporting them.
function skipDeclared(text, what) {
  let key;
  try {
    key = new RegExp(what, "i");
  } catch {
    return false; // a malformed pattern must never silence a gate
  }
  // Procedural, not one regex: the marker must be UPPERCASE while the keyword need not be, and a
  // character-class "gap" cannot express that — nor survive a build command full of digits and
  // dashes sitting between the two ("cargo build --target x86_64-… -> SKIPPED: reason").
  const MARKER = /(?:SKIPPED|N\/A|ПРОПУЩЕНО)\s*:\s*\S/; // case-SENSITIVE on purpose
  const OTHER_GATE = /\b(?:build|code-review|simplify|test|runtime|delta|audit|review|fmt)\b/i;
  for (const line of text.split("\n")) {
    if (/<[^>]*>/.test(line)) continue; // a template placeholder, not a statement of fact
    const m = line.match(key);
    if (!m) continue;
    // Only what follows the keyword counts, and only up to the next item separator: a skip
    // declared for the NEXT gate on the same line must not excuse this one.
    const after = line.slice(m.index + m[0].length).split(/[·|]/)[0];
    const at = after.search(MARKER);
    if (at === -1) continue;
    // Another gate's name between keyword and marker means the marker is that gate's, not ours.
    // Occurrences of OUR OWN keyword are stripped first: "build+static: cargo build … SKIPPED:"
    // repeats it inside the very command being reported.
    const gap = after.slice(0, at).replace(new RegExp(what, "gi"), " ");
    if (OTHER_GATE.test(gap)) continue;
    return true;
  }
  return false;
}

// --- the context every gate reads ------------------------------------------------------------
function contextOf(d, cwd) {
  // Only files under the working directory are "the project". Editing the harness itself, or a
  // scratch file, must not demand this project's build and /code-review.
  const root = (cwd || "").toLowerCase().replace(/\\/g, "/");
  const inProject = (f) => {
    const p = String(f || "").toLowerCase().replace(/\\/g, "/");
    if (!p) return false; // unresolved shell target: counted separately, never as a project write
    if (!root) return true;
    // trailing separator, so a sibling folder (moon-terminal-old) is not read as inside the project
    if (/^[a-z]:\//.test(p) || p.startsWith("/")) return p.startsWith(root.replace(/\/?$/, "/"));
    return true; // a relative path is relative to the project
  };
  const angleCalls = d.agents.filter((a) => REVIEW_AGENTS.has(a.type));
  const cls = d.classLine || "";
  // The FIRST review batch is the boundary: a second batch after the fixes would otherwise move
  // it past those very fixes and hide that the delta pass never ran.
  const firstAngle = firstOf(angleCalls.map((a) => a.step), 0);
  const projectWrites = d.writes.filter((w) => !SCRATCH_RE.test(w.file) && inProject(w.file));
  const writesAfter = firstAngle ? d.writes.filter((w) => w.step > firstAngle) : [];
  return {
    d,
    lines: [],
    info: [],
    angles: angleCalls.map((a) => a.type),
    cls,
    // No \b: it is ASCII-only in JS, so "тривиальная" would never register as trivial.
    isTrivial: /(trivial|тривиал)/i.test(cls),
    said: d.assistantText || "",
    receipt: d.hasReceipt,
    built: d.shell.some((s) => s.build),
    firstAngle,
    writesAfter,
    deltaSteps: d.agents.filter((a) => a.type === "fix-diff").map((a) => a.step),
    projectWrites,
    // A shell write whose target could not be resolved is reported, never silently counted as the
    // project: that false positive demanded this project's build for edits to the harness itself.
    unresolved: d.writes.filter((w) => w.unknown),
    // A refused Write/Edit of a project file: the tree lacks it, so a build launched beside it is
    // blind. Outside the project (the harness, another repo) it touches nothing this build reads.
    failedProjectWrites: (d.failedWrites || []).filter((w) => !SCRATCH_RE.test(w.file) && inProject(w.file)),
    codeTouched: projectWrites.some((w) => CODE_FILE_RE.test(w.file)),
    // Files of CODE only (R5): tests and docs beside a fix do not make the delta wide.
    filesAfter: distinctFiles(projectWrites.filter((w) => firstAngle && w.step > firstAngle && CODE_FILE_RE.test(w.file) && !TEST_OR_DOC_RE.test(w.file))),
    othersStep: stepsWhere(d.shell, "others", OTHERS_RE),
  };
}

// --- the gates, in report order --------------------------------------------------------------
function headline(c) {
  const d = c.d;
  if (d.meta && d.meta.windowComplete === false) {
    c.lines.push(
      "WARN  window incomplete - the task start is outside the scanned tail, so every line below " +
        "may describe a fragment or merge the previous task; judge nothing from it"
    );
  }
  c.lines.push("class declared: " + (c.cls || "(NONE - section 0 requires it out loud before the first edit)"));
  c.lines.push("angles fired:   " + (c.angles.length ? c.angles.join(", ") : "(none)"));
  c.lines.push(
    "writes: " + d.writes.length + " (project " + c.projectWrites.length + ", unresolved " + c.unresolved.length + ")" +
      " · shell: " + d.shell.length +
      " · skills: " + (d.skills.map((s) => s.skill).join(",") || "-") +
      " · slash: " + (d.slashCommands.join(",") || "-")
  );
  const generic = d.agents.filter((a) => !REVIEW_AGENTS.has(a.type) && !SUPPORT_AGENTS.has(a.type));
  if (generic.length) {
    c.info.push("note  " + generic.length + " generic subagent(s) (" + generic.map((g) => g.type).join(", ") + ") - fine for research, not a substitute for a named angle");
  }
}

function gateClassAndReview(c) {
  if (!c.cls && c.projectWrites.length) c.lines.push("WARN  s0 - no class line in the recorded text, but files were written");
  if (c.codeTouched && !c.isTrivial && c.angles.length === 0) c.lines.push("WARN  s6 - code was edited, no named review angle fired");
}

function gateBuild(c) {
  if (c.codeTouched && !c.built && !skipDeclared(c.said, "build|s5|§5"))
    c.lines.push("WARN  s5 - code was edited, no build/test command recorded");
  // §5: the formatter runs once before the build. A Rust edit with no fmt in the whole task is
  // exactly how PR #505 went red on CI twice — the local gates had no fmt step to fail.
  const rustTouched = c.projectWrites.some((w) => /\.rs$/i.test(String(w.file)));
  const formatted = c.d.shell.some((s) => flag(s, "fmt", FMT_RE));
  if (rustTouched && !formatted && !skipDeclared(c.said, "fmt|format|s5|§5"))
    c.lines.push("WARN  s5 - Rust files were edited and cargo fmt never ran: CI's fmt job is blocking, run it once before the build");
}

// §1 parallel-work gate: the session opened with PARALLEL WORK (hook attachment) and a project
// file was edited before `leak-check.js others` (or `gh pr list`) ran — the task may be
// duplicating a commit or an open PR nobody looked at. Order is by step; a check that never
// came counts as "before".
function gateParallel(c) {
  const d = c.d;
  if (!c.projectWrites.length || skipDeclared(c.said, "parallel|overlap|s1|§1")) return;
  // Did the first project edit after `at` come before the first check after `at`? `checked` says
  // whether any check came at all — the two WARN wordings differ on that.
  const uncheckedAfter = (at) => {
    const edits = c.projectWrites.filter((w) => w.step > at).map((w) => w.step);
    const checks = c.othersStep.filter((s) => s > at);
    return { fires: edits.length > 0 && firstOf(edits, Infinity) < firstOf(checks, Infinity), checked: checks.length > 0 };
  };
  if (d.parallelPending) {
    const r = uncheckedAfter(-Infinity);
    if (r.fires) c.lines.push("WARN  s1 - PARALLEL WORK at session start, yet a project file was edited " + (r.checked ? "before leak-check.js others ran" : "and leak-check.js others never ran") + ": the task was not compared with what others landed or have open");
  }
  // The rule's second trigger, independent of the first: a pull mid-task in a repo with other
  // contributors (the hook said PARALLEL WORK or CONTRIBUTORS). What came in was not on the
  // session-start line, so the FIRST edit after the pull needs a fresh `others` between them —
  // pull → edit → others → edit is the same shape the session-start check warns on.
  if (d.contributors) {
    for (const at of stepsWhere(d.shell, "pull", PULL_RE)) {
      const r = uncheckedAfter(at);
      if (!r.fires) continue;
      c.lines.push("WARN  s1 - commits were pulled mid-task (step " + at + "), yet a project file was edited afterwards " + (r.checked ? "before a fresh leak-check.js others" : "without a fresh leak-check.js others") + ": what came in was never compared with the task");
      break;
    }
  }
}

// §5 leak gate: the session opened with LEAK REVIEW PENDING (hook attachment) and a build ran
// before `leak-check.js mark` — the build scripts and code generators of the unreviewed commits
// have then already executed. Order is by step; a mark that never came counts as "before". Any
// build the stack table knows (BUILD_RE), not one toolchain's. A mark that FAILED recorded
// nothing (leak-check refuses it when the watched branch is invalid or absent) and clears nothing.
function gateLeak(c) {
  const d = c.d;
  if (!d.leakPending) return;
  const markStep = stepsWhere(d.shell.filter((s) => !s.failed), "leakMark", LEAK_MARK_RE);
  const firstMark = firstOf(markStep, Infinity);
  const earlyBuild = d.shell.find((s) => s.build && s.step < firstMark);
  if (earlyBuild && !skipDeclared(c.said, "leak|s5|§5")) {
    c.lines.push("WARN  s5 - LEAK REVIEW PENDING at session start, yet a build ran " + (markStep.length ? "before leak-check.js mark" : "and the review was never marked") + ": the foreign commits' build scripts have already executed");
  }
}

// §5 release-surface gate: the session opened with RELEASE SURFACE CHANGED (hook attachment) —
// someone else touched the paths that decide what users install — and the tree was built,
// pushed, merged or published before `leak-check.js ack-release`, the record that those diffs
// were read by hand. An ack that never came counts as "before". The publish skill is a ship
// too. A declared skip on the receipt (`release surface: … SKIPPED: reason`) is read, not
// re-reported.
function gateRelease(c) {
  const d = c.d;
  if (!d.releasePending) return;
  const ackStep = stepsWhere(d.shell.filter((s) => !s.failed), "releaseAck", RELEASE_ACK_RE); // a refused ack recorded nothing
  const firstAck = firstOf(ackStep, Infinity);
  const early = d.shell.find((s) => (s.build || flag(s, "ship", SHIP_RE)) && s.step < firstAck);
  const earlyPublish = d.skills.find((s) => /^publish$/i.test(s.skill) && s.step < firstAck) || (!ackStep.length && d.slashCommands.some((s) => /^\/?publish\b/.test(s)) ? { step: -1 } : undefined);
  if ((early || earlyPublish) && !skipDeclared(c.said, "release surface|s5|§5")) {
    const what = earlyPublish && (!early || earlyPublish.step < early.step) ? "/publish ran" : early.build ? "a build ran" : "the tree was pushed or merged";
    c.lines.push("WARN  s5 - RELEASE SURFACE CHANGED at session start, yet " + what + " " + (ackStep.length ? "before leak-check.js ack-release" : "and the diffs were never acknowledged") + ": the release paths changed by others were not read by hand first");
  }
}

function gateReviewFixAndUnresolved(c) {
  const d = c.d;
  // /code-review is not part of any lane any more (§0: 6-8 serial minutes for mediums the angles
  // had covered); only its --fix form is still a finding, because that one writes to the tree.
  const reviewFix =
    d.skills.some((s) => /code-review/i.test(s.skill) && /--fix/.test(s.args || "")) ||
    d.slashCommands.some((s) => s.includes("code-review") && s.includes("--fix"));
  if (reviewFix) c.lines.push("WARN  s6 - /code-review ran with --fix, which writes to the tree");
  // An unresolved target buys NO silence, unconditionally. An earlier version required a build or
  // an agent first, to cut noise - which handed the worst shape (every edit through a heredoc to a
  // variable, no build, no reviewer) a completely clean report. False alarm beats silent pass.
  if (c.unresolved.length && !c.codeTouched) {
    c.lines.push("WARN  s5/s6 not judged - " + c.unresolved.length + " shell write(s) whose target could not be parsed; check by hand whether the project was edited");
  }
}

function gateReceipt(c) {
  if (!c.projectWrites.length || c.receipt) return;
  // By hand the digest is taken BEFORE the final message, so the receipt cannot be there yet.
  const byHand = Boolean(c.d.meta && c.d.meta.invokedBy === "hand");
  c.lines.push(byHand ? "note  s10 - receipt not written yet (by-hand run precedes the final message)" : "WARN  s10 - no receipt block found");
}

// §9 is conditional: fix-diff owes a run only when the post-review edits span 3+ project files
// (a changed signature is the other trigger, and a script cannot see it). Below that the
// orchestrator reads its own delta — a measured call, see §9.
// The tail after the review is where a task actually loses its hours — measured on one session:
// four angles took 4 min in parallel, then 68 min of "agent → fix → build → agent" loops. Three
// shapes carry that, and each one is a rule the text already states but the model does not hold.
function gateDelta(c) {
  const d = c.d;
  const deltaRuns = c.deltaSteps.length;
  if (c.filesAfter >= 3 && !deltaRuns) {
    c.lines.push("WARN  s9 - edits after the review span " + c.filesAfter + " code files, fix-diff never ran (§9's condition is 3+ code files or a signature)");
  }
  // §9 runs once, no re-run: 6 fix-diff runs on one button, 11 across four tasks, 2 acted-on
  // high findings in 33 — the loop fed on nits.
  if (deltaRuns > 1) {
    c.lines.push("WARN  s9 - fix-diff ran " + deltaRuns + " times: §9 runs it once; a high is fixed, built and read by me, never re-run");
  }
  // §8 says /simplify runs before the delta pass and rides it; run after, it re-opens §9.
  const simplifyStep = d.skills.filter((s) => /simplify/i.test(s.skill)).map((s) => s.step);
  const firstDelta = firstOf(c.deltaSteps, 0);
  // The LATEST /simplify is the one judged: an early compliant run must not mask a second one
  // fired after the delta.
  const lastSimplify = simplifyStep.length ? Math.max(...simplifyStep) : 0;
  if (lastSimplify && firstDelta && lastSimplify > firstDelta) {
    c.lines.push("WARN  s8 - /simplify ran after fix-diff: it belongs before the delta pass, its edits ride that one run");
  }
}

// §6: the whole test suite runs ONCE per task, at the end — after the fix batch — not at the §5
// gate and not after every edit (R8: 58 % of all cargo time was test runs, 3–5 full runs per
// landed change). Two are tolerated: a red end-of-task run, its fix, and the re-run. Before R8
// the shape was two and the bound three; 43 test runs across four tasks, 13 on one button.
// `test` is decided on the FULL command at digest time, like `build`; the stored copy is cut at
// 300 characters and a long prefix would hide the run. Older digests lack the flag — fall back.
// Two counts, because one count cried wolf: on the HVol feature 33 runs were 8 full-suite runs
// (2 per task — the shape) and 25 targeted ones, and the WARN that lumped them fired on every
// task and was explained away every time. The full suite is bounded; a targeted run is judged
// only on the one thing that is waste in it — the same command again with no edit in between
// (5 of the 25: the answer was already on screen, and each re-run is a turn over a full context).
function gateTestRuns(c) {
  const d = c.d;
  const runs = d.shell.filter((s) => flag(s, "test", TEST_RUN_RE));
  // Like `test` itself: decided on the full command at digest time; the stored copy is judged
  // only for an older digest, where a cargo clause past 300 characters reads as a full run.
  const targeted = (s) => (s.targeted !== undefined ? s.targeted : testTargeted(s.command));
  const keyOf = (s) => (s.testKey !== undefined ? s.testKey : testKey(s.command));
  // A pull, rebase, merge or branch switch puts a different tree under the next run — the publish
  // step's run after a rebase, the post-merge run on `main` after `git pull`. The bound and the
  // repeat both start over there: those runs are the ones R8 keeps on purpose. A fetch moves no
  // file and does not count.
  const moves = d.shell.filter((s) => TREE_MOVE_RE.test(s.command)).map((s) => s.step);
  const movedBetween = (a, b) => moves.some((m) => m > a && m <= b);
  let full = 0;
  let worst = 0;
  let prevFull;
  for (const s of runs.filter((r) => !targeted(r))) {
    full = prevFull !== undefined && movedBetween(prevFull, s.step) ? 1 : full + 1;
    worst = Math.max(worst, full);
    prevFull = s.step;
  }
  if (worst > 2) {
    c.lines.push("WARN  s6 - the full test suite ran " + worst + " times on one tree: once at the end of the task, after the §6 batch, is the shape; build between edits, test once");
  }
  // §9: the suite waits for fix-diff's answer. Run beside it (or before it) on the tree it was
  // reviewing, it is thrown away the moment fix-diff finds something — and that pair is exactly
  // two full runs, inside the tolerance above, so it needs its own line. "Beside" is launched
  // after the last code edit fix-diff was handed and BEFORE its answer arrived (answeredAt, in
  // either order within the launching turn); a run after the answer that went red, its fix and the
  // re-run is the §6 tolerance, not this. "Its fix" is a project edit after the answer that is not
  // a document — a memory note (outside the project) or a doc re-runs nothing; a test file or a
  // web asset the suite embeds does. An unresolved shell write (a log redirect) is left out: the
  // gate prefers silence to a WARN with no fix behind it. No recorded answer (an older digest, an
  // answer outside the window) stays silent: the launch step alone cannot tell the shapes apart.
  const codeEdits = c.projectWrites.filter((w) => !/\.(?:md|txt|rst|adoc)$/i.test(w.file)).map((w) => w.step);
  const fullRuns = runs.filter((r) => !targeted(r));
  const besideDelta = d.agents.filter((a) => a.type === "fix-diff" && a.answeredAt !== undefined).some((a) => {
    const reviewedFrom = Math.max(0, ...codeEdits.filter((s) => s < a.step));
    const fixAt = firstOf(codeEdits.filter((s) => s > a.answeredAt), 0);
    const beside = fixAt ? fullRuns.find((s) => s.step > reviewedFrom && s.step <= a.answeredAt) : undefined;
    const rerun = beside ? fullRuns.find((s) => s.step > fixAt) : undefined;
    return Boolean(rerun && !movedBetween(beside.step, rerun.step));
  });
  if (besideDelta) {
    c.lines.push("WARN  s9 - the full suite ran before fix-diff answered, then again after its fix: beside fix-diff only the build and the linter run, the suite waits for its answer");
  }
  const lastRun = new Map(); // test key -> step of its previous run
  let repeats = 0;
  for (const s of runs) {
    const key = keyOf(s);
    if (!key) continue;
    const prev = lastRun.get(key);
    // Any write between the two runs — including one INSIDE this command (`patch.py && cargo
    // test`), and an unresolved shell write — makes the re-run a fresh question, not a repeat;
    // so does a pull or a switch that changed the tree under it.
    if (prev !== undefined && !d.writes.some((w) => w.step > prev && w.step <= s.step) && !movedBetween(prev, s.step)) repeats += 1;
    lastRun.set(key, s.step);
  }
  if (repeats) {
    c.lines.push("WARN  s6 - " + repeats + " test run(s) repeated the previous command with no edit in between: the answer was already on screen, and each re-run is a whole turn over the full context");
  }
}

// §6: confirmed fixes land as ONE batch, then §5 runs once. The other shape is one fix, one
// build, the next fix, the next build — seven `cargo check` in 76 s on one review round, each a
// turn over an 800k context. Before the review, edit → check is how development goes and is not
// bounded here.
// Counted PER REVIEW ROUND, and only the pairs that are the habit. Read against six flagged tasks
// (03.10), the old count — every edit→build since the first angle — was mostly three legitimate
// shapes: a task with two rounds charged the whole development of its second stage to the
// first round (10 "pairs", 3 real); the one fix §9 allows after fix-diff's answer, then its
// build; and a batch whose build came back red, repaired, rebuilt — the batch's own compile
// error, not the next fix. Those three are left out; what remains is a green build followed by
// one more fix. The one real loss in those tasks — a build launched beside a patch script that
// died half-way — is gateBlindBuild's, not this count's.
function gateFixBatch(c) {
  const d = c.d;
  if (!c.firstAngle) return;
  // A fix is a CODE edit, or a shell write whose target could not be resolved: a fix through an
  // opaque patch script is the very shape of this loop, and reading only the resolved writes
  // would let it pass in silence. A document beside the fixes asks for no build.
  // (CODE_FILE_RE carries `md` through CODE_EXT, for the write scanner — hence the document
  // filter on top.)
  const edits = c.projectWrites.filter((w) => CODE_FILE_RE.test(w.file) && !/\.(?:md|txt|rst|adoc)$/i.test(w.file)).concat(c.unresolved);
  const editBetween = (a, b) => edits.some((w) => w.step > a && w.step <= b);
  // A round opens at an angle launched after code was written since the previous launch: the
  // agents of one batch go out together, a later launch with new code between reviews new code.
  const angleSteps = d.agents.filter((a) => REVIEW_AGENTS.has(a.type)).map((a) => a.step).sort((a, b) => a - b);
  const rounds = angleSteps.filter((s, i) => i === 0 || editBetween(angleSteps[i - 1], s));
  // §9's allowance: fix-diff's findings are fixed and built once. The first build after the
  // first edit that follows its answer is that build.
  // And the build that goes out WITH fix-diff — the §5 re-run §9 names as the one thing that runs
  // beside it — is the batch's own build, not one more pair.
  const allowed = new Set();
  for (const a of d.agents.filter((x) => x.type === "fix-diff")) {
    const beside = d.shell.find((s) => s.build && s.step > a.step && !editBetween(a.step, s.step));
    if (beside && (a.answeredAt === undefined || beside.step <= a.answeredAt)) allowed.add(beside.step);
    if (a.answeredAt === undefined) continue;
    const fixAt = firstOf(edits.filter((w) => w.step > a.answeredAt).map((w) => w.step), 0);
    const build = fixAt ? d.shell.find((s) => s.build && s.step >= fixAt) : undefined;
    if (build) allowed.add(build.step);
  }
  // The fix phase of a round also ends where the round's work is closed: a commit, or the full
  // suite (§6 runs it after the last fix). What is written after that is the next stage, built
  // the way development builds — 19:00 commit, then stage 3's own compile loop, read as fixes.
  const closers = d.shell.filter((s) => flag(s, "commit", /\bgit\s+commit\b/) || (flag(s, "test", TEST_RUN_RE) && !s.targeted)).map((s) => s.step);
  let worst = 0;
  // How the previous build ended. A digest from before the result fields existed has no `failed`
  // at all and reads green, as the gate always did; a call whose result never arrived (an
  // interrupted run) is unknown and grants neither a pair nor a repair.
  const ended = (s) => (s.failed ? "red" : "failed" in s && s.resultAt === undefined ? "unknown" : "green");
  rounds.forEach((start, i) => {
    const next = i + 1 < rounds.length ? rounds[i + 1] : Infinity;
    const end = Math.min(next, firstOf(closers.filter((s) => s > start), Infinity));
    let prev = start;
    let prevEnded = "green";
    let pairs = 0;
    let repairs = 0;
    for (const s of d.shell) {
      if (s.step <= start || s.step > end || !s.build) continue;
      if (editBetween(prev, s.step) && !allowed.has(s.step)) {
        // A red batch gets two repairs free — its compile errors, then its lints. Past that, a
        // fix → red → fix → red loop is the same one-at-a-time habit with the errors as the list.
        if (prevEnded === "green") pairs += 1;
        else if (prevEnded === "red" && ++repairs > 2) pairs += 1;
      }
      prev = s.step;
      prevEnded = ended(s);
      if (prevEnded === "green") repairs = 0; // the next red batch gets its own two repairs
    }
    worst = Math.max(worst, pairs);
  });
  if (worst >= 3) {
    c.lines.push("WARN  s6 - fixes landed one at a time: " + worst + " builds each after one more fix in one review round (a green build, or a red one past its second repair); §6 lands the confirmed batch in one pass, then builds once");
  }
}

// §6: the build goes in the response AFTER the edits reported success. A build launched before an
// edit's result came back — beside it in one response, or chained `fix.py; cargo clippy` — compiles
// whatever part of the batch landed when the edit failed: a patch script stopped at its third
// AssertionError, a heredoc the shell could not parse, an Edit whose old string was stale. Three
// such clippy runs in five minutes on one task (03.10), each red on a half-written tree, each a turn.
// "Failed" is read from the result: an Edit refused by the tool, a script's Traceback, the shell's
// parse error. In one command, only a build that visibly ran counts (`fix.py && cargo …` stops).
function gateBlindBuild(c) {
  const d = c.d;
  // A shell command counts as a failed edit only when it was writing the project: a scratch
  // script that crashed on its own data leaves the tree as it was.
  const touches = c.projectWrites.concat(c.unresolved);
  const misses = c.failedProjectWrites.concat(d.shell.filter((s) => s.editFailed && touches.some((w) => w.step === s.step)));
  if (!misses.length) return;
  // Blind: the edit was launched first and the build before the edit's result was read. Calls of
  // one response that write run one after another, so the build ran on the tree the failed edit
  // left. A build listed BEFORE the edit ran first, on the tree as it was — the edit's failure
  // changed nothing it compiled. In one command, only a build that visibly ran.
  const concurrent = (m, b) => {
    if (m.step === b.step) return Boolean(b.buildRan);
    return m.step < b.step && m.resultAt !== undefined && b.step <= m.resultAt;
  };
  let blind = 0;
  for (const b of d.shell) {
    if (b.build && misses.some((m) => concurrent(m, b))) blind += 1;
  }
  if (blind) {
    c.lines.push("WARN  s6 - " + blind + " build(s) launched before the edit beside them reported back, and that edit failed: the build compiled a half-applied batch; build in the next response, after every edit landed (apply-batch.js writes all or nothing)");
  }
}

// §6 (R4): past 5 findings in the batch, verify-finding is not optional. The count comes from
// the agents' own answers (ledger.angleFindingCount), never from the receipt — a receipt wrote
// "12 findings … verify-finding skipped, 10 are doc findings" and this is the line that makes
// such a skip visible. Deliberately not excusable by a SKIPPED: marker: the rule has no exemption
// for a batch of lows or of documentation findings — the filter exists to sort exactly those.
function gateVerifyFinding(c) {
  const n = c.d.reviewFindings;
  if (typeof n !== "number") return; // an older digest, or the ledger could not read the answers
  const ran = c.d.agents.some((a) => a.type === "verify-finding");
  if (n > 5 && !ran) {
    c.lines.push("WARN  s6 - the review batch returned " + n + " findings and verify-finding never ran: past 5 it is not optional (R4), a batch of lows or doc findings included");
  }
}

function gateClassBounds(c) {
  if (c.isTrivial && c.codeTouched && c.angles.length === 0 && c.projectWrites.length > 3) {
    c.lines.push("WARN  s0 - trivial declared over a multi-file code change; verify the class");
  }
}

// Time lost to waiting by hand, reported beside the gates: 41% of one measured session went here.
// Thresholds match §7's wording — one wait over 30 s is already the smell, and so is a sleep
// inside a loop, whose real cost the text always understates.
function gateSleep(c) {
  const d = c.d;
  const sleepSecs = d.sleepSeconds || 0;
  const sleepCalls = d.sleepCalls || 0;
  // Minutes only past 120 s: printing "2 min" for 90 s would contradict the seconds just summed.
  const sleepAmount = sleepSecs >= 300 ? Math.round(sleepSecs / 60) + " min" : Math.round(sleepSecs) + " s";
  // A wait §7 legitimises (a handshake that must finish) is declared in the receipt like any other
  // gate; without this it would resurface next turn as a skipped gate.
  const sleepExcused = skipDeclared(c.said, "sleep|wait|s7|runtime");
  if ((sleepSecs >= 120 || d.sleepLoop) && !sleepExcused) {
    c.lines.push(
      "WARN  s7 - " + sleepAmount + " of sleep across " + sleepCalls + " command(s)" +
        (d.sleepLoop ? " INCLUDING A LOOP (real cost is higher than the text says)" : "") +
        ": background work announces itself, do not poll it"
    );
  } else if (sleepSecs >= 30 && !sleepExcused) {
    // Say what was actually measured: the total, and over how many waits. Calling a spread of
    // three commands "a single wait" was a lie the wording used to tell.
    c.lines.push("WARN  s7 - " + sleepAmount + (sleepCalls === 1 ? " in one wait" : " across " + sleepCalls + " waits") + ": §7 puts the smell at ~15 s");
  } else if (sleepSecs) {
    c.lines.push("note  " + Math.round(sleepSecs) + " s of sleep in " + sleepCalls + " command(s)");
  }
}

// §0 bounds small at 1-3 files and says to escalate past that - the one escalation trigger a
// script can actually verify. In FILES, not edits: four Edits to one file is the normal shape of
// a small change and must not trip the cap.
function gateSmall(c) {
  // The cheap lane, and ONLY when declared as the class itself. An unanchored search would let
  // "небольшой диф" anywhere in a feature line drop the /code-review gate - the class line is
  // prose, so the word appears constantly. Read the class name right after the colon/arrow.
  // Split on a colon or em dash only — never a plain hyphen, which lives inside `half-fix`,
  // `code-review` and `fix-diff` and used to cut the class name out of a hyphen-less declaration.
  const sep = c.cls.search(/[:—]/);
  const declaredName = (sep === -1 ? c.cls : c.cls.slice(sep + 1)).replace(/\*+/g, "").trim().slice(0, 40);
  // No \w or \b around the Cyrillic alternatives: both are ASCII-only in JS, so "мелкая" would
  // never match. Anchored at the start of the declared name, which is what keeps it honest.
  const isSmall = /^\s*(?:small\b|мелк|небольш)/i.test(declaredName);
  const files = distinctFiles(c.projectWrites);
  if (isSmall && files > 3) {
    c.lines.push("WARN  s0 - small declared over " + files + " distinct files; §0 caps it at 3 and requires escalation");
  }
}

function check(d, cwd) {
  const c = contextOf(d, cwd);
  headline(c);
  gateClassAndReview(c);
  gateBuild(c);
  gateParallel(c);
  gateLeak(c);
  gateRelease(c);
  gateReviewFixAndUnresolved(c);
  gateReceipt(c);
  gateDelta(c);
  gateTestRuns(c);
  gateFixBatch(c);
  gateBlindBuild(c);
  gateVerifyFinding(c);
  gateClassBounds(c);
  gateSleep(c);
  gateSmall(c);

  const warnings = c.lines.filter((l) => l.startsWith("WARN"));
  const summary =
    "class " +
    // A task that wrote nothing in the project owes no class line: a question, a search, a plan.
    (c.cls ? "yes" : c.projectWrites.length ? "no" : "n/a") +
    " · angles " + c.angles.length +
    " · build " + (c.built ? "yes" : "no") +
    " · receipt " + (c.receipt ? "yes" : "no") +
    " · s9 " +
    // The same condition as the WARN above: below 3 files the delta is read by the orchestrator,
    // and the summary must not call that MISSING while the gate says it is fine.
    (c.deltaSteps.length ? "yes" : c.filesAfter >= 3 ? "MISSING" : c.writesAfter.length ? "self-read" : "n/a");
  return { lines: c.lines.concat(c.info), warnings, summary };
}

module.exports = { check, skipDeclared };
