// Reading the record: what counts as a class line, a declared skip, a task opening, a write
// (tool, shell redirect, script body), a sleep. Every case here fooled the digest once.

const { t, pipeline } = require("./_harness");
const { buildDigest, classDeclared, collectWrites } = pipeline("lib/digest.js");
const { check, skipDeclared } = pipeline("lib/checks.js");
const { isTaskOpening } = pipeline("lib/transcript.js");
const { lateRowsFor } = pipeline("lib/late.js");

// --- classDeclared: what counts as a declaration -------------------------------------------
[
  ["**Класс: small** → 1 угол (half-fix) · build", "small", "small declared"],
  ["Класс: **feature** → 3 угла (flow · half-fix)", "feature", "feature declared"],
  ["feature → 4 agents (flow · half-fix · error paths)", "feature", "bare arrow form"],
  ["rename / signature / contract → 2 (contracts · flow)", "rename", "compound class name"],
  ["Класс: мелкая правка → 1 угол", "мелк", "Cyrillic small"],
  ["- **feature / refactor** → all stages.", "", "quoted spec line rejected"],
  ["| feature / refactor | 3 (flow) |", "", "table row rejected"],
].forEach(([line, want, label]) => {
  const got = classDeclared(line);
  t(want ? got.toLowerCase().includes(want) : got === "", "class: " + label, JSON.stringify(got.slice(0, 26)));
});

// Escalation: the LAST declaration is the real one, and a quoted template must not become it.
{
  const escalated = ["Класс: small -> 1 угол", "some work", "Класс: feature -> 3 угла (escalated)"].join("\n");
  t(/feature/.test(classDeclared(escalated)), "class: escalation wins over the first line", "feature");
  const withTemplate = ["Класс: feature -> 3 угла", "Class + recipe: <what I stated at s0>"].join("\n");
  t(/feature/.test(classDeclared(withTemplate)), "class: quoted template does not overwrite", "feature");
}

// --- skipDeclared: a declared skip vs prose, template and a neighbouring gate ---------------
[
  ["  findings: <n | SKIPPED: reason> · /code-review <done | SKIPPED: reason>", "code-review", false, "§10 template"],
  ["  findings: 51 · /code-review SKIPPED: правки вне git-дерева", "code-review", true, "real skip"],
  ["/code-review done · build SKIPPED: pre-existing fail", "code-review", false, "neighbour's skip"],
  ["5 build+static: cargo build -p x --target x86_64-pc-windows-msvc -> SKIPPED: линкер", "build", true, "long build command"],
  ["5 build+static: n/a: doc only · 7 runtime N/A: no surface", "build", false, "lowercase marker"],
  ["я запустил code-review, он нашёл skipped-тесты", "code-review", false, "prose"],
  ["8 cleanup: /simplify N/A: вне дерева", "simplify", true, "N/A with a reason"],
].forEach(([line, key, exp, label]) => {
  const got = skipDeclared(line, key);
  t(got === exp, "skip: " + label, got);
});

// --- what opens a task: a prompt, not a background agent reporting back ---------------------
// A `<task-notification>` user turn split every task with backgrounded reviewers into fragments
// with no class line — seen as two phantom rows per task in the ledger.
{
  const user = (text) => ({ type: "user", message: { content: [{ type: "text", text }] } });
  t(isTaskOpening(user("делай")) === true, "opening: a prompt opens a task", true);
  t(isTaskOpening(user("<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>")) === false, "opening: task-notification continues the task", false);
  t(isTaskOpening(user("  <task-notification><task-id>x</task-id>")) === false, "opening: task-notification with leading space", false);
  t(isTaskOpening(user("[Request interrupted by user]")) === false, "opening: interruption is not a task", false);
}

