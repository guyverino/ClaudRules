// The ledger: the finding parser, the accept heuristic, roles, dedupe key, path matching.

const { t, tFs, tPath, tOs, pipeline } = require("./_harness");

// --- ledger: the finding parser and the accept heuristic -----------------------------------
const led = pipeline("lib/ledger.js");

const agentAnswer = [
  "`crates/moon-core/src/feed/trade.rs:42 — sl_level for a short uses the long formula — high`",
  "`crates/moon-ui-gpui/src/panels/chart/trade.rs:7 — a stop is drawn before it exists — medium`",
  "this line is prose and must not parse as a finding",
  "`note: 12 — no path here, not a finding — low`",
  "agentId: abc\n<usage>subagent_tokens: 102832\ntool_uses: 9\nduration_ms: 222014</usage>",
].join("\n");
const parsed = led.parseAgentResult(agentAnswer);
t(parsed.tokens === 102832, "ledger: tokens parsed", parsed.tokens);
t(parsed.durationMs === 222014, "ledger: duration parsed", parsed.durationMs);
t(parsed.findings.length === 2, "ledger: only real findings", parsed.findings.length);
t(parsed.findings[0].severity === "high", "ledger: severity read", parsed.findings[0].severity);
t(parsed.findings[0].line === 42, "ledger: line read", parsed.findings[0].line);
t(led.parseAgentResult("0 findings").zero === true, "ledger: zero findings noted", true);
// Two contract slips seen live, tolerated because the finding is worth more than the letter:
// `— severity: medium (long aside).` closed a seams answer and lost its one real finding.
{
  const slip = led.parseAgentResult("crates/a/geom.rs:161 — `pane_at` never excludes the zone — severity: medium (wrong placement, not a crash (nested) here).");
  t(slip.findings.length === 1 && slip.findings[0].severity === "medium" && slip.findings[0].line === 161, "ledger: `severity: word (aside)` tail still parses", JSON.stringify(slip.findings[0]));
  t(led.parseAgentResult("x/y.rs:3 — claim with — dashes and high risk — high").findings[0].claim === "claim with — dashes and high risk", "ledger: severity is the last dash word, never one inside the claim", true);
}
// leak-review answers with a verdict line, not a finding list: a clean review is a complete answer.
{
  const verdict = led.parseAgentResult("VERDICT: CLEAN — 1 commit(s), 23 pre-scan hits examined, nothing reaches protected data\n\ncleared:\n- Cargo.lock:3804 (23 × \"network endpoint\") — same fork URL");
  t(verdict.verdict === "CLEAN" && verdict.findings.length === 0, "ledger: VERDICT line read", verdict.verdict);
  t(led.parseAgentResult("verdict: unsure — x").verdict === "UNSURE", "ledger: verdict case-insensitive", true);
  t(led.parseAgentResult("prose only").verdict === "", "ledger: no verdict in prose", true);
}

// The tag spelling of usage — the one a live transcript actually carries.
const tagged = led.parseAgentResult("<usage><subagent_tokens>103970</subagent_tokens><tool_uses>9</tool_uses><duration_ms>382541</duration_ms></usage>");
t(tagged.tokens === 103970 && tagged.durationMs === 382541, "ledger: tagged usage parsed", [tagged.tokens, tagged.durationMs]);

