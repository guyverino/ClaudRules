// The gates: sleep thresholds, the §5 leak gate and the §1 parallel-work gate, judged on
// synthetic digests and on hook attachments the way the real window carries them.

const { t, pipeline, rec } = require("./_harness");
const { buildDigest } = pipeline("lib/digest.js");
const { check } = pipeline("lib/checks.js");
const { sessionPreamble } = pipeline("lib/transcript.js");

// --- check(): the sleep thresholds actually branch as §7 states ------------------------------
{
  const digest = (over) =>
    Object.assign(
      { prompt: "", classLine: "Class: feature → 3 agents", hasReceipt: true, agents: [], shell: [], skills: [],
        slashCommands: [], writes: [], assistantText: "", meta: { cwd: "", windowComplete: true } },
      over
    );
  const linesOf = (over) => check(digest(over), "").lines.join("\n");
  // Minutes only past 300 s: printing "3 min" for 200 s overstated by a fifth.
  t(/WARN {2}s7 - 200 s of sleep/.test(linesOf({ sleepSeconds: 200, sleepCalls: 2 })), "check: 120s+ warns in seconds", "warn");
  t(/WARN {2}s7 - 6 min of sleep/.test(linesOf({ sleepSeconds: 360, sleepCalls: 2 })), "check: 300s+ warns in minutes", "warn");
  t(/WARN {2}s7 - 45 s in one wait/.test(linesOf({ sleepSeconds: 45, sleepCalls: 1 })), "check: 30s single warns", "warn");
  // A spread must not be described as one wait — that wording was a lie the report used to tell.
  t(/WARN {2}s7 - 45 s across 3 waits/.test(linesOf({ sleepSeconds: 45, sleepCalls: 3 })), "check: spread named as spread", "warn");
  // 90 s must not round up into "2 min" while the seconds say otherwise.
  t(/90 s/.test(linesOf({ sleepSeconds: 90, sleepCalls: 2 })), "check: 90s stays in seconds", "s");
  // A declared, unavoidable wait is excused like any other gate.
  t(!/s7/.test(linesOf({ sleepSeconds: 300, sleepCalls: 1, assistantText: "7 runtime: wait SKIPPED: core handshake needs 300 s" })), "check: declared wait excused", "excused");
  t(/note {2}10 s of sleep/.test(linesOf({ sleepSeconds: 10, sleepCalls: 1 })), "check: under 30s is a note", "note");
  t(/INCLUDING A LOOP/.test(linesOf({ sleepSeconds: 5, sleepCalls: 1, sleepLoop: true })), "check: loop warns regardless of total", "warn");
  t(!/s7/.test(linesOf({})), "check: silent when no sleep", "silent");

  // The post-review tail: measured at 68 of 78 minutes on one task, made of three habits.
  const ag = (type, step) => ({ type, step, description: "", promptHead: "" });
  const sh = (command, step) => ({ step, command, build: /cargo/.test(command) });
  const tail = (over) => linesOf(Object.assign({ writes: [{ step: 1, tool: "Edit", file: "crates/a/src/x.rs" }] }, over));
  // §9 runs once: the second run is the loop starting.
  t(/WARN {2}s9 - fix-diff ran 2 times/.test(tail({ agents: [ag("flow", 2), ag("fix-diff", 5), ag("fix-diff", 8)] })), "tail: second fix-diff warns", "warn");
  t(!/fix-diff ran/.test(tail({ agents: [ag("flow", 2), ag("fix-diff", 5)] })), "tail: one run is the shape", "silent");
  // §9 is conditional on the post-review delta spanning 3+ project files.
  const after = (files) => ({ agents: [ag("flow", 2)], writes: files.map((f, i) => ({ step: 3 + i, tool: "Edit", file: f })) });
  t(!/fix-diff never ran/.test(tail(after(["crates/a/x.rs", "crates/a/y.rs"]))), "tail: two files after review need no delta", "silent");
  // R5: only files of code count — a fix with its test and its doc is one, not three.
  t(!/fix-diff never ran/.test(tail(after(["crates/a/x.rs", "crates/a/tests.rs", "docs/x.md"]))), "tail: fix + its test + a doc is one code file", "silent");
  // The count itself, not only the threshold: a mis-classified test file would hide behind "< 3".
  {
    const { TEST_OR_DOC_RE, CODE_FILE_RE } = pipeline("lib/stacks.js");
    const isCode = (f) => CODE_FILE_RE.test(f) && !TEST_OR_DOC_RE.test(f);
    const code = ["crates/a/src/x.rs", "src/spec/parser.rs", "crates/docs-tool/src/main.rs", "lib/checks.js", "src/lib.rs"];
    const notCode = ["crates/a/src/foo/tests.rs", "crates\\a\\src\\tests.rs", "crates\\a\\tests\\it.rs", "docs\\x.md", "src/a.test.ts", "pkg/a_test.go", "tests/checks.test.js", "spec/models/user_spec.rb", "README.md", "src/__tests__/b.ts"];
    t(code.every(isCode), "s9 count: real modules are code (spec/ and docs- inside a path included)", code.filter((f) => !isCode(f)));
    t(!notCode.some(isCode), "s9 count: tests by folder, name and Rust sibling, docs — with either separator", notCode.filter(isCode));
  }
  t(!/fix-diff never ran/.test(tail(after(["src/a.ts", "src/a.test.ts", "src/__tests__/b.ts", "README.md"]))), "tail: test conventions of other stacks are not code either", "silent");
  t(/span 3 code files/.test(tail(after(["crates/a/x.rs", "crates/a/y.rs", "crates/b/z.rs", "docs/x.md"]))), "tail: three code files plus a doc still fires", "warn");
  t(/WARN {2}s9 - edits after the review span 3 code files, fix-diff never ran/.test(tail(after(["crates/a/x.rs", "crates/a/y.rs", "crates/b/z.rs"]))), "tail: three files after review demand a delta", "warn");
  t(!/fix-diff never ran/.test(tail(Object.assign(after(["crates/a/x.rs", "crates/a/y.rs", "crates/b/z.rs"]), { agents: [ag("flow", 2), ag("fix-diff", 9)] }))), "tail: delta ran on a wide change", "silent");
  // /code-review is not demanded any more — its absence is silent on every class.
  // /code-review left every lane: the observable is the summary line, which no longer carries it,
  // and a feature task without it collects no WARN at all.
  {
    const res = check(digest({ agents: [ag("flow", 2)], writes: [{ step: 1, tool: "Edit", file: "crates/a/src/x.rs" }], shell: [sh("cargo build", 3)] }), "");
    t(!/code-review/.test(res.summary), "tail: summary no longer names code-review", res.summary.slice(0, 60));
    t(!res.lines.some((l) => /WARN.*code-review/.test(l)), "tail: feature without code-review is clean", res.lines.filter((l) => /code-review/.test(l)));
  }
  // §5's formatter: a Rust edit with no cargo fmt anywhere in the task warns; one run silences it;
  // a non-Rust edit never asks for it. PR #505 went red on CI twice for exactly this.
  const rs = { writes: [{ step: 1, tool: "Edit", file: "crates/a/src/x.rs" }], agents: [ag("flow", 2)] };
  t(/WARN {2}s5 - Rust files were edited and cargo fmt never ran/.test(tail(Object.assign({}, rs, { shell: [sh("cargo build", 3)] }))), "fmt: rust edit without fmt warns", "warn");
  t(!/cargo fmt never ran/.test(tail(Object.assign({}, rs, { shell: [{ step: 3, command: "cargo fmt --all; cargo build", build: true, fmt: true }] }))), "fmt: one run silences", "silent");
  t(!/cargo fmt never ran/.test(tail(Object.assign({}, rs, { shell: [{ step: 3, command: "cargo fmt --all", build: false }] }))), "fmt: old digest falls back to the command text", "silent");
  t(!/cargo fmt never ran/.test(tail({ writes: [{ step: 1, tool: "Edit", file: "locales/crowd.yml" }], agents: [ag("flow", 2)], shell: [sh("cargo build", 3)] })), "fmt: non-Rust edit does not ask", "silent");
  const fmtDigest = buildDigest([{ type: "assistant", message: { content: [{ type: "tool_use", id: "f1", name: "Bash", input: { command: "cat > docs/x.md <<'EOF'\nrun cargo fmt\nEOF" } }] } }]);
  t(fmtDigest.shell[0].fmt === false, "fmt: a doc mentioning cargo fmt is not a run", fmtDigest.shell[0].fmt);
  // The file count behind §9's condition is PROJECT files: with a real cwd, a scratchpad write and
  // an out-of-repo absolute path after the review must not count toward the three.
  {
    const cwd = "D:/projects/repo"; // inProject normalises separators, so forward slashes exercise the same path
    const afterIn = (files) => check(digest({ agents: [ag("flow", 2)], writes: files.map((f, i) => ({ step: 3 + i, tool: "Edit", file: f })) }), cwd).lines.join("\n");
    t(!/fix-diff never ran/.test(afterIn(["D:/projects/repo/crates/a/x.rs", "D:/projects/repo/crates/a/y.rs", "D:/projects/repo/tmp/fix.py"])), "tail: in-repo scratch write does not count toward 3", "silent");
    t(!/fix-diff never ran/.test(afterIn(["D:/projects/repo/crates/a/x.rs", "D:/projects/repo/crates/a/y.rs", "C:/Users/u/.claude/CLAUDE.md"])), "tail: out-of-repo write does not count toward 3", "silent");
    t(/span 3 code files, fix-diff never ran/.test(afterIn(["D:/projects/repo/crates/a/x.rs", "D:/projects/repo/crates/a/y.rs", "crates/b/z.rs"])), "tail: relative path counts as the project", "warn");
    // The summary must agree with the gate: two files after the review are self-read, not MISSING.
    const two = check(digest({ agents: [ag("flow", 2)], writes: [{ step: 3, tool: "Edit", file: "crates/a/x.rs" }, { step: 4, tool: "Edit", file: "crates/a/y.rs" }] }), cwd).summary;
    t(/s9 self-read/.test(two), "tail: summary says self-read below 3 files", two.slice(two.indexOf("s9")));
    const three = check(digest({ agents: [ag("flow", 2)], writes: ["crates/a/x.rs", "crates/a/y.rs", "crates/b/z.rs"].map((f, i) => ({ step: 3 + i, tool: "Edit", file: f })) }), cwd).summary;
    t(/s9 MISSING/.test(three), "tail: summary says MISSING at 3 files", three.slice(three.indexOf("s9")));
  }
  t(/WARN {2}s8 - \/simplify ran after/.test(tail({ agents: [ag("flow", 2), ag("fix-diff", 5)], skills: [{ step: 9, skill: "simplify", args: "" }] })), "tail: simplify after delta warns", "warn");
  t(!/s8 - \/simplify/.test(tail({ agents: [ag("flow", 2), ag("fix-diff", 9)], skills: [{ step: 5, skill: "simplify", args: "" }] })), "tail: simplify before delta is the shape", "silent");
  t(/WARN {2}s6 - the full test suite ran 4 times/.test(tail({ shell: [sh("cargo test --workspace", 1), sh("cargo test -p a", 2), sh("cargo build", 3), sh("cargo test --workspace", 4), sh("cargo test -p b --test t", 5)] })), "tail: fourth test run warns", "warn");
  t(!/test suite ran/.test(tail({ shell: [sh("cargo test --workspace", 1), sh("cargo build", 2), sh("cargo build", 3), sh("cargo build", 4), sh("cargo test --workspace", 5)] })), "tail: builds between edits are free", "silent");
  // R8: one run at the end is the shape; a red run, its fix and the re-run is the tolerance.
  t(/WARN {2}s6 - the full test suite ran 3 times/.test(tail({ shell: [sh("cargo test --workspace", 1), sh("cargo build", 2), sh("cargo test --workspace", 3), sh("cargo build", 4), sh("cargo test --workspace", 5)] })), "tail: third full run warns (R8)", "warn");
  // Full vs targeted (HVol: 33 runs, 8 full — the WARN that lumped them fired on every task and
  // was explained away every time). A targeted run between edits is the build-equivalent.
  {
    const targeted = [sh("cargo test -p moon-chart --target x86_64-pc-windows-msvc hvol 2>&1 | tail", 1), sh("cargo test -p moon-core --lib profile", 3), sh("cargo test --workspace", 5), sh("cargo test -p a --test theme_contract every_backend", 7), sh("cargo test --workspace", 9)];
    const edits = [2, 4, 6, 8].map((step) => ({ step, tool: "Edit", file: "crates/a/src/x.rs" }));
    t(!/test suite ran/.test(tail({ shell: targeted, writes: edits })), "tail: targeted runs between edits are not suite runs", "silent");
    // The one waste in a targeted run: the same command again with no edit in between.
    const repeat = [sh("cargo test -p moon-chart hvol 2>&1 | tail -3", 1), sh("cargo test -p moon-chart hvol 2>&1 | tail -3", 2), sh("cargo test -p moon-chart hvol", 4)];
    t(/WARN {2}s6 - 1 test run\(s\) repeated the previous command with no edit in between/.test(tail({ shell: repeat, writes: [{ step: 3, tool: "Edit", file: "crates/a/src/x.rs" }] })), "tail: a re-run without an edit warns once", "warn");
    // A pull or a switch between two runs moved the tree: the post-merge run is not a repeat.
    const ws = "cargo test --workspace --target x86_64-pc-windows-msvc";
    t(!/repeated the previous/.test(tail({ shell: [sh(ws, 1), sh("git switch main", 2), sh("git pull --ff-only", 3), sh(ws, 4)] })), "tail: a run after a pull is not a repeat", "silent");
    // R8's publish shape: end-of-task run, the run after a rebase moved the tree, the post-merge
    // run after `main` moved — three runs, three trees, no WARN. A fetch moves nothing.
    const publish = [sh(ws, 1), sh("git rebase origin/main", 2), sh(ws, 3), sh("git pull --ff-only", 4), sh(ws, 5)];
    t(!/test suite ran/.test(tail({ shell: publish })), "tail: one run per tree is the shape", "silent");
    t(/test suite ran 3 times on one tree/.test(tail({ shell: [sh(ws, 1), sh("git fetch origin", 2), sh(ws, 3), sh("cargo build", 4), sh(ws, 5)] })), "tail: a fetch does not reset the count", "warn");
    t(/test suite ran 3 times on one tree/.test(tail({ shell: [sh(ws, 1), sh("git merge-base HEAD origin/main", 2), sh(ws, 3), sh("cargo build", 4), sh(ws, 5)] })), "tail: merge-base is not a move", "warn");
    // A write INSIDE the re-running command (`patch.py && cargo test`) makes it a fresh question.
    t(!/repeated the previous/.test(tail({ shell: repeat.slice(0, 2), writes: [{ step: 2, tool: "script", file: "crates/a/src/x.rs" }] })), "tail: an edit in the same command is not a repeat", "silent");
    t(!/repeated the previous/.test(tail({ shell: repeat.slice(0, 2), writes: [{ step: 2, tool: "shell", file: "", unknown: true }] })), "tail: an unresolved write still counts as an edit", "silent");
    // The cargo clause past the 300-character stored copy: `python - <<'PYEOF' … && cargo test -p
    // moon-chart hvol` read as a FULL run on the first digest this was tried on. Decided at digest
    // time on the full text, stored, and read from there.
    const longPatch = "python - <<'PYEOF'\n" + "s = s.replace('a', 'b')\n".repeat(20) + "PYEOF\ncargo test -p moon-chart --target x86_64-pc-windows-msvc hvol 2>&1 | tail -3";
    const dg = buildDigest([{ type: "assistant", message: { content: [{ type: "tool_use", id: "s3", name: "Bash", input: { command: longPatch } }] } }]);
    t(dg.shell[0].test === true && dg.shell[0].targeted === true && dg.shell[0].testKey === "cargo test -p moon-chart --target x86_64-pc-windows-msvc hvol", "tail: targeted-ness decided on the full command, stored", [dg.shell[0].targeted, dg.shell[0].testKey]);
    const four = [1, 2, 3, 4].map((i) => ({ step: i, command: dg.shell[0].command, build: true, test: true, targeted: true, testKey: "k" + i }));
    t(!/full test suite ran/.test(tail({ shell: four })), "tail: check() reads the stored targeted flag", "silent");
    // §9: the suite waits for fix-diff. "fix-diff and the full run work in the background", then
    // fix-diff found something and the full run went again — two runs, inside the tolerance, so
    // the bound above never saw it. fix-diff launched at 5, its answer read at 7.
    const fx = (step, file) => ({ step, tool: "Edit", file: file || "crates/a/src/y.rs" });
    const fd = (step, answeredAt) => Object.assign(ag("fix-diff", step), { answeredAt });
    const beside = { agents: [ag("flow", 2), fd(5, 7)], writes: [fx(1), fx(4), fx(8)] };
    const wsSh = (step) => sh(ws, step);
    const S9 = /WARN {2}s9 - the full suite ran before fix-diff answered/;
    const with_ = (over) => tail(Object.assign({}, beside, over));
    t(S9.test(with_({ shell: [wsSh(6), wsSh(10)] })), "tail: suite beside fix-diff, then again after its fix, warns", "warn");
    // Same turn, shell call first: still launched before the answer.
    t(S9.test(with_({ shell: [wsSh(4.5), wsSh(10)] })), "tail: suite launched just before fix-diff warns too", "warn");
    t(!S9.test(with_({ shell: [sh("cargo clippy --workspace", 6), wsSh(10)] })), "tail: the linter beside fix-diff is the shape", "silent");
    t(!S9.test(with_({ shell: [sh("cargo test --workspace --no-run", 6), wsSh(10)] })), "tail: compiling the tests beside fix-diff is a build", "silent");
    t(!S9.test(with_({ writes: [fx(1), fx(4)], shell: [wsSh(6)] })), "tail: fix-diff found nothing — the beside run is the only one", "silent");
    t(!S9.test(with_({ shell: [wsSh(3), wsSh(10)] })), "tail: a run on an older tree, before the last batch edit, is not this pattern", "silent");
    t(!S9.test(with_({ shell: [wsSh(10)] })), "tail: suite after fix-diff's fix is the shape", "silent");
    t(!S9.test(with_({ shell: [wsSh(6), sh("git pull --ff-only", 9), wsSh(10)] })), "tail: a pull between the two runs moved the tree", "silent");
    // The tolerated shape: "0 high", the suite after the answer goes red, its fix, the re-run.
    t(!S9.test(with_({ shell: [wsSh(7.5), wsSh(10)] })), "tail: a red run after the answer, its fix and the re-run is §6's tolerance", "silent");
    // A memory note or a doc after the answer is not "its fix".
    t(!S9.test(with_({ writes: [fx(1), fx(4), fx(8, "docs/x.md")], shell: [wsSh(6), wsSh(10)] })), "tail: a doc edit after the answer is not a fix", "silent");
    // A web asset the suite embeds is a fix; a log redirect the digest could not resolve is not.
    t(S9.test(with_({ writes: [fx(1), fx(4), fx(8, "crates/a/assets/app.html")], shell: [wsSh(6), wsSh(10)] })), "tail: a non-code asset fix still counts", "warn");
    t(!S9.test(with_({ writes: [fx(1), fx(4), { step: 8, tool: "shell", file: "", unknown: true }], shell: [wsSh(6), wsSh(10)] })), "tail: an unresolved write is not a fix", "silent");
    // No recorded answer: the launch step alone cannot tell the shapes apart.
    t(!S9.test(with_({ agents: [ag("flow", 2), ag("fix-diff", 5)], shell: [wsSh(6), wsSh(10)] })), "tail: no recorded answer stays silent", "silent");
    // A second fix-diff (already its own WARN) is judged too, not only the first.
    t(S9.test(with_({ agents: [ag("flow", 2), fd(5, 7), fd(12, 14)], writes: [fx(1), fx(4), fx(15)], shell: [wsSh(13), wsSh(16)] })), "tail: every fix-diff run is judged", "warn");
    {
      const { testTargeted } = pipeline("lib/stacks.js");
      t(testTargeted("cargo test --workspace --no-run --target x86_64-pc-windows-msvc") && !testTargeted("cargo test --workspace -- --no-run"), "stacks: --no-run is a build, past `--` it is the binary's", "build");
    }
    // The digest: answeredAt is the step count when the first DELIVERED carrier arrived.
    {
      const call = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
      const result = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } });
      const lines = (...ls) => ls.join(String.fromCharCode(10));
      const launch = [call("A1", "Agent", { subagent_type: "fix-diff", prompt: "p", run_in_background: true }), result("A1", lines("Async agent launched successfully.", "agentId: abc123 (internal ID)"))];
      const suite = call("B1", "Bash", { command: ws });
      const handback = { type: "user", message: { role: "user", content: lines("Another Claude session sent a message:", '<agent-message from="abc123">', "[Subagent hand-back] The report follows:", "  x.rs:1 — claim — high", "</agent-message>") } };
      const notif = { type: "attachment", attachment: { type: "queued_command", prompt: lines("<task-notification>", "<task-id>abc123</task-id>", "<tool-use-id>A1</tool-use-id>", "<status>completed</status>") } };
      const enqueue = { type: "queue-operation", operation: "enqueue", content: "<task-notification><tool-use-id>A1</tool-use-id></task-notification>" };
      const later = call("B2", "Bash", { command: "cargo build" });
      const at = (recs) => buildDigest(recs).agents[0].answeredAt;
      t(at(launch.concat([suite, handback, later])) === 2, "digest: a hand-back marks the answer", at(launch.concat([suite, handback, later])));
      t(at(launch.concat([suite, notif, later])) === 2, "digest: a queued notification marks the answer", at(launch.concat([suite, notif, later])));
      t(at(launch.concat([enqueue, suite, later, notif])) === 3, "digest: an enqueue is not delivery", at(launch.concat([enqueue, suite, later, notif])));
      t(at(launch.concat([suite])) === undefined, "digest: the launch stub is not an answer", at(launch.concat([suite])));
      const killed = { type: "attachment", attachment: { type: "queued_command", prompt: lines("<task-notification>", "<tool-use-id>A1</tool-use-id>", "<status>killed</status>") } };
      t(at(launch.concat([suite, killed, later])) === undefined, "digest: a killed run never answered", at(launch.concat([suite, killed, later])));
      const sync = [call("A1", "Agent", { subagent_type: "fix-diff", prompt: "p" }), result("A1", "x.rs:1 — claim — high"), suite];
      t(at(sync) === 1, "digest: a synchronous result is the answer", at(sync));
    }
  }
  // §6: the confirmed fixes land as ONE batch. Seven `cargo check`, each after one fix, on one
  // review round — bounded after the first angle only; before the review edit→check is development.
  {
    const angle = [ag("flow", 10)];
    const pingPong = (from) => [0, 1, 2, 3].flatMap((i) => [{ step: from + 2 * i, tool: "Edit", file: "crates/a/src/x.rs" }]);
    const checks = (from) => [0, 1, 2, 3].map((i) => sh("cargo check -p a", from + 2 * i + 1));
    t(/WARN {2}s6 - fixes landed one at a time: 4 build\/check runs/.test(tail({ agents: angle, writes: pingPong(11), shell: checks(11) })), "batch: four edit→check pairs after the review warn", "warn");
    t(!/fixes landed one at a time/.test(tail({ agents: angle, writes: pingPong(1), shell: checks(1) })), "batch: the same shape before the review is development", "silent");
    t(!/fixes landed one at a time/.test(tail({ agents: angle, writes: pingPong(11), shell: [sh("cargo check -p a", 19), sh("cargo test --workspace", 20)] })), "batch: one build after the batch is the shape", "silent");
  }
  // §6 (R4): past 5 findings verify-finding is not optional, and the receipt cannot excuse it.
  {
    const angle = [ag("flow", 2), ag("half-fix", 3)];
    t(/WARN {2}s6 - the review batch returned 12 findings and verify-finding never ran/.test(tail({ agents: angle, reviewFindings: 12, assistantText: "findings: 12 · verify-finding SKIPPED: ten are doc lines" })), "verify: 12 findings without the filter warn despite the receipt", "warn");
    t(!/verify-finding never ran/.test(tail({ agents: angle.concat([ag("verify-finding", 4)]), reviewFindings: 12 })), "verify: the filter ran", "silent");
    t(!/verify-finding never ran/.test(tail({ agents: angle, reviewFindings: 5 })), "verify: five findings are opened by hand", "silent");
    t(!/verify-finding never ran/.test(tail({ agents: angle })), "verify: an older digest without the count stays silent", "silent");
  }
  // review findings on the first version
  t(/s8 - \/simplify ran after/.test(tail({ agents: [ag("flow", 2), ag("fix-diff", 9)], skills: [{ step: 5, skill: "simplify", args: "" }, { step: 12, skill: "simplify", args: "" }] })), "tail: a second simplify after delta is not masked by the first", "warn");
  const longPrefix = "cd /x && " + "A".repeat(320) + " cargo test --workspace";
  const digested = buildDigest([{ type: "assistant", message: { content: [{ type: "tool_use", id: "s1", name: "Bash", input: { command: longPrefix } }] } }]);
  t(digested.shell[0].test === true && digested.shell[0].command.length === 300, "tail: test flag decided on the full command", [digested.shell[0].test, digested.shell[0].command.length]);
  t(/test suite ran 4 times/.test(tail({ shell: [1, 2, 3, 4].map((i) => ({ step: i, command: "cd …", build: true, test: true })) })), "tail: check() reads the stored test flag", "warn");
  const mention = buildDigest([{ type: "assistant", message: { content: [{ type: "tool_use", id: "s2", name: "Bash", input: { command: "cat > docs/x.md <<'EOF'\nrun `cargo test --workspace` before a PR\nEOF" } }] } }]);
  t(mention.shell[0].test === false, "tail: a doc that mentions cargo test is not a run", mention.shell[0].test);
}

