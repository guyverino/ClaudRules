#!/usr/bin/env node
// PreToolUse hook on AskUserQuestion: refuses a question written in English when the developer's
// reply language (reply-lang.local) is written in another script, BEFORE the dialog opens.
//
// reply-lang.js asks for the language on every prompt, and prose follows it; the questions did
// not. On 2026-10-06 both AskUserQuestion calls of one session went out in English while every
// message around them was Russian — the fields are tool input, and tool input reads like the code
// and PR text that stay English. 59 of 61 questions in the month before were right; an ask that
// holds 97% of the time leaves the developer reading the other 3%, a refusal here does not.
//
// The test is the script, not the language: a text fails when it holds none of the language's
// letters AND reads as an English phrase. Only the question and the option descriptions are
// judged. A label and a header are names — "Geist Mono + ttf-parser", "moon-remote cores",
// "debug\incremental": replaying the month's 61 real questions, judging labels refused four
// correct Russian questions for exactly that, and an English question is caught by its question
// text anyway. `preview` is not read either: it carries code and mockups. A Latin-script language (scriptOf → null)
// is not checked at all, nor is a session with no reply-lang.local.
// Exit code 2 blocks the call and hands the reason to the orchestrator; anything else lets it
// through. A payload this script cannot read lets the call through too — a hook that blocks on
// its own failure would make every question unaskable.

const { readStdin, parseHook } = require("./lib/hook");
const { replyLang, scriptOf } = require("./lib/lang");

// Three Latin words: below that a description is a name or a version, not an English sentence.
// The question itself is held to one: a question asked in the developer's language always
// carries its letters, and "Ship it?" is as English as a long one.
const MIN_LATIN_WORDS = 3;
const MIN_LATIN_WORDS_QUESTION = 1;
const latinWords = (s) => (s.match(/[A-Za-z]{2,}/g) || []).length;

// A payload that failed JSON.parse (an unescaped Windows path in cwd — see lib/hook.js) still
// carries the question fields intact, since the model's text was escaped properly; parseHook's
// fallback recovers only `command`, so the fields are read here by pattern. No question/option
// structure survives that, so each field is judged on its own and named by its key.
function patternFields(raw) {
  const out = [];
  const re = /"(question|description)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (let m; (m = re.exec(raw)); ) {
    let text = m[2];
    try {
      text = JSON.parse('"' + m[2] + '"');
    } catch {
      // keep the escaped spelling: the letters it holds are the same
    }
    out.push([m[1], text]);
  }
  return out;
}

function main() {
  // Read stdin first, whatever follows: the runner writes the payload into the pipe, and an early
  // exit would leave that write unread.
  const raw = readStdin();
  const lang = replyLang("ask-lang");
  const letters = scriptOf(lang);
  if (!letters) return 0;
  const hook = parseHook(raw);
  const input = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const english = [];
  const judge = (where, text, min) => {
    if (typeof text !== "string") return;
    if (!letters.test(text) && latinWords(text) >= (min || MIN_LATIN_WORDS)) english.push(where + ' "' + text.slice(0, 60) + '"');
  };
  if (hook.malformed) {
    for (const [key, text] of patternFields(raw)) judge(key, text, key === "question" ? MIN_LATIN_WORDS_QUESTION : 0);
  }
  questions.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const at = "question " + (i + 1);
    judge(at, q.question, MIN_LATIN_WORDS_QUESTION);
    (Array.isArray(q.options) ? q.options : []).forEach((o, j) => {
      if (!o || typeof o !== "object") return;
      judge(at + " option " + (j + 1) + " description", o.description);
    });
  });
  if (!english.length) return 0;
  process.stderr.write(
    "ask-lang (reply language " + lang + "): refused — AskUserQuestion is read by the developer, " +
      "so its question, header, option labels and descriptions are in " + lang + ". English here: " +
      english.join("; ") +
      ". Ask again with every one of them in " + lang + " (identifiers, PR titles and code may stay as they are).\n"
  );
  return 2;
}

process.exit(main());
