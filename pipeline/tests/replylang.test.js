// The reply-language hook and its registration. Run as processes against a throwaway prefix, the
// way the harness runs them: stdout is the whole contract of the hook, settings.json of the
// installer.

const { t, tFs, tPath, tOs } = require("./_harness");
const { spawnSync } = require("child_process");

const HOOK = tPath.join(__dirname, "..", "reply-lang.js");
const INSTALL = tPath.join(__dirname, "..", "install-hooks.js");
const sandbox = () => {
  const root = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "replylang-"));
  tFs.mkdirSync(tPath.join(root, ".claude", "pipeline"), { recursive: true });
  return root;
};
const hook = (root) => spawnSync(process.execPath, [HOOK, "--prefix", root], { input: "{}", encoding: "utf8" });

// The hook: silent without its file, one block naming the language with it.
{
  const root = sandbox();
  const none = hook(root);
  t(none.status === 0 && none.stdout === "", "replylang: no file, no output", JSON.stringify(none.stdout));
  const file = tPath.join(root, ".claude", "pipeline", "reply-lang.local");
  tFs.writeFileSync(file, "﻿\n  \nRussian\nnote: a second line must not leak\n", "utf8");
  const on = hook(root);
  t(on.status === 0 && /<reply-language>/.test(on.stdout) && /in Russian:/.test(on.stdout), "replylang: names the language", on.stdout.slice(0, 60));
  t(!/second line/.test(on.stdout), "replylang: only the first non-empty line", true);
  tFs.writeFileSync(file, "\n \n", "utf8");
  t(hook(root).stdout === "", "replylang: blank file, no output", true);
  tFs.rmSync(root, { recursive: true, force: true });
}

// The installer: two of ours on UserPromptSubmit, registering one must not drop the other, a
// re-run must not duplicate either, and a foreign hook in the same event survives.
{
  const root = sandbox();
  const settings = tPath.join(root, ".claude", "settings.json");
  const foreign = { type: "command", command: "other-tool.cmd" };
  tFs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [foreign] }] } }), "utf8");
  const run = () => spawnSync(process.execPath, [INSTALL, "--prefix", root], { encoding: "utf8" });
  const first = run();
  run();
  const ups = JSON.parse(tFs.readFileSync(settings, "utf8")).hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  const n = (re) => ups.filter((c) => re.test(c)).length;
  t(first.status === 0, "replylang: installer exits 0", first.stderr.slice(0, 80));
  t(n(/gate-check\.js" report/) === 1, "replylang: report hook kept once", n(/gate-check\.js" report/));
  t(n(/reply-lang\.js/) === 1, "replylang: language hook registered once", n(/reply-lang\.js/));
  t(n(/^other-tool\.cmd$/) === 1, "replylang: foreign hook survives", ups);
  tFs.rmSync(root, { recursive: true, force: true });
}

