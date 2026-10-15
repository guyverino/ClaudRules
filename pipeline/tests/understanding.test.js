// §0.5 — understanding the request: questions go through AskUserQuestion (one window, a second
// when the picture changed), or the task says in one line how it read the request. Judged on
// digests built from journal-shaped records, the way the Stop hook sees a real task.

const { t, pipeline, rec } = require("./_harness");
const { buildDigest, proseQuestions, understoodDeclared } = pipeline("lib/digest.js");
const { check } = pipeline("lib/checks.js");

const tool = (id, name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, isError) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: Boolean(isError), content: "ok" }] } });
const ask = (id, n, multi) =>
  tool(id, "AskUserQuestion", { questions: Array.from({ length: n }, (_, i) => ({ question: "q" + i + "?", header: "h", multiSelect: i < (multi || 0), options: [] })) });
const reads = (n) => Array.from({ length: n }, (_, i) => tool("r" + i, "Read", { file_path: "src/x" + i + ".rs" }));
const dig = (recs) => {
  const d = buildDigest(recs);
  d.meta = { cwd: "", windowComplete: true };
  return d;
};
const lines = (recs) => check(dig(recs), "").lines.join("\n");

// --- the digest -------------------------------------------------------------------------------
{
  const d = dig([rec.user("сделай"), ask("a1", 3, 1), result("a1")]);
  t(d.asks.length === 1 && d.asks[0].questions === 3 && d.asks[0].multi === 1, "ask: a call is counted with its questions and checkboxes", d.asks);
  // A question the ask-lang hook refused never reached the developer: it is not a window.
  const refused = dig([rec.user("сделай"), ask("a1", 2), result("a1", true), ask("a2", 2), result("a2")]);
  t(refused.asks.length === 1, "ask: a refused call is not a window", refused.asks.length);
  // Only the text the turn ENDED on is judged: questions asked mid-turn and then acted on are not
  // the shape that sends the answer into a new window.
  const mid = dig([rec.user("x"), rec.assistant("1. A?\n2. B?"), tool("b", "Bash", { command: "ls" }), rec.assistant("готово")]);
  t(mid.proseQuestions === 0, "prose: questions followed by more work are not the ending", mid.proseQuestions);
}

// --- what counts as a prose question and as an understanding line ------------------------------
t(proseQuestions("Вопросы:\n1. Какой цвет?\n2) Где кнопка? или в меню\n**3.** Нужен тест?") === 3, "prose: numbered, parenthesised and bold items with a '?' count", proseQuestions("1. a?\n2) b?\n**3.** c?"));
t(proseQuestions("1. собрал\n2. проверил\n3. залил") === 0, "prose: a numbered report with no question is not a question", 0);
t(proseQuestions("Почему так? Потому что 2.5 > 2?") === 0, "prose: a question outside a list item is not counted", 0);
t(understoodDeclared("**Класс:** фича\nПонял так: кнопка в шапке, только для Main"), "understood: the line is read", true);
t(!understoodDeclared("0.5 understanding: <asked n | Понял так: <the reading> >"), "understood: a quoted template line is not a statement", false);

// --- the gate ---------------------------------------------------------------------------------
{
  const feature = rec.assistant("**Класс:** фича → 2 агента");
  const edit = rec.edit("e1", "src/a.rs");
  t(/WARN {2}s0\.5 - the turn ended on 2 numbered questions/.test(lines([rec.user("x"), feature, rec.assistant("Понял так: x"), rec.assistant("1. Так?\n2. Или так?")])), "gate: numbered prose questions at the end warn", "warn");
  t(!/numbered questions/.test(lines([rec.user("x"), rec.assistant("Класс: тривиальная → правка текста"), rec.assistant("1. Так?\n2. Или так?")])), "gate: a trivial task is not judged", "silent");
  t(/WARN {2}s0\.5 - a feature with no question asked/.test(lines([rec.user("x"), feature, edit])), "gate: a feature that neither asked nor said how it read the request warns", "warn");
  t(!/s0\.5/.test(lines([rec.user("x"), feature, rec.assistant("Понял так: кнопка в шапке"), edit])), "gate: the understanding line satisfies it", "silent");
  t(!/s0\.5/.test(lines([rec.user("x"), feature, ask("a1", 2), result("a1"), edit])), "gate: one window satisfies it", "silent");
  t(!/s0\.5/.test(lines([rec.user("x"), feature, ask("a1", 2), result("a1"), ask("a2", 1), result("a2"), edit])), "gate: a second window is allowed", "silent");
  t(/WARN {2}s0\.5 - 3 AskUserQuestion windows/.test(lines([rec.user("x"), feature, ask("a1", 2), result("a1"), ask("a2", 1), result("a2"), ask("a3", 1), result("a3"), edit])), "gate: a third window warns", "warn");
  t(!/AskUserQuestion windows/.test(lines([rec.user("x"), feature, ask("a1", 2), result("a1"), ask("a2", 1), result("a2"), ask("a3", 1), result("a3"), edit, rec.assistant("0.5 understanding: 2 windows · N/A: confirmation, deploy to prod")])), "gate: a declared confirmation window is not counted against it", "silent");
  // Research owes no class line, so the size of the work is what marks it.
  t(/WARN {2}s0\.5 - a 30-step task with no edits/.test(lines([rec.user("разберись")].concat(reads(30)))), "gate: long work with no edits and no understanding line warns", "warn");
  t(!/s0\.5/.test(lines([rec.user("что тут?")].concat(reads(10)))), "gate: a short look-up is not research", "silent");
  t(!/s0\.5/.test(lines([rec.user("разберись")].concat(reads(30), [rec.assistant("Понял так: нужен только список причин")]))), "gate: research that said how it read the request is clean", "silent");
  // Review findings, 15.10: editing the harness from a project cwd has no PROJECT writes but is
  // not research; a declared bug investigation is governed by its class.
  const outside = [rec.user("поправь пайплайн")].concat(reads(20), [rec.edit("e9", "C:/Users/dev/.claude/pipeline/lib/checks.js")]);
  t(!/research\?/.test(check(dig(outside), "D:/projects/repo").lines.join("\n")), "gate: edits outside the project are not research", "silent");
  t(!/research\?/.test(lines([rec.user("почему падает")].concat([rec.assistant("Класс: bug → repro first")], reads(20)))), "gate: a declared bug investigation is not research", "silent");
  // By hand the receipt (and its confirmation) is not written yet: a note, not a WARN.
  const three = [rec.user("x"), feature, ask("a1", 2), result("a1"), ask("a2", 1), result("a2"), ask("a3", 1), result("a3"), edit];
  const hand = dig(three);
  hand.meta.invokedBy = "hand";
  t(/note {2}s0\.5 - 3 AskUserQuestion windows/.test(check(hand, "").lines.join("\n")), "gate: three windows by hand before the receipt is a note", "note");
}

// The turn's ending text, not a preamble written beside a call.
t(dig([rec.user("x"), { type: "assistant", message: { content: [{ type: "text", text: "1. Так?\n2. Или так?" }, { type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [] } }] } }]).proseQuestions === 0, "prose: numbered questions beside a tool call are not the ending", 0);
t(proseQuestions("1. `let x = f()?;` — проверено\n2. запрос `GET /a?b=1` — ок") === 0, "prose: a '?' inside a code span is not a question", 0);
