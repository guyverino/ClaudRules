// §0.7 — orchestration: a brief opens the worker's task (from another session's message or as a
// subagent's root prompt), and the orchestrator's own gates read its launches, audits and merges.
// Invented names only: this file is exported to the public rules repo.

const { t, tFs, tPath, tOs, pipeline, rec } = require("./_harness");
const { buildDigest } = pipeline("lib/digest.js");
const { check } = pipeline("lib/checks.js");
const { isTaskOpening, openingText, parseTranscript } = pipeline("lib/transcript.js");

const tool = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const dig = (recs, opts) => {
  const d = buildDigest(recs, opts);
  d.meta = { cwd: "", windowComplete: true };
  return d;
};
const lines = (recs, opts) => check(dig(recs, opts), "").lines.join("\n");

const BRIEF = '[orchestrator-brief] widgets / parser\ndeveloper said: "split it, go"\ntask: parse the widget file';
const peer = (body) => ({
  type: "user",
  isMeta: true,
  message: { content: 'Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="repo-01" from-mode="prompting">\n' + body + "\n</cross-session-message>" },
});
const root = (text) => ({ type: "user", isSidechain: true, parentUuid: null, message: { content: text } });
const worker = (id, model, prompt) => tool(id, "Agent", Object.assign({ subagent_type: "general-purpose", description: "part", prompt: prompt || BRIEF }, model ? { model } : {}));

// --- the opening ------------------------------------------------------------------------------
t(isTaskOpening(peer(BRIEF)), "brief: a peer message carrying the marker opens a task", true);
t(!isTaskOpening(peer("Are you building right now?")), "brief: plain coordination opens nothing", false);
// A hand-back that quotes the brief further down is not a new brief.
t(!isTaskOpening(peer("Done, sha abc.\n" + BRIEF)), "brief: a quoted marker below the first line opens nothing", false);
t(/^\[orchestrator-brief\]/.test(openingText(peer(BRIEF)) || ""), "brief: the opening text is the message body", openingText(peer(BRIEF)));
t(!isTaskOpening(root("x")), "sidechain: a root prompt opens nothing in a session journal", false);
t(isTaskOpening(root("x"), { subagent: true }), "sidechain: it opens the task in a worker journal", true);
{
  // Through parseTranscript: the file name alone decides that a journal is a worker's.
  const dir = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "orch-"));
  const f = tPath.join(dir, "sess", "subagents", "agent-a1b2c3.jsonl");
  tFs.mkdirSync(tPath.dirname(f), { recursive: true });
  tFs.writeFileSync(f, [root(BRIEF), rec.assistant("Класс: small → 1 агент"), rec.bash("b1", "git push origin HEAD")].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const p = parseTranscript(f);
  t(p.subagent && p.windowComplete && p.start === 0, "parse: a worker journal has a complete window", { subagent: p.subagent, start: p.start });
  const d = dig(p.records, { subagent: p.subagent });
  t(d.brief && /^\[orchestrator-brief\]/.test(d.prompt), "parse: the root brief is the task prompt", d.prompt.slice(0, 40));
  t(/WARN {2}s0\.7 - a worker pushed/.test(check(d, "").lines.join("\n")), "worker: a push warns", "warn");
  tFs.rmSync(dir, { recursive: true, force: true });
}
{
  // The worker session: the brief opens the window, so the prompt before it is not the task.
  const d = dig([peer(BRIEF), rec.assistant("Класс: small → 1 агент")]);
  t(d.brief && d.prompt.startsWith("[orchestrator-brief]"), "worker session: the brief is the prompt", d.prompt.slice(0, 30));
  t(!/s0\.7/.test(lines([peer(BRIEF), rec.bash("b1", "git commit -m x")])), "worker: a local commit is fine", "silent");
}