// The AskUserQuestion guard: refuses an English question under a Cyrillic reply language, lets a
// Russian one through with its short Latin labels, never judges a Latin-script language or a
// session with no language, and lets an unreadable payload through.
{
  const ASK = tPath.join(__dirname, "..", "ask-lang.js");
  const root = sandbox();
  const file = tPath.join(root, ".claude", "pipeline", "reply-lang.local");
  const ask = (questions) =>
    spawnSync(process.execPath, [ASK, "--prefix", root], {
      input: JSON.stringify({ tool_name: "AskUserQuestion", tool_input: { questions } }),
      encoding: "utf8",
    });
  const opt = (label, description) => ({ label, description });
  // The two questions that shipped in English on 2026-10-06, shape kept.
  const english = [
    {
      question: "Kyrylo's #887 already landed the station side of #616 differently. What should happen to my PR 2?",
      header: "PR 2",
      options: [opt("Follow-up on #887 (Recommended)", "Drop my branch. New small PR on top of current main."), opt("Drop PR 2 entirely", "Keep #887 as is.")],
    },
  ];
  const russian = [
    {
      question: "#887 уже вышел в v0.55.0. Переносить адрес в отдельную секцию?",
      header: "Формат",
      options: [opt("Keep [[core]]", "Оставить формат Кирилла как есть."), opt("v0.55.0", "Ничего не менять.")],
    },
  ];
  t(ask(english).status === 0, "asklang: no language file, no check", true);
  tFs.writeFileSync(file, "Russian\n", "utf8");
  const refused = ask(english);
  t(refused.status === 2 && /question 1 "Kyrylo/.test(refused.stderr), "asklang: English question refused", [refused.status, refused.stderr.slice(0, 80)]);
  t(/option 1 description/.test(refused.stderr), "asklang: an English option description is named too", refused.stderr.slice(0, 200));
  t(ask(russian).status === 0, "asklang: Russian question with short Latin labels passes", ask(russian).stderr);
  // Labels are names: the four that the month's replay refused, under a Russian question.
  const named = [
    {
      question: "Чем рисовать буквы на картинке?",
      header: "Font engine",
      options: [opt("Geist Mono + ttf-parser", "Свой растр."), opt("Stops → Sell order → SellShot → Delta", "Путь в окне."), opt("debug\\incremental (Recommended)", "Кэш сборки.")],
    },
  ];
  t(ask(named).status === 0, "asklang: identifier-like labels under a Russian question pass", ask(named).stderr.slice(0, 120));
  // A Russian question whose options slipped into English is still a question in English to read.
  const mixed = [{ question: "Что делать с PR 2?", header: "PR 2", options: [opt("Follow-up on #887 now", "Drop my branch and open a new one.")] }];
  const mixedRun = ask(mixed);
  t(mixedRun.status === 2 && /option 1 description/.test(mixedRun.stderr), "asklang: Russian question, English option description refused", mixedRun.stderr.slice(0, 200));
  // The description threshold at its edge, and a command or identifiers standing alone.
  const desc = (d) => ask([{ question: "Что запускать?", header: "Сборка", options: [opt("A", d)] }]).status;
  t(desc("Keep going.") === 0, "asklang: two English words in a description pass", true);
  t(desc("Keep going now.") === 2, "asklang: three English words in a description refused", true);
  t(desc("cargo build -p moon-core --target x86_64-pc-windows-msvc") === 0, "asklang: a bare command description passes", true);
  // Without the span removal this reads "test then the" — three plain words (a token glued to a
  // backtick is not a plain word, the middle ones are).
  t(desc("`cargo test all` then `make the tour`") === 0, "asklang: backtick spans are code", true);
  t(desc("“Keep going” now.") === 2, "asklang: curly-quoted English words still count", true);
  tFs.writeFileSync(file, "ru\n", "utf8");
  t(ask(english).status === 2, "asklang: a language code (ru) is recognised", true);
  tFs.writeFileSync(file, "Spanish\n", "utf8");
  t(ask(english).status === 0, "asklang: a Latin-script language is not judged", true);
  tFs.writeFileSync(file, "Russian\n", "utf8");
  // The review batch: a short English question is still English, and a payload that fails
  // JSON.parse (an unescaped Windows path in cwd) is still read for its question fields.
  const short = [{ question: "Ship it?", header: "PR", options: [opt("Да", "Влить."), opt("Нет", "Подождать.")] }];
  t(ask(short).status === 2, "asklang: a two-word English question refused", ask(short).status);
  const broken = (q) =>
    spawnSync(process.execPath, [ASK, "--prefix", root], {
      input:
        '{"cwd":"C:\\Users\\x","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"' +
        q +
        '","header":"PR","options":[{"label":"Да","description":"Влить \\"сейчас\\"."}]}]}}',
      encoding: "utf8",
    });
  const brokenEn = broken("What should happen to my PR?");
  t(brokenEn.status === 2, "asklang: malformed payload, English question refused", brokenEn.stderr.slice(0, 80));
  t(broken("Что делать с PR?").status === 0, "asklang: malformed payload, Russian question passes", true);
  const junk =spawnSync(process.execPath, [ASK, "--prefix", root], { input: "not json", encoding: "utf8" });
  t(junk.status === 0, "asklang: an unreadable payload lets the call through", junk.status);
  tFs.rmSync(root, { recursive: true, force: true });
}

// The installer puts the guard on PreToolUse, matched to AskUserQuestion only, once per run.
{
  const root = sandbox();
  const settings = tPath.join(root, ".claude", "settings.json");
  tFs.writeFileSync(settings, "{}", "utf8");
  const run = () => spawnSync(process.execPath, [INSTALL, "--prefix", root], { encoding: "utf8" });
  run();
  run();
  const pre = JSON.parse(tFs.readFileSync(settings, "utf8")).hooks.PreToolUse;
  const of = (re) => pre.filter((g) => g.hooks.some((h) => re.test(h.command)));
  const groups = of(/ask-lang\.js/);
  t(groups.length === 1 && groups[0].matcher === "AskUserQuestion", "asklang: installed once, AskUserQuestion only", groups.map((g) => g.matcher));
  // Same event, per-script replace: the re-run must not drop its sibling on PreToolUse.
  const sibling = of(/no-poll\.js/);
  t(sibling.length === 1 && sibling[0].matcher === "Bash|PowerShell", "asklang: no-poll survives the re-install", sibling.map((g) => g.matcher));
  tFs.rmSync(root, { recursive: true, force: true });
}
