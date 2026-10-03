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

// --- a heredoc's body is data, its opener line is the command --------------------------------
// 03.10: `cat >> tests/digest.test.js <<'EOF'` appending a test whose text held `cat > crates/a.rs`
// recorded crates/a.rs as written — "Rust files were edited and cargo fmt never ran" on a task
// that touched no Rust.
[
  ["cat >> tests/x.test.js <<'EOF'\nt(into(\"cat > crates/a.rs\"))\nEOF", ["tests/x.test.js"], "a redirect quoted in the body is data"],
  ["cat > notes.md <<EOF\nsed -i s/a/b/ crates/y.rs\nEOF", ["notes.md"], "sed in the body is data"],
  ["cat <<'EOF' > out/gen.rs\nfn a() {}\nEOF", ["out/gen.rs"], "a redirect after the opener on its line counts"],
  ["bash <<'EOF'\ncat > crates/z.rs\nEOF", ["crates/z.rs"], "a body fed to a shell is commands"],
  ["git commit -F - <<'EOF'\nfix: write > crates/a.rs\nEOF", [], "a commit message is data"],
  ["cat > a.md <<'EOF'\nx\nEOF\ncat > crates/b.rs", ["a.md", "crates/b.rs"], "a write after the terminator counts"],
  ["@'\nx > crates/a.rs\n'@ | Set-Content -Path docs/n.md", ["docs/n.md"], "a PowerShell here-string body is data"],
  // A body fed to a shell is commands, wherever the opener line names the shell.
  ["cat <<'EOF' | bash\ncat > crates/z.rs\nEOF", ["crates/z.rs"], "a body piped to bash is commands"],
  ["sudo /bin/bash -s -- x <<EOF\ncat > crates/z.rs\nEOF", ["crates/z.rs"], "sudo /bin/bash -s is a shell"],
  ["@'\ncat > crates/z.rs\n'@ | iex", ["crates/z.rs"], "a here-string piped to iex is commands"],
  ["cat > fix.sh <<'EOF'\ncat > crates/z.rs\nEOF", ["fix.sh"], "a file named *.sh is not a shell"],
  // Terminators the way the shell reads them.
  ["cat > a.md <<'END-OF-FILE'\nx > crates/a.rs\nEND-OF-FILE", ["a.md"], "a hyphenated tag is a tag"],
  ["cat > a.md <<'EOF'\n  EOF\nx > crates/a.rs\nEOF", ["a.md"], "an indented tag does not end a plain heredoc"],
  ["cat > a.md <<-EOF\nx > crates/a.rs\n\tEOF\ncat > crates/b.rs", ["a.md", "crates/b.rs"], "<<- ends at a tab-indented tag"],
  ["cat <<< word > out.md\nword", ["out.md"], "<<< is a here-string, not a heredoc"],
].forEach(([cmd, exp, label]) => {
  const out = [];
  collectWrites(cmd, 1, out);
  const got = out.map((w) => w.file);
  t(got.join(",") === exp.join(","), "heredoc: " + label, JSON.stringify(got));
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
  // tested-tree.js: `check` names the suite and runs nothing; `run` runs it.
  const suite = (cmd) => buildDigest([bash(cmd)]).shell[0].test;
  t(suite('node "C:/x/pipeline/tested-tree.js" check -- cargo test --workspace') === false, "test: tested-tree check runs nothing", false);
  t(suite('node "C:/x/pipeline/tested-tree.js" run -- cargo test --workspace') === true, "test: tested-tree run is a suite run", true);
  t(suite("node C:/x/tested-tree.js check -- cargo test --workspace; cargo test --workspace") === true, "test: a run chained after a check counts", true);
  // The documented spelling, both halves quoted: the check must not unbalance the quotes and so
  // blank the real run after it.
  const chain = 'node "C:/x/tested-tree.js" check -- cargo test --workspace || node "C:/x/tested-tree.js" run -- cargo test --workspace | Select-String "test result"';
  t(suite(chain) === true, "test: quoted check || run counts the run", suite(chain));
}

// How a shell command ended, and where a rootless target lives after `cd` into the scratchpad.
{
  const nl = String.fromCharCode(10);
  const call = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (id, text, isError) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(isError), content: [{ type: "text", text }] }] } });
  const one = (text, isError) => buildDigest([call("S1", "Bash", { command: "cargo check -p a" }), result("S1", text, isError)]).shell[0];
  t(one("Exit code 101" + nl + "error[E0277]: x", true).failed === true, "result: is_error marks the run failed", true);
  t(one("Exit code 2" + nl + "x").failed === true, "result: a non-zero exit line marks it failed", true);
  t(one("    Finished `dev` profile").failed === false, "result: a clean run is not failed", false);
  t(one("    Finished `dev` profile").buildRan === true, "result: build output says the build ran", true);
  t(one("Traceback (most recent call last):" + nl + "AssertionError").editFailed === true, "result: a Traceback is a failed edit", true);
  t(one("ok").resultAt === 1, "result: resultAt is the step it arrived at", one("ok").resultAt);
  // A backgrounded run says how it ended in its notification, not in its launch result.
  const bg = buildDigest([
    call("S1", "PowerShell", { command: "cargo test --workspace", run_in_background: true }),
    result("S1", "Command running in background with ID: b1"),
    { type: "attachment", attachment: { type: "queued_command", prompt: ["<task-notification>", "<tool-use-id>S1</tool-use-id>", "<status>failed</status>", "</task-notification>"].join(nl) } },
  ]).shell[0];
  t(bg.failed === true, "result: a failed background notification marks the run", bg.failed);
  // A refused Edit takes no step of its own, but is kept between its neighbours.
  const refused = buildDigest([
    call("E1", "Edit", { file_path: "crates/a/src/x.rs", old_string: "a", new_string: "b" }),
    call("S2", "Bash", { command: "cargo check -p a" }),
    result("E1", "String to replace not found", true),
    result("S2", "Finished"),
  ]);
  t(refused.shell[0].step === 1 && refused.failedWrites.length === 1 && refused.failedWrites[0].step === 0.5, "result: a refused Edit is kept off the step count", JSON.stringify(refused.failedWrites));
  t(refused.writes.length === 0, "result: a refused Edit is not a write", refused.writes.length);
  // `cd <scratchpad> && cat > scan.js` wrote a scratch file: three such scripts read as "code was
  // edited, no named review angle fired" on a research task.
  const into = (cmd) => {
    const out = [];
    collectWrites(cmd, 1, out);
    return out.map((w) => w.file);
  };
  const scratch = "/c/Users/u/AppData/Local/Temp/claude/s/scratchpad";
  t(into('cd "' + scratch + '"; cat > scan.js <<\'EOF\'' + nl + "x" + nl + "EOF")[0] === scratch + "/scan.js", "cd: a rootless target after cd into the scratchpad is scratch", into('cd "' + scratch + '"; cat > scan.js'));
  t(into("cd " + scratch + "; sed -i 's/a/b/' pertask.js")[0] === scratch + "/pertask.js", "cd: sed -i after cd into the scratchpad", into("cd " + scratch + "; sed -i 's/a/b/' pertask.js"));
  t(into('cd "D:/proj" && cat > crates/a.rs')[0] === "crates/a.rs", "cd: after cd into the project the target stays relative", into('cd "D:/proj" && cat > crates/a.rs'));
  t(into('cd "' + scratch + '"; cat > D:/proj/a.rs')[0] === "D:/proj/a.rs", "cd: a rooted target is not re-rooted", into('cd "' + scratch + '"; cat > D:/proj/a.rs'));
  // A second move may go anywhere; `../` climbs out of the folder.
  t(into("cd " + scratch + "; node gen.js; cd D:/proj && cat > src/x.rs")[0] === "src/x.rs", "cd: a second cd turns re-rooting off", into("cd " + scratch + "; node gen.js; cd D:/proj && cat > src/x.rs"));
  t(into("cd " + scratch + "; cat > ../x.rs")[0] === "../x.rs", "cd: ../ is not scratch", into("cd " + scratch + "; cat > ../x.rs"));
  // 03.10: `S=<scratch>; mkdir -p $S/ab && cd $S/ab && printf … > x.rs` — the move is not first and
  // its folder sits in a variable; read as the project, x.rs raised "Rust files were edited".
  const viaVar = "S=" + scratch + "; mkdir -p $S/ab && cd $S/ab && printf 'x' > x.rs";
  t(into(viaVar)[0] === scratch + "/ab/x.rs", "cd: a later cd into a variable's scratch folder", into(viaVar));
  // A target written BEFORE the move is relative to where the command started.
  const before = "cat > crates/a.rs; cd " + scratch + "; cat > b.js";
  t(into(before).join(",") === "crates/a.rs," + scratch + "/b.js", "cd: a write before the cd is not re-rooted", into(before));
  // A move that ends inside the command: where the later writes land cannot be told — none re-rooted.
  const sub = "(cd " + scratch + " && make); cat > crates/a.rs";
  t(into(sub)[0] === "crates/a.rs", "cd: a subshell's move ends with it", into(sub));
  const popd = "pushd " + scratch + "; cat > x.js; popd; cat > crates/a.rs";
  t(into(popd).includes("crates/a.rs"), "cd: popd ends the move", into(popd));
  // PowerShell assignment and a quoted folder with spaces.
  const ps = "$S = \"" + scratch + "\"; Set-Location $S; cat > x.rs";
  t(into(ps)[0] === scratch + "/x.rs", "cd: a PowerShell $S = … is expanded", into(ps));
  const spaced = 'cd "C:/Users/u/AppData/Local/Temp/my dir/scratchpad"; cat > x.rs';
  t(into(spaced)[0] === "C:/Users/u/AppData/Local/Temp/my dir/scratchpad/x.rs", "cd: a quoted folder with spaces", into(spaced));
  // A `cd` line inside a heredoc body is the body's text, for the script scanner too.
  const scriptOut = (cmd) => buildDigest([call("S1", "Bash", { command: cmd })]).writes.filter((w) => w.tool === "script").map((w) => w.file);
  const bodyCd = "cd " + scratch + " && python - <<'EOF'\n# then: cd crates\nopen('out.json','w')\nEOF";
  t(scriptOut(bodyCd)[0] === scratch + "/out.json", "cd: a cd inside a script body is not a second move", scriptOut(bodyCd));
  // A script named where it is written, run after the move: its targets start where it runs.
  const late = "cat > fix.py <<'EOF'\nopen('out.json','w')\nEOF\ncd " + scratch + " && python fix.py";
  t(scriptOut(late).includes(scratch + "/out.json"), "cd: a script's position is where it runs", scriptOut(late));
  // The pipeline's own commands quoted in a heredoc body ran nothing.
  const quoted = buildDigest([call("S1", "Bash", { command: "cat >> t.test.js <<'EOF'\nnode leak-check.js mark; node leak-check.js ack-release; node leak-check.js others\nEOF" })]).shell[0];
  t(!quoted.leakMark && !quoted.releaseAck && !quoted.others, "flags: quoted in a heredoc body is not a run", [quoted.leakMark, quoted.releaseAck, quoted.others].join());
  const real = buildDigest([call("S1", "PowerShell", { command: 'node "C:\\Users\\u\\.claude\\pipeline\\leak-check.js" mark' })]).shell[0];
  t(real.leakMark === true, "flags: a real quoted-path mark still counts", real.leakMark);
  // A background run killed half-way did not end green.
  const killed = buildDigest([
    call("S1", "PowerShell", { command: "cargo build -p a", run_in_background: true }),
    result("S1", "Command running in background with ID: b1"),
    { type: "attachment", attachment: { type: "queued_command", prompt: ["<task-notification>", "<tool-use-id>S1</tool-use-id>", "<status>killed</status>", "</task-notification>"].join(nl) } },
  ]).shell[0];
  t(killed.failed === true, "result: a killed background run is not green", killed.failed);
  // apply-batch.js: the spec's FILE lines are the writes; --check writes nothing; an unknown spec
  // is an unresolved write, never silence.
  const spec = call("W1", "Write", { file_path: scratch + "/fix.spec", content: ["@@@ FILE crates/a/src/x.rs", "@@@ OLD", "a", "@@@ NEW", "b", "@@@ END", "@@@ FILE crates/b/src/y.rs", "@@@ OLD", "c", "@@@ NEW", "d", "@@@ END"].join(nl) });
  const batch = (cmd) => buildDigest([spec, call("S1", "Bash", { command: cmd })]).writes.filter((w) => w.tool === "apply-batch");
  const ran = batch('node "C:/u/.claude/pipeline/apply-batch.js" ' + scratch + "/fix.spec");
  t(ran.map((w) => w.file).join(",") === "crates/a/src/x.rs,crates/b/src/y.rs", "batch: the spec's files are the writes", ran.map((w) => w.file).join(","));
  t(batch("node apply-batch.js " + scratch + "/fix.spec --check").length === 0, "batch: --check writes nothing", 0);
  const unknown = batch("node apply-batch.js other.spec");
  t(unknown.length === 1 && unknown[0].unknown === true, "batch: an unknown spec is an unresolved write", JSON.stringify(unknown));
  t(batch("node apply-batch.js --root D:/proj " + scratch + "/fix.spec").length === 2, "batch: --root before the spec", 2);
}
