#!/usr/bin/env node
// UserPromptSubmit hook: pins the language of every reply to the developer, on every prompt.
//
// CLAUDE.md says "in the developer's language" without naming one, and the one place that names
// it (a memory file's body) is not loaded into a session — only its index line is. With ~260 KB of
// English rules and hook output around a prompt made of nothing but a paste, the language of the
// first line (§0's class line, whose example is English) was a coin toss, and every later message
// followed it: a whole session came back in English on 2026-09-24. A line injected with each
// prompt does not depend on that toss.
//
// AskUserQuestion is named outright: its fields are tool input, and tool input reads like the
// code and PR text the same block keeps in English — on 2026-10-06 both questions of a session
// went out in English while every prose message around them was Russian. ask-lang.js refuses
// such a question before it reaches the developer; this line is the ask, that hook the guard.
//
// The language lives in reply-lang.local beside this script — this machine's preference, never
// exported to the rules repo (export-rules.js copies scripts only). No file, or an empty one:
// the hook prints nothing and the session behaves as before.

const { replyLang } = require("./lib/lang");

const lang = replyLang("reply-lang");

if (lang) {
  process.stdout.write(
    "<reply-language>\n" +
      "Every message to the developer is in " + lang + ": progress notes, questions, the §0 class\n" +
      "line and the §10 receipt included — even when the prompt is only a paste, and even when a\n" +
      "template or example in the rules is spelled in English. AskUserQuestion is a message to the\n" +
      "developer too: its question, header, option labels and descriptions are in " + lang + ".\n" +
      "Code, comments, log strings, commit messages, PR and issue text stay English, as CLAUDE.md says.\n" +
      "</reply-language>\n"
  );
}