// A background agent: launch stub as tool_result, the answer as a <task-notification> user turn.
// Recorded on a feature task as 8 of 11 agents with 0 findings and 0 tokens.
{
  const call = (id, type) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: type, description: "x" } }] } });
  const result = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  const notify = (id, body, tokens) => ({
    type: "user",
    message: { content: [{ type: "text", text: "<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>" + id + "</tool-use-id>\n<status>completed</status>\n<result>" + body + "</result>\n<usage><subagent_tokens>" + tokens + "</subagent_tokens><tool_uses>3</tool_uses><duration_ms>1000</duration_ms></usage>\n</task-notification>" }] },
  });
  const digest = { agents: [{ step: 1, type: "flow" }, { step: 2, type: "half-fix" }], writes: [], shell: [], prompt: "p" };
  const meta = { session: "s", cwd: "" };
  const bg = led.buildRow(
    [
      call("id1", "flow"), result("id1", "Async agent launched successfully. agentId: a1"),
      call("id2", "half-fix"), result("id2", "`crates/a.rs:3 — sync claim — low`\n<usage>subagent_tokens: 500\ntool_uses: 1\nduration_ms: 10</usage>"),
      notify("id1", "crates/b.rs:7 — a &gt; b is wrong — high", 7000),
    ],
    digest, meta, { lines: [] }
  );
  const flow = bg.agents.find((a) => a.type === "flow");
  const half = bg.agents.find((a) => a.type === "half-fix");
  t(bg.agents.length === 2, "ledger: launch stub is not a second run", bg.agents.length);
  t(flow && flow.findings === 1 && flow.tokens === 7000, "ledger: background answer paired by tool-use id", flow && [flow.findings, flow.tokens]);
  t(bg.findings.some((f) => f.agent === "flow" && /a > b/.test(f.claim)), "ledger: html entities unescaped", bg.findings.map((f) => f.claim));
  t(half && half.findings === 1 && half.tokens === 500, "ledger: synchronous answer still paired", half && [half.findings, half.tokens]);
  const twice = led.buildRow(
    [call("id1", "flow"), result("id1", "Async agent launched"), notify("id1", "0 findings", 100), notify("id1", "crates/c.rs:1 — late — low", 200)],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(twice.agents.length === 1 && twice.agents[0].findings === 1 && twice.agents[0].tokens === 200, "ledger: repeated notification, last wins", twice.agents.map((a) => [a.findings, a.tokens]));
  // The third arrival: a blocking TaskOutput fetch keyed by the agentId from the launch stub.
  // Live: three angles fired, two fetched this way, only the notified one recorded.
  const stubWithId = (id, agentId) => result(id, "Async agent launched successfully. (This tool result is internal metadata …)\nagentId: " + agentId + " (internal ID …)");
  const fetchCall = (callId, agentId) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name: "TaskOutput", input: { task_id: agentId, block: true } }] } });
  const fetchResult = (callId, status, body) => result(callId, "<retrieval_status>success</retrieval_status>\n<task_id>x</task_id>\n<status>" + status + "</status>\n<output>\n" + body + "\n</output>");
  const fetched = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "a8baf7af"), fetchCall("t1", "a8baf7af"), fetchResult("t1", "completed", "crates/f.rs:4 — fetched claim — medium")],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(fetched.agents.length === 1 && fetched.agents[0].findings === 1, "ledger: TaskOutput fetch paired to its agent", fetched.agents.map((a) => [a.type, a.findings]));
  // The fourth arrival (harness of 2026-09-18): the report is its own <agent-message> hand-back,
  // indented; the notification, the synchronous tool_result and a TaskOutput fetch only POINT at
  // it. Three days of every angle at 0 findings and 100% malformed before this case existed.
  const POINTER = "This agent's report was delivered to you as a message from \"AGENT\" (its SubagentHandback call). Read it there; it is not repeated here.";
  const handback = (agentId, body) => ({ type: "queue-operation", operation: "enqueue", content: '<agent-message from="' + agentId + '">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:\n' + body.split("\n").map((l) => "  " + l).join("\n") + "\n</agent-message>" });
  const pointerNotify = (id, agentId, tokens) => notify(id, POINTER.replace("AGENT", agentId), tokens);
  const hb = led.buildRow(
    [
      call("id1", "flow"), stubWithId("id1", "a20675"), handback("a20675", "crates/hb.rs:12 — hand-back claim — high\ncrates/hb.rs:30 — second — low"), pointerNotify("id1", "a20675", 136824),
      handback("b11111", "0 findings"), call("id2", "half-fix"), result("id2", POINTER.replace("AGENT", "b11111") + "\nagentId: b11111 (use SendMessage …)\n<usage>subagent_tokens: 700\ntool_uses: 9\nduration_ms: 40</usage>"),
      call("id3", "seams"), stubWithId("id3", "c22222"), handback("c22222", "crates/s.rs:1 — seam — medium"), fetchCall("t2", "c22222"), fetchResult("t2", "completed", POINTER.replace("AGENT", "c22222")), pointerNotify("id3", "c22222", 50),
    ],
    { agents: [{ step: 1, type: "flow" }, { step: 2, type: "half-fix" }, { step: 3, type: "seams" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  const hbFlow = hb.agents.find((a) => a.type === "flow");
  const hbHalf = hb.agents.find((a) => a.type === "half-fix");
  const hbSeams = hb.agents.find((a) => a.type === "seams");
  t(hbFlow && hbFlow.findings === 2 && hbFlow.tokens === 136824 && !hbFlow.malformed, "ledger: background hand-back paired, usage from the pointer", hbFlow && [hbFlow.findings, hbFlow.tokens, hbFlow.malformed]);
  t(hbHalf && hbHalf.saidZero && hbHalf.tokens === 700 && !hbHalf.malformed, "ledger: sync pointer result + hand-back before its stub", hbHalf && [hbHalf.saidZero, hbHalf.tokens, hbHalf.malformed]);
  // No TaskOutput fetch has been seen in a hand-back-era transcript (0 calls since 2026-09-18):
  // this case pins the shape BY ANALOGY with the older fetch, not an observed record.
  t(hbSeams && hbSeams.findings === 1 && hbSeams.tokens === 50, "ledger: TaskOutput pointer does not erase the hand-back", hbSeams && [hbSeams.findings, hbSeams.tokens]);
  const fetchOnly = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "d33333"), handback("d33333", "crates/f.rs:2 — fetched — low"), fetchCall("t3", "d33333"), fetchResult("t3", "completed", POINTER.replace("AGENT", "d33333") + "\n<usage>subagent_tokens: 4242\ntool_uses: 2\nduration_ms: 9</usage>")],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(fetchOnly.agents.length === 1 && fetchOnly.agents[0].tokens === 4242 && fetchOnly.agents[0].findings === 1, "ledger: a blocking fetch is the usage carrier when no notification follows", fetchOnly.agents.map((a) => [a.findings, a.tokens]));
  // An older-shape answer for the same call wins over a joined hand-back — the guard at the join.
  const bothShapes = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "e44444"), handback("e44444", "crates/hb.rs:1 — from the hand-back — low"), notify("id1", "crates/old.rs:9 — from the notification — high", 77)],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(bothShapes.agents.length === 1 && bothShapes.findings.length === 1 && /old\.rs/.test(bothShapes.findings[0].file) && bothShapes.agents[0].tokens === 77, "ledger: a full notification wins over a hand-back for the same call", bothShapes.findings.map((f) => f.file));
  t(hb.findings.some((f) => f.agent === "flow" && f.line === 12 && f.severity === "high"), "ledger: hand-back lines de-indented and parsed", hb.findings.map((f) => f.line));
  t(led.angleFindingCount([call("id1", "flow"), stubWithId("id1", "a20675"), handback("a20675", "crates/hb.rs:12 — x — high"), pointerNotify("id1", "a20675", 1)]) === 1, "ledger: batch count sees the hand-back", 1);
  const orphan = led.buildRow([call("id1", "flow"), stubWithId("id1", "zz"), pointerNotify("id1", "zz", 10)], { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] });
  t(orphan.agents.length === 0, "ledger: pointer without its hand-back leaves no trace", orphan.agents.length);
  // A clean leak review is a complete answer, not a broken one — it was recorded as malformed on
  // every clean review, and stats.js decides on that rate.
  const clean = led.buildRow(
    [call("id1", "leak-review"), result("id1", "Async agent launched"), notify("id1", "VERDICT: CLEAN — 1 commit(s), 3 pre-scan hits examined, nothing reaches protected data", 900)],
    { agents: [{ step: 1, type: "leak-review" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(clean.agents.length === 1 && clean.agents[0].malformed === false, "ledger: a VERDICT answer is not malformed", clean.agents.map((a) => a.malformed));
  // The §6 batch size the checker reads: angles only, before dedupe, support agents excluded.
  const batch = [
    call("id1", "flow"), result("id1", "Async agent launched"),
    call("id2", "half-fix"), result("id2", "crates/a.rs:3 — one — low\ncrates/a.rs:4 — two — low\ncrates/a.rs:5 — three — medium"),
    call("id3", "fix-diff"), result("id3", "crates/a.rs:3 — one again — low"),
    notify("id1", "crates/b.rs:7 — four — high\ncrates/b.rs:9 — five — high\ncrates/b.rs:11 — six — low", 100),
  ];
  t(led.angleFindingCount(batch) === 6, "ledger: angle finding count — 3 + 3 angles, fix-diff excluded", led.angleFindingCount(batch));
  const fetchedRunning = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "a8baf7af"), fetchCall("t1", "a8baf7af"), fetchResult("t1", "running", "")],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(fetchedRunning.agents.length === 0, "ledger: a fetch of a still-running agent records nothing", fetchedRunning.agents.length);
  const fetchedError = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "a8baf7af"), fetchCall("t1", "a8baf7af"), Object.assign(result("t1", "No such task: a8baf7af"), { message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "No such task" }] } })],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(fetchedError.agents.length === 0, "ledger: an errored fetch records nothing", fetchedError.agents.length);
  const fetchedNoStatus = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "a8baf7af"), fetchCall("t1", "a8baf7af"), result("t1", "partial output without a status tag")],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(fetchedNoStatus.agents.length === 0, "ledger: a fetch without a status tag records nothing", fetchedNoStatus.agents.length);
  const fetchedThenNotified = led.buildRow(
    [call("id1", "flow"), stubWithId("id1", "a8baf7af"), notify("id1", "crates/f.rs:4 — claim — medium", 4200), fetchCall("t1", "a8baf7af"), fetchResult("t1", "completed", "crates/f.rs:4 — claim — medium")],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(fetchedThenNotified.agents[0].tokens === 4200, "ledger: a later fetch keeps the notification's usage", fetchedThenNotified.agents[0].tokens);
  // Mid-turn arrival: the same text as a queue-operation record and an attachment record.
  const queued = led.buildRow(
    [
      call("id1", "flow"), result("id1", "Async agent launched"),
      { type: "queue-operation", operation: "enqueue", content: notify("id1", "crates/q.rs:5 — queued claim — medium", 900).message.content[0].text },
      { type: "attachment", attachment: { type: "queued_command", prompt: notify("id1", "crates/q.rs:5 — queued claim — medium", 900).message.content[0].text } },
    ],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(queued.agents.length === 1 && queued.agents[0].findings === 1 && queued.agents[0].tokens === 900, "ledger: mid-turn notification via queue-operation", queued.agents.map((a) => [a.findings, a.tokens]));
  const silent = led.buildRow(
    [call("id1", "flow"), result("id1", "Async agent launched")],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  // Review finding: a synchronous is_error leaves no run; the background twins must not either —
  // a stub counted as "malformed" inflated exactly the rate stats.js decides on.
  t(silent.agents.length === 0, "ledger: launched but never reported leaves no run", silent.agents.length);
  const failedBg = led.buildRow(
    [call("id1", "flow"), result("id1", "Async agent launched"), notify("id1", "irrelevant", 50).message.content[0].text.includes("completed")
      ? { type: "user", message: { content: [{ type: "text", text: notify("id1", "irrelevant", 50).message.content[0].text.replace("<status>completed</status>", "<status>failed</status>") }] } }
      : null],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(failedBg.agents.length === 0, "ledger: failed background run leaves no run", failedBg.agents.length);
  const killedBg = led.buildRow(
    [call("id1", "flow"), result("id1", "Async agent launched"),
      { type: "user", message: { content: [{ type: "text", text: notify("id1", "", 0).message.content[0].text.replace("<status>completed</status>", "<status>killed</status>") }] } }],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(killedBg.agents.length === 0, "ledger: any non-completed status leaves no run", killedBg.agents.length);
  const arrayAttachment = led.buildRow(
    [
      call("id1", "flow"), result("id1", "Async agent launched"),
      { type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: notify("id1", "crates/z.rs:2 — block-shaped — low", 300).message.content[0].text }] } },
    ],
    { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, meta, { lines: [] }
  );
  t(arrayAttachment.agents.length === 1 && arrayAttachment.agents[0].findings === 1, "ledger: attachment prompt as content blocks", arrayAttachment.agents.map((a) => a.findings));
}

// A line range or a parenthetical aside after the line is tolerated and keyed on the first line.
const ranged = led.parseAgentResult("`crates/msg_ring.rs:244-245` — never rolls back the first hook — low\ncrates/render.rs:362 (footer, calls cores.rs:238) — O(targets × rows) per render — medium");
t(ranged.findings.length === 2 && ranged.findings[0].line === 244 && ranged.findings[1].line === 362, "ledger: line range and aside parsed", ranged.findings.map((f) => f.line));
t(led.parseAgentResult("crates/a.rs:9 — one message looks like two — medium.").findings.length === 1, "ledger: trailing period after severity", 1);

// A claim containing dashes must not confuse the severity anchored at the end.
const dashy = led.parseAgentResult("`src/a.rs:9 — the value — after rounding — is wrong — medium`");
t(dashy.findings.length === 1 && dashy.findings[0].severity === "medium", "ledger: dashes in claim", dashy.findings[0] && dashy.findings[0].severity);

// editedAfter: same file later = yes; earlier = no; a different file = no.
const writes = [{ step: 5, file: "crates/moon-core/src/feed/trade.rs" }, { step: 2, file: "other.rs" }];
t(led.editedAfter(writes, 3, "crates/moon-core/src/feed/trade.rs") === true, "ledger: edited after finding", true);
t(led.editedAfter(writes, 7, "crates/moon-core/src/feed/trade.rs") === false, "ledger: edit preceded finding", false);
t(led.editedAfter(writes, 1, "crates/moon-core/src/feed/other2.rs") === false, "ledger: unrelated file", false);
// A Windows absolute path and a repo-relative one denote the same file.
t(led.editedAfter([{ step: 9, file: "C:\\repo\\crates\\a\\b.rs" }], 1, "crates/a/b.rs") === true, "ledger: path forms match", true);

// --- appendRow: append-only, and the next row starts on a fresh line even after a torn one ----
{
  const dir = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "ledger-append-"));
  const file = tPath.join(dir, "ledger.jsonl");
  const rows = () =>
    tFs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return []; // the torn line the last case plants on purpose
      }
    });
  led.appendRowTo(file, { taskKey: "s1:a", n: 1 });
  led.appendRowTo(file, { taskKey: "s1:a", n: 2 });
  t(rows().length === 2 && rows().map((r) => r.n).join() === "1,2", "ledger: append-only — the same task twice is two rows (the reader dedupes)", rows().map((r) => r.n));
  tFs.appendFileSync(file, '{"taskKey":"s1:c",', "utf8"); // a torn last line, no newline
  led.appendRowTo(file, { taskKey: "s1:c", n: 5 });
  t(rows().length === 3 && rows()[2].n === 5, "ledger: after a torn last line the next row starts on a fresh line", tFs.readFileSync(file, "utf8").split("\n").length);
  tFs.rmSync(dir, { recursive: true, force: true });
}