// --- a reviewer that answers after the next prompt still belongs to its own task -----------
// Seen live: three angles fired, one or two in the ledger — the other answers landed in the next
// task's window and were dropped there.
{
  const user = (text) => ({ type: "user", message: { content: [{ type: "text", text }] } });
  const call = (id, type) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: type, description: "x" } }] } });
  const stub = (id) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched" }] } });
  const notify = (id, body) => ({ type: "user", message: { content: [{ type: "text", text: "<task-notification>\n<tool-use-id>" + id + "</tool-use-id>\n<status>completed</status>\n<result>" + body + "</result>\n<usage><subagent_tokens>100</subagent_tokens><tool_uses>1</tool_uses><duration_ms>5</duration_ms></usage>\n</task-notification>" }] } });
  const all = [
    user("task one"), call("a1", "flow"), stub("a1"), call("a2", "half-fix"), stub("a2"), notify("a2", "crates/x.rs:1 — early — low"),
    user("task two"), notify("a1", "crates/y.rs:2 — late — high"), call("b1", "tests"), stub("b1"), notify("b1", "0 findings"),
  ];
  const start = 6; // "task two"
  const rows = lateRowsFor(all, start, { session: "s", cwd: "" });
  t(rows.length === 1, "late: one earlier task re-recorded", rows.length);
  const flow = rows[0] && rows[0].agents.find((a) => a.type === "flow");
  t(flow && flow.findings === 1 && flow.tokens === 100, "late: the late flow answer is paired to task one", flow && [flow.findings, flow.tokens]);
  t(rows[0] && rows[0].agents.length === 2, "late: task one keeps both its agents", rows[0] && rows[0].agents.map((a) => a.type));
  t(rows[0] && /task one/.test(rows[0].prompt), "late: the row carries task one's prompt", rows[0] && rows[0].prompt);
  t(lateRowsFor(all, 0, { session: "s", cwd: "" }).length === 0, "late: nothing to re-record from the first task", 0);
  const ownOnly = [user("task two"), call("b1", "tests"), stub("b1"), notify("b1", "0 findings")];
  t(lateRowsFor(ownOnly, 0, { session: "s", cwd: "" }).length === 0, "late: an answer to this task's own call is not late", 0);
  // Hand-back shape: the late answer is an <agent-message> keyed by the agentId task one's stub
  // named, and the notification behind it is only a pointer.
  const stubId = (id, agentId) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "Async agent launched successfully.\nagentId: " + agentId + " (internal)" }] } });
  const handback = (agentId, body) => ({ type: "queue-operation", operation: "enqueue", content: '<agent-message from="' + agentId + '">\n[Subagent hand-back] The report follows:\n  ' + body + "\n</agent-message>" });
  const pointer = (id, agentId) => notify(id, "This agent's report was delivered to you as a message from \"" + agentId + "\" (its SubagentHandback call).");
  const hbAll = [user("task one"), call("a1", "flow"), stubId("a1", "h001"), user("task two"), call("b1", "tests"), stubId("b1", "h002"), handback("h002", "0 findings"), pointer("b1", "h002"), handback("h001", "crates/late.rs:5 — late hand-back — medium"), pointer("a1", "h001")];
  const hbRows = lateRowsFor(hbAll, 3, { session: "s", cwd: "" });
  const hbFlow = hbRows[0] && hbRows[0].agents.find((a) => a.type === "flow");
  t(hbRows.length === 1 && hbFlow && hbFlow.findings === 1 && !hbFlow.malformed, "late: a late hand-back re-records task one with its findings", hbRows.length + " rows · " + (hbFlow && [hbFlow.findings, hbFlow.malformed]));
  t(hbRows[0] && !hbRows[0].agents.some((a) => a.type === "tests"), "late: task two's own hand-back is not pinned to task one", hbRows[0] && hbRows[0].agents.map((a) => a.type));
}

// --- collectWrites: a write is a write, a read is not --------------------------------------
[
  ["grep -rn \"Set-Content\" crates/", 0, "grep is not a write"],
  ["cargo build --target x86_64-pc-windows-msvc", 0, "--target is not rg"],
  ["echo x > /dev/null", 0, "redirect to null device"],
  ["New-Item -ItemType Directory out; Set-Content -Path crates/x/y.rs 1", 1, "write after mkdir clause"],
  ["f=crates/a/b.rs; cat > \"$f\" <<EOF", 1, "heredoc into a variable"],
  ["sed -i s/a/b/ crates/moon-core/src/lib.rs", 1, "in-place edit"],
  ["Set-Content -Path crates/x/y.rs 1", 1, "PowerShell write"],
].forEach(([cmd, exp, label]) => {
  const out = [];
  collectWrites(cmd, 1, out);
  t(out.length === exp, "write: " + label, out.length + " recorded");
});