// --- §5 leak gate: a hook attachment says LEAK REVIEW PENDING, cargo ran before mark --------
{
  const { hook, user, bash } = rec;
  const dig = (recs) => { const d = buildDigest(recs); d.meta = { cwd: "", windowComplete: true }; return d; };
  const lines = (recs) => check(dig(recs), "").lines.join("\n");
  const pendingBuild = [hook("Свежесть…\nLEAK REVIEW PENDING: 2 commit(s) by others …"), user("делай"), bash("b1", "cargo build -p x")];
  t(/WARN {2}s5 - LEAK REVIEW PENDING at session start, yet a build ran and the review was never marked/.test(lines(pendingBuild)), "leak gate: cargo without mark warns", "warn");
  // Any toolchain the stack table knows counts — the gate is about build scripts, not cargo.
  const npmBuild = [hook("LEAK REVIEW PENDING: 1 commit"), user("делай"), bash("b1", "npm ci")];
  t(/yet a build ran and the review was never marked/.test(lines(npmBuild)), "leak gate: npm ci without mark warns", "warn");
  const markedFirst = [hook("LEAK REVIEW PENDING: 1 commit"), user("делай"), bash("m1", 'node "C:/u/.claude/pipeline/leak-check.js" mark'), bash("b1", "cargo build -p x")];
  t(!/LEAK REVIEW PENDING at session start/.test(lines(markedFirst)), "leak gate: mark before cargo is clean", "silent");
  const markedLate = [hook("LEAK REVIEW PENDING: 1 commit"), user("делай"), bash("b1", "cargo test -p x"), bash("m1", "node leak-check.js mark")];
  t(/yet a build ran before leak-check.js mark/.test(lines(markedLate)), "leak gate: mark after cargo still warns", "warn");
  const noPending = [hook("MoonTerminal: свежий (origin/main)"), user("делай"), bash("b1", "cargo build")];
  t(!/LEAK REVIEW/.test(lines(noPending)), "leak gate: silent without the pending line", "silent");
  t(dig(pendingBuild).leakPending === true && !dig(noPending).leakPending, "leak gate: digest carries leakPending", [dig(pendingBuild).leakPending, dig(noPending).leakPending]);
  // Production slices the window from the prompt, and the hook record sits BEFORE it: the
  // preamble must carry it in — and only the current task's, not an earlier task's session start.
  const all = [hook("LEAK REVIEW PENDING: 1 commit"), user("делай"), bash("b1", "cargo build")];
  const start = 1;
  const pre = sessionPreamble(all, start);
  t(pre.length === 1 && pre[0].attachment.type === "hook_additional_context", "leak gate: preamble picks the hook before the prompt", pre.length);
  t(/LEAK REVIEW PENDING at session start/.test(check(Object.assign(buildDigest(pre.concat(all.slice(start))), { meta: { cwd: "", windowComplete: true } }), "").lines.join("\n")), "leak gate: fires through the real window slicing", "warn");
  const twoTasks = [hook("LEAK REVIEW PENDING: 1"), user("task one"), bash("b0", "cargo build"), user("task two"), bash("b1", "cargo build")];
  t(sessionPreamble(twoTasks, 3).length === 0, "leak gate: a later task does not inherit the hook (marked or not, it was task one's)", sessionPreamble(twoTasks, 3).length);
  const longMark = buildDigest([user("x"), bash("m", 'node "C:/u/.claude/pipeline/leak-check.js" diff --out "' + "y".repeat(320) + '.md" && node "C:/u/.claude/pipeline/leak-check.js" mark')]);
  t(longMark.shell[0].leakMark === true, "leak gate: mark past the 300-char cut is still seen", longMark.shell[0].leakMark);
}

