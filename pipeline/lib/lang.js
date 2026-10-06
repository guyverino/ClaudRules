// The developer's reply language, read from reply-lang.local beside the pipeline scripts — one
// reading shared by the hook that announces it (reply-lang.js) and the hook that enforces it on
// AskUserQuestion (ask-lang.js), so the two can never disagree about which language is pinned.

const fs = require("fs");
const path = require("path");
const { pipelineDir } = require("./root");

// First non-empty line of the file, BOM stripped; "" when the file is missing or blank. A note
// under the first line must not leak into the prompt or the check.
function replyLang(who) {
  try {
    const text = fs.readFileSync(path.join(pipelineDir(who), "reply-lang.local"), "utf8");
    return (text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) || "").trim();
  } catch {
    return "";
  }
}

// The letters a language is written in, for the languages whose script tells them apart from
// English. A Latin-script language (Spanish, Portuguese, …) gets null: its text and English share
// one alphabet, so a script test cannot judge it, and guessing by word lists would refuse correct
// questions. Matched on the language name as written in the file, English or native.
const SCRIPTS = [
  [/^(russian|ukrainian|belarusian|bulgarian|serbian|kazakh|русский|українська|беларуская|български|српски|қазақ)/i, /[Ѐ-ӿ]/],
  [/^(greek|ελληνικά)/i, /[Ͱ-Ͽ]/],
  [/^(hebrew|עברית)/i, /[֐-׿]/],
  [/^(arabic|persian|farsi|العربية|فارسی)/i, /[؀-ۿ]/],
  [/^(chinese|japanese|中文|日本語)/i, /[぀-ヿ一-鿿]/],
  [/^(korean|한국어)/i, /[가-힯]/],
];

function scriptOf(lang) {
  const hit = SCRIPTS.find(([name]) => name.test(String(lang || "").trim()));
  return hit ? hit[1] : null;
}

module.exports = { replyLang, scriptOf };