// --- an arrow function is not a redirect ----------------------------------------------------
// `.sort((a,b)=>b.ts-a.ts)` inside an inline node script used to read as a write into `b.ts-a.ts`,
// which reported a pure research task as "code was edited, no review angle fired".
[
  ['node -e "arr.sort((a,b)=>b.ts-a.ts)"', 0, "arrow with .ts is not a write"],
  ['node -e "xs.map(a=>a.py-1)"', 0, "arrow with .py is not a write"],
  ['node -e "if(a>=b.rs)x()"', 0, "comparison is not a write"],
  ["cat > crates/x/y.rs <<EOF", 1, "a real redirect still counts"],
  ["echo hi >> notes.md", 1, "append still counts"],
].forEach(([cmd, exp, label]) => {
  const out = [];
  collectWrites(cmd, 1, out);
  t(out.length === exp, "arrow: " + label, out.length + " recorded");
});

// --- a script that writes the tree is a write; the word "writes" is not ---------------------
// Both shipped: a task that rewrote tab.rs twice through `python fix.py` / `python - <<EOF`
// digested as `project 0`, and an analysis task whose `node -e` printed "writes:" digested as
// three project writes.
{
  const bash = (cmd) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "x" + Math.random(), name: "Bash", input: { command: cmd } }] },
  });
  const write = (file, content) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "w" + Math.random(), name: "Write", input: { file_path: file, content } }] },
  });
  const project = (d) => d.writes.filter((w) => w.file && !/scratchpad/.test(w.file)).map((w) => w.file);

  const py = "p = 'crates/moon-ui-gpui/src/settings/hotkeys/tab.rs'\ns = io.open(p).read()\nio.open(p, 'w', encoding='utf-8').write(s)\n";
  const ran = buildDigest([write("C:\\tmp\\scratchpad\\fix.py", py), bash('python "C:/tmp/scratchpad/fix.py"')]);
  t(project(ran).join() === "crates/moon-ui-gpui/src/settings/hotkeys/tab.rs", "script: authored script run under python", project(ran));
  const authoredOnly = buildDigest([write("C:\\tmp\\scratchpad\\fix.py", py)]);
  t(project(authoredOnly).length === 0, "script: authored but never run is not a write", project(authoredOnly));
  const readOnly = buildDigest([write("C:\\tmp\\scratchpad\\look.py", "p = 'crates/a/b.rs'\nprint(io.open(p).read())\n"), bash("python C:/tmp/scratchpad/look.py")]);
  t(project(readOnly).length === 0, "script: a script that only reads is not a write", project(readOnly));
  const heredoc = buildDigest([bash("python - <<'EOF'\nimport io\np='crates/moon-core/src/lib.rs'\nio.open(p,'w').write('x')\nEOF")]);
  t(project(heredoc).join() === "crates/moon-core/src/lib.rs", "script: heredoc into python", project(heredoc));
  const nodeHd = buildDigest([bash('node - <<EOF\nrequire("fs").writeFileSync("crates/x/y.ts", s)\nEOF')]);
  t(project(nodeHd).join() === "crates/x/y.ts", "script: heredoc into node", project(nodeHd));
  const catThenRun = buildDigest([bash("cat > fix.py <<'EOF'\nio.open('crates/a/b.rs','w').write(s)\nEOF"), bash("python fix.py")]);
  t(project(catThenRun).includes("crates/a/b.rs"), "script: cat-authored script run later", project(catThenRun));
  const inspect = buildDigest([bash("node -e 'const r=JSON.parse(s); console.log(\"writes:\", r.writes, \"files:\", r.files)'")]);
  t(inspect.writes.length === 0, "script: the word writes in an inspection script", inspect.writes.length);
  const stillWrite = buildDigest([bash("node -e 'require(\"fs\").writeFileSync(\"crates/a.rs\", s)'")]);
  t(stillWrite.writes.length === 1, "script: node -e writeFileSync still counts", stillWrite.writes.length);
  const openRead = buildDigest([bash("python -c 'print(open(\"crates/a.rs\").read())'")]);
  t(openRead.writes.length === 0, "script: python -c open() for reading is not a write", openRead.writes.length);
  // review findings on the first version of this detector
  const prefix = buildDigest([write("C:\\tmp\\scratchpad\\fix.py", py), bash("python C:/tmp/scratchpad/prefix.py")]);
  t(project(prefix).length === 0, "script: prefix.py is not fix.py", project(prefix));
  const tooling = buildDigest([
    write("C:\\Users\\u\\.claude\\pipeline\\gate-check.js", "// example: `python \"scratch/fix.py\"`\nfs.writeFileSync(out, s);\n"),
    bash("node C:/Users/u/.claude/pipeline/gate-check.js digest --hand"),
  ]);
  t(project(tooling).every((f) => /gate-check\.js$/.test(f)), "script: the pipeline's own tooling is not a fix script", project(tooling));
  const tildeTooling = buildDigest([
    bash("cat > ~/.claude/pipeline/x.js <<'EOF'\n// see \"crates/a/b.rs\"\nfs.writeFileSync(out, s);\nEOF"),
    bash("node ~/.claude/pipeline/x.js"),
  ]);
  t(!project(tildeTooling).includes("crates/a/b.rs"), "script: ~-rooted tooling via heredoc is not a fix script", project(tildeTooling));
  const bareStillCounts = buildDigest([bash("cat > fix.py <<'EOF'\nio.open('crates/a/b.rs','w').write(s)\nEOF"), bash("python fix.py")]);
  t(project(bareStillCounts).includes("crates/a/b.rs"), "script: bare cat-authored script still registers", project(bareStillCounts));
}