// --- the orchestrator -------------------------------------------------------------------------
const orch = rec.assistant("orchestrate → 2 workers (parser: opus, ui: sonnet) · seams · drive it");
const audit = (id, agent) => rec.bash(id, 'node "C:/x/.claude/pipeline/gate-check.js" digest --hand --agent ' + agent);
const merge = (id, part) => rec.bash(id, "git merge --no-ff orch/widgets--" + part);
t(/WARN {2}s0\.7 - orchestrate declared, yet no brief/.test(lines([rec.user("x"), orch])), "orch: no brief warns", "warn");
t(!/s0\.7/.test(lines([rec.user("x"), orch, worker("w1", "opus")])), "orch: a briefed worker with a model is clean", "silent");
t(/no explicit model/.test(lines([rec.user("x"), orch, worker("w1", "")])), "orch: a worker with no model warns", "warn");
t(/without a `developer said:`/.test(lines([rec.user("x"), orch, worker("w1", "haiku", "[orchestrator-brief] a / b\ntask: x")])), "orch: a brief with no quote warns", "warn");
t(/5 workers briefed, the cap is 4/.test(lines([rec.user("x"), orch].concat([1, 2, 3, 4, 5].map((i) => worker("w" + i, "sonnet"))))), "orch: a fifth worker warns", "warn");
t(/edited project code itself/.test(lines([rec.user("x"), orch, worker("w1", "opus"), rec.edit("e1", "src/a.rs")])), "orch: its own code edit warns", "warn");
t(/merged \(step 2\) with 0 worker audit/.test(lines([rec.user("x"), orch, worker("w1", "opus"), merge("m1", "parser")])), "orch: a merge before any audit warns", "warn");
{
  const ok = [rec.user("x"), orch, worker("w1", "opus"), worker("w2", "sonnet"), audit("a1", "a111"), merge("m1", "parser"), audit("a2", "a222"), merge("m2", "ui")];
  t(/no seams angle ran/.test(lines(ok)), "orch: two merged parts without seams warn", "warn");
  t(!/s0\.7/.test(lines(ok.concat([tool("s1", "Agent", { subagent_type: "seams", description: "s", prompt: "p" })]))), "orch: audits before each merge plus seams are clean", "silent");
  // Re-auditing the SAME worker twice does not cover a second part.
  const one = [rec.user("x"), orch, worker("w1", "opus"), audit("a1", "a111"), merge("m1", "parser"), audit("a2", "a111"), merge("m2", "ui")];
  t(/ui was merged \(step 5\) with 1 worker audit/.test(lines(one)), "orch: one worker audited twice covers one part", "warn");
}

// --- the offer --------------------------------------------------------------------------------
{
  const feature = rec.assistant("Класс: фича → 2 агента");
  const edits = ["a/x.rs", "a/y.rs", "b/x.rs", "b/y.rs", "c/x.rs", "c/y.rs", "c/z.rs", "d/x.rs"].map((f, i) => rec.edit("e" + i, "src/" + f));
  const ask = (label) => tool("q1", "AskUserQuestion", { questions: [{ question: "Как делать?", header: "h", multiSelect: false, options: [{ label }, { label: "иначе" }] }] });
  const note = (recs) => check(dig(recs), "").lines.join("\n");
  t(/note {2}s0\.7 - 8 code files across 4 folders/.test(note([rec.user("x"), feature, rec.assistant("Понял так: x")].concat(edits))), "offer: a wide feature with no split question gets a note", "note");
  t(!/s0\.7/.test(note([rec.user("x"), feature, ask("Разбить на 3 части")].concat(edits))), "offer: a window that offered the split is enough", "silent");
  t(!/s0\.7/.test(note([rec.user("x"), feature, rec.assistant("Понял так: x")].concat(edits.slice(0, 4)))), "offer: a narrow feature is not judged", "silent");
}