// --- §1 parallel-work gate: a hook attachment says PARALLEL WORK, an edit came before `others` ---
{
  const { hook, user, bash } = rec;
  const { edit } = rec;
  const dig = (recs) => { const d = buildDigest(recs); d.meta = { cwd: "", windowComplete: true }; return d; };
  const lines = (recs) => check(dig(recs), "").lines.join("\n");
  const pw = hook("LEAK REVIEW PENDING: 1 commit\nPARALLEL WORK: 3 commit(s) by others on main since your last own commit (x · y) · open PRs: 1. Before the first edit …");
  t(/WARN {2}s1 - PARALLEL WORK at session start, yet a project file was edited and leak-check\.js others never ran/.test(lines([pw, user("делай"), edit("e1", "crates/a/src/x.rs")])), "parallel: edit without others warns", "warn");
  t(/edited before leak-check\.js others ran/.test(lines([pw, user("делай"), edit("e1", "crates/a/src/x.rs"), bash("o1", 'node "C:/u/.claude/pipeline/leak-check.js" others')])), "parallel: others after the edit still warns", "warn");
  t(!/PARALLEL WORK at session start/.test(lines([pw, user("делай"), bash("o1", 'node "C:/u/.claude/pipeline/leak-check.js" others'), edit("e1", "crates/a/src/x.rs")])), "parallel: others before the edit is clean", "silent");
  t(!/PARALLEL WORK at session start/.test(lines([pw, user("делай"), bash("o1", "gh pr list --state open"), edit("e1", "crates/a/src/x.rs")])), "parallel: listing the PRs on the forge counts", "silent");
  t(/PARALLEL WORK at session start/.test(lines([pw, user("делай"), bash("o1", "gh pr view 577 --json title"), edit("e1", "crates/a/src/x.rs")])), "parallel: viewing ONE PR is not the comparison", "warn");
  // The second trigger: a pull mid-task re-arms the gate for edits after it.
  const others = (id) => bash(id, 'node "C:/u/.claude/pipeline/leak-check.js" others');
  t(/WARN {2}s1 - commits were pulled mid-task \(step \d+\), yet a project file was edited afterwards/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git rebase origin/main"), edit("e2", "crates/a/src/y.rs")])), "parallel: edit after a mid-task rebase without a fresh check warns", "warn");
  t(!/pulled mid-task/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git pull --rebase"), others("o2"), edit("e2", "crates/a/src/y.rs")])), "parallel: a fresh check after the pull is clean", "silent");
  t(!/pulled mid-task/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git rebase origin/main"), bash("b1", "cargo build")])), "parallel: a pull with no edit after it is clean", "silent");
  t(!/pulled mid-task/.test(lines([hook("свежий"), user("делай"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git rebase origin/main"), edit("e2", "crates/a/src/y.rs")])), "parallel: a solo repo (neither hook line) never re-arms", "silent");
  // A repo with other contributors but nothing pending at start: the CONTRIBUTORS line alone re-arms on a pull.
  const contrib = hook("CONTRIBUTORS: this repo has commits by others (nothing new since your last own commit, no open PRs) — a mid-task pull re-arms rules §1.");
  t(/pulled mid-task/.test(lines([contrib, user("делай"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git pull"), edit("e2", "crates/a/src/y.rs")])), "parallel: CONTRIBUTORS line + pull + edit warns", "warn");
  t(!/PARALLEL WORK at session start/.test(lines([contrib, user("делай"), edit("e1", "crates/a/src/x.rs")])), "parallel: CONTRIBUTORS alone does not demand the first-edit check", "silent");
  // pull → edit → others → edit: the first post-pull edit came before any comparison.
  t(/edited afterwards before a fresh leak-check\.js others/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git rebase origin/main"), edit("e2", "crates/a/src/y.rs"), others("o2"), edit("e3", "crates/a/src/z.rs")])), "parallel: a check after the first post-pull edit is too late", "warn");
  t(!/pulled mid-task/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git rebase --abort"), edit("e2", "crates/a/src/y.rs")])), "parallel: --abort brings nothing in", "silent");
  t(/pulled mid-task/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "git fetch origin"), edit("e2", "crates/a/src/y.rs")])), "parallel: a fetch is a trigger too (the rule names it)", "warn");
  t(!/pulled mid-task/.test(lines([pw, user("делай"), others("o1"), edit("e1", "crates/a/src/x.rs"), bash("p1", "cat > docs/x.md <<'EOF'\nrun git rebase origin/main first\nEOF"), edit("e2", "crates/a/src/y.rs")])), "parallel: a doc that mentions git rebase is not a pull", "silent");
  t(!/PARALLEL WORK at session start/.test(lines([pw, user("делай"), bash("o1", "cargo build")])), "parallel: no project write -> nothing to warn about", "silent");
  t(!/PARALLEL WORK at session start/.test(lines([hook("MoonTerminal: свежий (origin/main)"), user("делай"), edit("e1", "crates/a/src/x.rs")])), "parallel: silent without the hook line (no other contributors)", "silent");
  t(!/PARALLEL WORK at session start/.test(lines([pw, user("делай"), edit("e1", "crates/a/src/x.rs"), { type: "assistant", message: { content: [{ type: "text", text: "1 ground truth: x · parallel: N/A: no other contributors" }] } }])), "parallel: a declared skip on the receipt excuses it", "silent");
  t(dig([pw]).parallelPending === true && !dig([hook("LEAK REVIEW PENDING: 1")]).parallelPending, "parallel: digest carries parallelPending", [dig([pw]).parallelPending]);
}

// A hook payload whose PATH fails JSON.parse (a backslash-U is no JSON escape) keeps its raw
// backslashes — the backslash-t inside it included; only the COMMAND carries JSON escapes. (A
// path whose only backslashes form valid escapes, backslash-t or -n, parses as JSON and is
// mangled by JSON.parse itself, before any fallback runs.)
{
  const { parseHook } = pipeline("lib/hook.js");
  const p = parseHook(String.raw`{"session_id":"s","cwd":"C:\Users\temp","transcript_path":"D:\Users\t.jsonl","tool_input":{"command":"echo \"a\";\nsleep 1"}}`);
  t(p.cwd === String.raw`C:\Users\temp` && p.transcript_path === String.raw`D:\Users\t.jsonl`, "hook: raw path backslashes survive the fallback", [p.cwd, p.transcript_path]);
  t(p.tool_input.command === 'echo "a";\nsleep 1', "hook: the command's JSON escapes are decoded", JSON.stringify(p.tool_input.command));
}

// --- §5 release-surface gate: the hook says RELEASE SURFACE CHANGED, the tree was built, pushed or
// published before `leak-check.js ack-release` ---
{
  const { hook, user, bash } = rec;
  const skill = (id, name) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill: name, args: "" } }] } });
  const dig = (recs) => { const d = buildDigest(recs); d.meta = { cwd: "", windowComplete: true }; return d; };
  const lines = (recs) => check(dig(recs), "").lines.join("\n");
  const rs = hook("PARALLEL WORK: 1 commit(s) by others on main since your last own commit (x) · open PRs: 0.\nRELEASE SURFACE CHANGED by Moonbot — 32235399 chore(release): publish only — .github/workflows/release.yml\n  ^ paths the project declares as its release surface");
  t(/WARN {2}s5 - RELEASE SURFACE CHANGED at session start, yet a build ran and the diffs were never acknowledged/.test(lines([rs, user("делай"), bash("b1", "cargo build -p x")])), "release gate: build without ack warns", "warn");
  t(/yet the tree was pushed or merged and the diffs were never acknowledged/.test(lines([rs, user("делай"), bash("p1", "git push -u origin feat/x")])), "release gate: push without ack warns", "warn");
  t(/yet the tree was pushed or merged/.test(lines([rs, user("делай"), bash("m1", "gh pr merge 590 --squash")])), "release gate: forge merge without ack warns", "warn");
  t(/yet \/publish ran and the diffs were never acknowledged/.test(lines([rs, user("делай"), skill("s1", "publish")])), "release gate: the publish skill without ack warns", "warn");
  t(/yet a build ran before leak-check.js ack-release/.test(lines([rs, user("делай"), bash("b1", "cargo build"), bash("a1", 'node "C:/u/.claude/pipeline/leak-check.js" ack-release')])), "release gate: ack after the build still warns", "warn");
  t(!/RELEASE SURFACE CHANGED at session start/.test(lines([rs, user("делай"), bash("a1", 'node "C:/u/.claude/pipeline/leak-check.js" ack-release'), bash("b1", "cargo build"), bash("p1", "git push")])), "release gate: ack before build and push is clean", "silent");
  t(!/RELEASE SURFACE CHANGED at session start/.test(lines([rs, user("делай"), bash("r1", "git show 32235399 -- .github/workflows/release.yml")])), "release gate: reading without shipping is not a finding", "silent");
  t(!/RELEASE SURFACE/.test(lines([hook("PARALLEL WORK: 1 commit(s) by others"), user("делай"), bash("b1", "cargo build")])), "release gate: silent without the hook line", "silent");
  t(!/RELEASE SURFACE CHANGED at session start/.test(lines([rs, user("делай"), bash("b1", "cargo build"), { type: "assistant", message: { content: [{ type: "text", text: "check: … · release surface: SKIPPED: bench build on a throwaway copy, diffs read next session" }] } }])), "release gate: a declared skip on the receipt excuses it", "silent");
  const slash = (text) => ({ type: "user", message: { content: [{ type: "text", text: "<command-name>/publish</command-name>" + text }] } });
  t(/yet \/publish ran and the diffs were never acknowledged/.test(lines([rs, user("делай"), slash("")])), "release gate: a user-typed /publish without any ack warns", "warn");
  t(!/RELEASE SURFACE CHANGED at session start/.test(lines([rs, user("делай"), bash("a1", 'node "C:/u/.claude/pipeline/leak-check.js" ack-release'), slash("")])), "release gate: a typed /publish with an ack somewhere is not judged (order unknown)", "silent");
  t(!/RELEASE SURFACE CHANGED at session start/.test(lines([rs, user("делай"), bash("h1", "cat > notes.md <<'EOF'" + String.fromCharCode(10) + "run git push later" + String.fromCharCode(10) + "EOF"), bash("c1", 'git commit -m "docs: explain git push"')])), "release gate: 'git push' inside a heredoc or a commit message is not a ship", "silent");
  t(dig([rs]).releasePending === true && !dig([hook("LEAK REVIEW PENDING: 1")]).releasePending, "release gate: digest carries releasePending", dig([rs]).releasePending);
  const longAck = buildDigest([user("x"), bash("a", 'cd "' + "y".repeat(320) + '" && node "C:/u/.claude/pipeline/leak-check.js" ack-release')]);
  t(longAck.shell[0].releaseAck === true, "release gate: ack past the 300-char cut is still seen", longAck.shell[0].releaseAck);
}