// --- a path inside a block string is data the script carries, not a file it touches -----------
{
  const { scriptTargets } = pipeline("lib/digest.js");
  const fixture = "p = r'C:\\x\\tests\\digest.test.js'\ns = io.open(p, encoding='utf-8').read()\nold = \"\"\"  t(check({ writes: [{ file: \"crates/a/src/x.rs\" }] }), 'x')\n\"\"\"\nnew = '''  const f = \"crates/b/src/y.rs\";\n'''\nio.open(p, 'w').write(s.replace(old, new))\n";
  const targets = scriptTargets(fixture);
  t(targets !== null && targets.some((f) => /digest\.test\.js$/.test(f)), "script: the file the patch writes is a target", targets);
  t(targets !== null && !targets.some((f) => /\.rs$/.test(f)), "script: paths inside triple-quoted blocks are not targets", targets);
  const tpl = "const body = `see \"crates/c/src/z.rs\" for details`;\nrequire('fs').writeFileSync('out/notes.md', body);\n";
  const tt = scriptTargets(tpl);
  t(tt !== null && tt.includes("out/notes.md") && !tt.some((f) => /\.rs$/.test(f)), "script: a JS template literal is a block string too", tt);
  // A block string longer than the scan cap must still be stripped whole: cut open, its fixture
  // paths would leak into the targets.
  const huge = "io.open('a/b.py','w').write(x)\nold = \"\"\"" + "x".repeat(25000) + " \"crates/z/src/w.rs\" \"\"\"\n";
  const th = scriptTargets(huge);
  t(th !== null && !th.some((f) => /\.rs$/.test(f)), "script: a block string past the 20000-char cap is stripped whole", th);
}