// --- review findings, 19.11 -------------------------------------------------------------------
{
  // A brief delivered while the worker session was mid-turn: a queued_command attachment.
  const queued = { type: "attachment", attachment: { type: "queued_command", prompt: '<cross-session-message from="uds:x" from-name="repo-01" from-mode="prompting">\n' + BRIEF + "\n</cross-session-message>" } };
  t(isTaskOpening(queued), "brief: a queued mid-turn brief opens a task", true);
  t(!isTaskOpening({ type: "attachment", attachment: { type: "queued_command", prompt: "поправь ещё вот это" } }), "brief: a queued developer message opens nothing", false);
}
{
  // The worker's project is its worktree, not the cwd the audit runs from.
  const wt = '[orchestrator-brief] widgets / parser\ndeveloper said: "go"\nworktree: E:/wt/parser · branch: orch/widgets--parser';
  const d = dig([root(wt), rec.assistant("Класс: фича → 2 агента"), rec.edit("e1", "E:/wt/parser/src/a.rs")], { subagent: true });
  t(d.worktree === "E:/wt/parser", "worktree: read from the brief", d.worktree);
  t(/no named review angle/.test(check(d, d.worktree).lines.join("\n")), "worktree: a worker's unreviewed edit is judged", "warn");
}
{
  const ship = dig([peer(BRIEF), rec.bash("b1", "git -C E:/wt/parser push origin HEAD")]);
  t(/a worker pushed/.test(check(ship, "").lines.join("\n")), "worker: git -C <dir> push warns", "warn");
}
{
  // Merges: `git -C`, octopus, never merge-base; the own pinned session is no audit.
  const own = (recs, session) => {
    const d = dig(recs);
    d.meta.session = session;
    return check(d, "").lines.join("\n");
  };
  const base = [rec.user("x"), orch, worker("w1", "opus"), worker("w2", "opus")];
  t(/with 0 worker audit/.test(lines(base.concat([rec.bash("m", "git -C E:/wt/int merge orch/widgets--parser")]))), "merge: git -C <dir> merge is seen", "warn");
  t(/for 2 merged part/.test(lines(base.concat([audit("a1", "a111"), rec.bash("m", "git merge orch/widgets--parser orch/widgets--ui")]))), "merge: an octopus counts every part", "warn");
  t(!/merged/.test(lines(base.concat([rec.bash("m", "git merge-base orch/widgets--parser HEAD")]))), "merge: merge-base is not a merge", "silent");
  const pinned = base.concat([rec.bash("a1", 'node gate-check.js digest --hand --session sess-own-1234'), merge("m1", "parser")]);
  t(/with 0 worker audit/.test(own(pinned, "sess-own-1234")), "audit: the own pinned session is not a worker audit", "warn");
  const both = base.concat([rec.bash("a1", "node gate-check.js digest --hand --session sess-own-1234 --agent a111"), merge("m1", "parser")]);
  t(!/worker audit/.test(own(both, "sess-own-1234")), "audit: --agent beside the pinned session counts", "silent");
  const seamsEarly = base.concat([audit("a1", "a111"), tool("s1", "Agent", { subagent_type: "seams", description: "s", prompt: "p" }), merge("m1", "parser"), audit("a2", "a222"), merge("m2", "ui")]);
  t(/no seams angle ran/.test(lines(seamsEarly)), "seams: a run before the last merge does not cover the integration", "warn");
  const rebrief = [rec.user("x"), orch].concat([1, 2, 3, 4].map((i) => tool("s" + i, "SendMessage", { to: "repo-0" + i, message: BRIEF })), [tool("s9", "SendMessage", { to: "repo-01", message: BRIEF })]);
  t(!/the cap is/.test(lines(rebrief)), "cap: a re-brief of the same session is one worker", "silent");
}
{
  // The class: orchestrate only as the declared name; a bold arrow line is a declaration.
  const { classDeclared } = pipeline("lib/digest.js");
  t(/^\*\*feature/.test(classDeclared("**feature → 3 агента (flow · half-fix)**")), "class: a bold arrow line is read", classDeclared("**feature → 3 агента**"));
  t(classDeclared("* feature → bullet in a list") === "", "class: a single-star list item is not", classDeclared("* feature → x"));
  t(!/s0\.7 - orchestrate declared/.test(lines([rec.user("x"), rec.assistant("Класс: фича → правка правил оркестратора"), rec.assistant("Понял так: x")])), "class: a feature about the orchestrator is not one", "silent");
}

// --- fix-diff findings, 19.11 -----------------------------------------------------------------
{
  const res = (id, text) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: text }] } });
  const base = [rec.user("x"), orch, worker("w1", "opus"), worker("w2", "opus")];
  // An early unaudited merge must not hide the missing seams over the whole integration.
  const both = base.concat([merge("m1", "parser"), audit("a1", "a111"), audit("a2", "a222"), merge("m2", "ui")]);
  t(/no seams angle ran/.test(lines(both)), "seams: still judged after a merge-before-audit WARN", "warn");
  // A piped audit that found no journal: exit code lost, the stderr line still says so.
  const piped = base.concat([rec.bash("a1", "node gate-check.js digest --hand --agent a999 2>&1 | tail -5"), res("a1", "gate-check: no subagent journal agent-a999.jsonl\n{}"), merge("m1", "parser")]);
  t(/with 0 worker audit/.test(lines(piped)), "audit: a piped run that read no journal is no audit", "warn");
}