// --- ledger: roles, dedupe key, path matching ----------------------------------------------
t(led.roleOf("flow") === "angle", "ledger: angle role", led.roleOf("flow"));
t(led.roleOf("verify-finding") === "support", "ledger: support role", led.roleOf("verify-finding"));
t(led.roleOf("general-purpose") === "generic", "ledger: generic role", led.roleOf("general-purpose"));
// Two files with the same name in different folders must NOT credit each other.
t(led.editedAfter([{ step: 9, file: "crates/a/src/tests.rs" }], 1, "crates/b/src/tests.rs") === false, "ledger: same basename, other dir", false);
t(led.editedAfter([{ step: 9, file: "C:\\repo\\crates\\b\\src\\tests.rs" }], 1, "crates/b/src/tests.rs") === true, "ledger: same file, abs vs rel", true);
// Two different tasks sharing a prompt prefix must get different keys.
const long = "a".repeat(200);
t(led.hash(long + "one") !== led.hash(long + "two"), "ledger: key survives prefix clash", true);
// A VERDICT line completes only leak-review's contract; an angle that echoes one is still malformed.
{
  const call = (id, type) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Agent", input: { subagent_type: type, description: "x" } }] } });
  const result = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  const row = led.buildRow([call("id1", "flow"), result("id1", "VERDICT: CLEAN — nothing to see")], { agents: [{ step: 1, type: "flow" }], writes: [], shell: [], prompt: "p" }, { session: "s", cwd: "" }, { lines: [] });
  t(row.agents[0].malformed === true, "ledger: a verdict line does not complete an angle's contract", row.agents[0].malformed);
}