// --- sleep polling is counted, because it is the most expensive habit measured --------------
{
  const rec = (cmd) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "x" + Math.random(), name: "Bash", input: { command: cmd } }] },
  });
  const d = buildDigest([rec("sleep 240; tail -6 out.log"), rec("Start-Sleep -Seconds 30"), rec("ls")]);
  t(d.sleepCalls === 2, "sleep: both forms counted", d.sleepCalls);
  t(d.sleepSeconds === 270, "sleep: seconds summed", d.sleepSeconds);
  const quiet = buildDigest([rec("ls -la")]);
  t(!quiet.sleepSeconds, "sleep: none when absent", quiet.sleepSeconds);

  // Units: reading `sleep 5m` as 5 seconds would let the worst single wait slip under the threshold.
  t(buildDigest([rec("sleep 5m")]).sleepSeconds === 300, "sleep: minutes converted", buildDigest([rec("sleep 5m")]).sleepSeconds);
  t(buildDigest([rec("sleep 1h")]).sleepSeconds === 3600, "sleep: hours converted", buildDigest([rec("sleep 1h")]).sleepSeconds);
  t(buildDigest([rec("Start-Sleep -Milliseconds 500")]).sleepSeconds === 0.5, "sleep: ms converted", buildDigest([rec("Start-Sleep -Milliseconds 500")]).sleepSeconds);
  // A typo must not print "Infinity min" nor become null in the digest JSON.
  t(buildDigest([rec("sleep 99999999999")]).sleepSeconds === 86400, "sleep: absurd value capped", buildDigest([rec("sleep 99999999999")]).sleepSeconds);
  // A loop understates its own cost, so the loop itself is the signal.
  t(buildDigest([rec("for i in 1 2 3; do sleep 5; done")]).sleepLoop === true, "sleep: loop flagged", true);
  t(!buildDigest([rec("sleep 5")]).sleepLoop, "sleep: single wait is not a loop", false);
  // The loop must be shell STRUCTURE, not the English word: this shape used to trip the loop WARN.
  t(!buildDigest([rec('echo "waiting for the build"; sleep 30')]).sleepLoop, "sleep: English 'for' is not a loop", false);
  t(!buildDigest([rec('rg "while" src/; sleep 2')]).sleepLoop, "sleep: grepping 'while' is not a loop", false);
  t(buildDigest([rec("while ! test -f x; do sleep 3; done")]).sleepLoop === true, "sleep: while-do is a loop", true);
  // A command that WRITES text containing sleep is authoring data, not waiting — this task's own
  // test cases were counted as 45 s of polling before the guard.
  t(!buildDigest([rec(['cat > test.js <<EOF', 'rec("sleep 240");', "EOF"].join("\n"))]).sleepSeconds, "sleep: written text is data", 0);
  t(!buildDigest([rec(["cat > t.sh <<EOF", "for i in 1 2; do sleep 5; done", "EOF"].join("\n"))]).sleepLoop, "sleep: written loop is data", false);
  // The guard is per-clause, not whole-command: authoring text beside a real wait used to erase it.
  t(buildDigest([rec("echo x > f.json; sleep 200")]).sleepSeconds === 200, "sleep: write plus real wait", 200);
  // A poll loop that writes to a log is the worst shape there is; it must still be flagged.
  t(buildDigest([rec("while ! test -f x; do sleep 5; echo . >> log.json; done")]).sleepLoop === true, "sleep: polling loop that writes", true);
  // PowerShell is the primary shell here, so its loop shapes count too.
  t(buildDigest([rec("while ($true) { Start-Sleep 30 }")]).sleepLoop === true, "sleep: PowerShell while-loop", true);
  t(buildDigest([rec("do { Start-Sleep 20 } while ($x)")]).sleepLoop === true, "sleep: PowerShell do-while", true);
  // A left shift is not a heredoc: the wait beside it is real.
  t(buildDigest([rec('node -e "1 << n"; sleep 40')]).sleepSeconds === 40, "sleep: left shift is not a heredoc", 40);
  // A fixture inside quotes is data too: this is how the task's own checks kept reporting 275 s.
  t(!buildDigest([rec("node -e \"const c=['sleep 200'];\"")]).sleepSeconds, "sleep: quoted fixture is data", 0);
  t(buildDigest([rec("sleep 240; tail -6 out.log")]).sleepSeconds === 240, "sleep: unquoted poll still counts", 240);
}

// --- loopBodies: nesting respected, so the sleep verdict is right in both directions ----------
{
  const { loopBodies, sleepShape } = pipeline("lib/digest.js");
  t(loopBodies("for f in a; do cp $f x; done; sleep 5").length === 1 && !/sleep/.test(loopBodies("for f in a; do cp $f x; done; sleep 5")[0]), "loop: body ends at done", loopBodies("for f in a; do cp $f x; done; sleep 5"));
  t(sleepShape("while true; do for f in a; do echo $f; done; sleep 5; done").loop === true, "loop: inner for…done does not end the outer body", true);
  t(sleepShape("while ($true) { if (Test-Path x) { break }; Start-Sleep 5 }").loop === true, "loop: PS nested block does not end the body", true);
  t(sleepShape("while (1) { git pull }; Start-Sleep -Seconds 3").loop === false, "loop: PS wait after the closing brace is not a poll", false);
}

// A heredoc that mentions a build command is not a build; a quoted one still is.
{
  const bash = (cmd) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "b9", name: "Bash", input: { command: cmd } }] } });
  t(buildDigest([bash("cat >> t.test.js <<'EOF'\nt(sh(\"cargo test --workspace\"), 1)\nEOF")]).shell[0].build === false, "build: a heredoc mentioning cargo test is not a build", false);
  t(buildDigest([bash('sh -c "cargo build -p a"')]).shell[0].build === true, "build: a quoted build command is still a build", true);
}
