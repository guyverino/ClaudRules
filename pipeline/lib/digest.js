// From the records of one task to a digest: which agents fired, which shell commands ran (and
// whether each was a build / test / formatter / leak mark / parallel check / pull), which files
// were written — through the Write tool, a shell redirect or a script — how much `sleep` was
// declared, which hook lines opened the session, and the class line the orchestrator stated.
// Nothing here judges: that is checks.js. This file only reads the record faithfully, and its
// comments are the catalogue of shapes that fooled it once.

const { CODE_EXT, TEST_RUN_RE, FMT_RE, BUILD_RE, LEAK_MARK_RE, OTHERS_RE, PULL_RE, RELEASE_ACK_RE, SHIP_RE, escapeRe, testTargeted, testKey } = require("./stacks");
const { userTurnText, isTaskOpening, textOf, isAgentCall } = require("./transcript");

// What "this script writes a file" looks like in Python and JS: a write CALL, or an open() in a
// write/append mode. `open(p)` alone is a read and must not count. A call, not a word:
// `console.log("writes:", n)` in an inspection script is not a write, and a bare `\bwrite` matched
// it — three phantom project writes on a pure analysis task.
const SCRIPT_WRITE_MARK = "\\b(?:writeFileSync|writeFile\\b|write\\(|open\\([^)]*['\"][wa]\\+?['\"])";
const SCRIPT_WRITE_MARK_RE = new RegExp(SCRIPT_WRITE_MARK);
// Files written from the shell never show up as Write/Edit tool calls, so a check that counts
// only those tools is blind to a whole working style - and this environment nudges toward it.
const SHELL_WRITE_RE = new RegExp(
  // Neither `=>` (arrow) nor `>=` (comparison) is a redirect: guard the character before AND after.
  "(?:^|[\\s|;&])(?:cat|tee|printf|echo)\\b[^|;&\\n]*(?<![=<>])>>?(?![=])\\s*\\S+" +
    "|(?<![=<>])>>?(?![=])\\s*\\S+\\.(?:" + CODE_EXT + ")\\b" +
    "|\\bsed\\s+-i" +
    "|\\bperl\\s+-[a-z]*i" +
    "|\\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\\b" +
    "|\\bgit\\s+apply\\b|\\bpatch\\s+-" +
    "|\\b(?:python|node)\\s+-[ec]\\b[^|;&\\n]*" + SCRIPT_WRITE_MARK,
  "i"
);
// Every plausible target in one command, so nine files written by one heredoc script count nine.
// No bare -Path here: `Get-Content -Path x.json` is a read, and counting it as a write forced a
// build and /code-review onto research tasks.
// The `(?<![=<>])` matters more than it looks: `.sort((a,b)=>b.ts-a.ts)` in an inline node script
// otherwise reads as a redirect into a file called `b.ts-a.ts`, and the whole research task then
// reports "code was edited, no review angle fired".
const WRITE_TARGET_RE = new RegExp(
  "(?:(?<![=<>])>>?\\s*|-o\\s+|-Destination(?:Path)?\\s+)([\"']?)([~\\w./\\\\:-]+\\.(?:" + CODE_EXT + "))(?![A-Za-z0-9])\\1",
  "gi"
);
// -Path counts only beside a cmdlet that actually writes, and only on the SAME line: a newline
// away sits an unrelated reading command whose argument would otherwise be recorded as written.
const PS_WRITE_TARGET_RE = new RegExp(
  "\\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\\b[^|;&\\n]*?" +
    "(?:-(?:Path|LiteralPath|Destination(?:Path)?)\\s+)?([\"']?)([~\\w./\\\\:-]+\\.(?:" +
    CODE_EXT +
    "))(?![A-Za-z0-9])\\1",
  "gi"
);
// sed -i / perl -pi edit in place: the target is a bare trailing argument, not a redirect.
const INPLACE_TARGET_RE = new RegExp(
  "\\b(?:sed|perl)\\s+-[a-z0-9]*i[a-z0-9]*\\b[^|;&\\n]*?([~\\w./\\\\:-]+\\.(?:" + CODE_EXT + "))(?![A-Za-z0-9])",
  "gi"
);
// Shapes that look like a write but are not. The search tools are anchored as commands: an
// unanchored "rg" also matches inside "--target", which dropped every write in such a command.
const NOT_A_WRITE_RE = new RegExp(
  "(?:>\\s*(?:/dev/null|\\$null|NUL)\\b)" +
    "|(?:-ItemType\\s+Directory)" +
    "|(?:(?:^|[\\s|;&])(?:grep|rg|Select-String|findstr)\\s)",
  "i"
);
// Per-clause, never whole-command: `New-Item -ItemType Directory $d; Set-Content $dst` does write,
// and testing the whole string would hide it behind the harmless first clause.
const CLAUSE_SPLIT_RE = new RegExp("&&|\\|\\||;|\\n");

function collectWrites(fullCmd, step, out) {
  // Cap the scan: these patterns are quadratic on a long unbroken path-like token, and the Stop
  // hook has a timeout to respect. A write target this far into one command is not worth it.
  const cmd = fullCmd.slice(0, 4000);
  let seen = 0;
  for (const re of [WRITE_TARGET_RE, INPLACE_TARGET_RE, PS_WRITE_TARGET_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      const file = m[2] || m[1];
      if (file) {
        out.push({ step, tool: "shell", file });
        seen += 1;
      }
    }
  }
  if (seen) return;
  // Clause by clause: a command writes when ANY clause writes, and a benign clause beside it
  // must not grant the whole command silence.
  const writes = cmd
    .split(CLAUSE_SPLIT_RE)
    .some((clause) => SHELL_WRITE_RE.test(clause) && !NOT_A_WRITE_RE.test(clause));
  if (writes) out.push({ step, tool: "shell", file: "", unknown: true });
}

// A script that edits the tree names its target INSIDE its body, never on the command line:
// `python "scratch/fix.py"` after the Write tool authored fix.py, or `python - <<'EOF' …
// io.open(p,'w') … EOF`. A command-text scan then records the scratch script as the only write
// and the project edit vanishes — caught on a live task that rewrote tab.rs twice this way and
// digested as `writes: 1 (project 0)`, which also silenced the "no class line" WARN. This
// environment tells the orchestrator to edit through scripts, so the shape is the norm.
// The targets are the quoted paths in a body that actually writes. A path the script only reads
// is recorded too — over-counting a touched file is the cheaper error here.
const SCRIPT_FILE_RE = /\.(?:py|js|mjs|cjs|rb|pl)$/i;
// scratchpad / temp / tmp, or a path with no root at all (`cat > fix.py`). A rooted path — drive,
// slash, or `~` — outside those folders is not registered: that is where the pipeline's own tooling
// and project files live, and charging their comments as edits is the worse error. Known cost: a
// throwaway written straight into the home root (`~/fix.py`) is missed too. A ROOTLESS path into
// the project (`cat > scripts/x.py`) does register and is then over-counted with the paths it
// names — the cheaper error. Both registration sites (the Write tool and a shell heredoc) go
// through this test.
const THROWAWAY_RE = /(?:^|[\\/])(?:scratchpad|temp|tmp)[\\/]|^(?![a-z]:[\\/]|[\\/]|~)/i;
const INTERPRETER_RE = /(?:^|[\s|;&(])(?:python3?|node|ruby|perl)\b/i;
const QUOTED_PATH_RE = new RegExp("['\"]([~\\w./\\\\:-]+\\.(?:" + CODE_EXT + "))['\"]", "g");
const INTERPRETER_HEREDOC_RE = new RegExp(
  "(?:^|[\\s|;&(])(?:python3?|node|ruby|perl)\\b[^\\n]*<<-?\\s*(['\"]?)([A-Za-z_]\\w*)\\1[^\\n]*\\n([\\s\\S]*?)^\\s*\\2\\s*$",
  "gim"
);
// `cat > fix.py <<'EOF' … EOF`: the script body arrives through the shell, not the Write tool.
const SCRIPT_HEREDOC_RE = new RegExp(
  "(?<![=<>])>>?\\s*(['\"]?)(\\S+\\.(?:py|js|mjs|cjs|rb|pl))\\1\\s*<<-?\\s*(['\"]?)([A-Za-z_]\\w*)\\3[^\\n]*\\n([\\s\\S]*?)^\\s*\\4\\s*$",
  "gim"
);
// A path quoted INSIDE a block string is data the script carries, not a file it touches: a patch
// script whose `old`/`new` blocks hold test fixtures (`"crates/a/src/x.rs"`) charged those
// fixtures as edits to the project — "Rust files were edited" on a task that touched no Rust.
// Python triple quotes and JS template literals are the block strings a fix script uses.
const BLOCK_STRING_RE = /"""[\s\S]*?"""|'''[\s\S]*?'''|`[\s\S]*?`/g;

function scriptTargets(body) {
  if (!SCRIPT_WRITE_MARK_RE.test(body)) return null; // the script does not write
  const out = new Set();
  // Strip first, cap second: a block string cut open by the cap would never close, and every
  // quoted path in the fixture it carries would be read as a target — the very shape D13 fixes.
  const head = body.replace(BLOCK_STRING_RE, " ").slice(0, 20000);
  QUOTED_PATH_RE.lastIndex = 0;
  let m;
  while ((m = QUOTED_PATH_RE.exec(head)) !== null) out.add(m[1]);
  return [...out];
}

// `scripts` maps a script file authored earlier in this task to its body; a command that runs one
// of them under an interpreter is charged that body's targets.
function collectScriptWrites(cmd, step, out, scripts) {
  const charge = (body) => {
    const targets = scriptTargets(body);
    if (targets === null) return;
    if (targets.length === 0) out.push({ step, tool: "script", file: "", unknown: true });
    for (const file of targets) out.push({ step, tool: "script", file });
  };
  INTERPRETER_HEREDOC_RE.lastIndex = 0;
  let m;
  while ((m = INTERPRETER_HEREDOC_RE.exec(cmd)) !== null) charge(m[3]);
  SCRIPT_HEREDOC_RE.lastIndex = 0;
  while ((m = SCRIPT_HEREDOC_RE.exec(cmd)) !== null) {
    if (THROWAWAY_RE.test(m[2])) scripts.set(m[2], m[5]);
  }
  if (!INTERPRETER_RE.test(cmd)) return;
  for (const [file, body] of scripts) {
    // basename, so the same script reached by a relative and by an absolute path both match —
    // bounded on both sides: `python prefix.py` must not be charged with fix.py's targets.
    const base = file.split(/[\\/]/).pop();
    if (!base) continue;
    const bounded = new RegExp("(?<![\\w.-])" + escapeRe(base) + "(?![\\w-])");
    if (bounded.test(cmd)) charge(body);
  }
}

// A tool_use whose result came back is_error never happened: an agent type that does not exist,
// a command that failed to start. Counting one as a fired angle would let a typo close the gate.
function failedToolIds(records) {
  const ids = new Set();
  for (const rec of records) {
    if (rec.type !== "user" || !rec.message || !Array.isArray(rec.message.content)) continue;
    for (const b of rec.message.content) {
      if (b && b.type === "tool_result" && b.is_error && b.tool_use_id) ids.add(b.tool_use_id);
    }
  }
  return ids;
}

// Heredoc bodies and quoted spans cut out: a fixture or a doc that MENTIONS `cargo test`, `sleep
// 200` or `git rebase` is not a run, a wait or a pull.
function withoutHeredocs(full) {
  return full.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?^\s*\2\s*$/gm, " ");
}
function bareOf(full) {
  return withoutHeredocs(full).replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
}

// The BODY of every shell loop in the text, nesting respected: bash `do … done` and PowerShell
// `while (…) { … }` / `foreach (…) { … }` / `for (…) { … }` / `do { … } while`. A regex that
// scanned "up to 400 characters after `do`" bridged past `done` and refused `for …; done; sleep 5`
// once the no-poll hook started blocking on it; a regex bounded at the FIRST `done` or `}` was
// then blind to `while ($true) { if (c) { break }; Start-Sleep 5 }` and to a poll with an inner
// `for … done`. Counting the depth is the only reading that gets both right.
function loopBodies(text) {
  const bodies = [];
  // bash: `do` opens, `done` closes; a `do` inside is a nested loop, one level deeper.
  const bashTok = /\b(do|done)\b/g;
  let m;
  const stack = [];
  while ((m = bashTok.exec(text)) !== null) {
    if (m[1] === "do") stack.push(m.index + 2);
    else if (stack.length) bodies.push(text.slice(stack.pop(), m.index));
  }
  // PowerShell: the `{` after a loop head opens the body; braces inside nest.
  const psHead = /\b(?:while|for|foreach)\s*\([^{]*\)\s*\{|\bdo\s*\{/gi;
  while ((m = psHead.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < text.length && depth) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
      i += 1;
    }
    bodies.push(text.slice(m.index + m[0].length, depth ? text.length : i - 1));
  }
  return bodies;
}

// Polling a background task with sleep is the single most expensive habit measured so far:
// 131 minutes in one session, 41% of its runtime. The declared duration is in the command
// text, so it costs nothing to add up — but units matter: `sleep 5m` is 300 s, not 5, and
// reading it as 5 would let the very shape this counts for slip under the threshold.
//
// Authored text is data, not a wait — but the guard must be surgical, not whole-command:
// `echo x > f.json; sleep 200` really does wait 200 s, and a poll loop that writes to a log
// is the worst shape there is. So: cut out heredoc BODIES and quoted spans (a `sleep` inside a
// script being written or a fixture passed to an interpreter never delays this command), then
// judge clause by clause. A real poll is unquoted — `sleep 240; tail -6 log`.
// The shape of the waiting in ONE command, on its heredoc-stripped text: every declared wait in
// seconds, and whether a sleep sits inside a loop. Shared by the digest (which sums it into the
// task) and by the no-poll hook (which refuses the command before it runs) — one reading of
// `sleep`, or the hook would let through what the checker later warns about.
function sleepShape(bare) {
  const waits = [];
  const waitText = bare
    .split(CLAUSE_SPLIT_RE)
    .filter((clause) => !SHELL_WRITE_RE.test(clause))
    .join(" ; ");
  for (const m of waitText.matchAll(
    /\b(?:sleep\s+(\d+(?:\.\d+)?)([smhd])?|Start-Sleep\s+(?:-Seconds\s+)?(\d+(?:\.\d+)?)|Start-Sleep\s+-Milliseconds\s+(\d+))/gi
  )) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] || "s").toLowerCase()] || 1;
    const secs = m[4] ? Number(m[4]) / 1000 : Number(m[1] || m[3] || 0) * unit;
    // Cap a single value: a typo'd `sleep 99999999999` must not print "Infinity min", and
    // JSON.stringify would silently write null for a non-finite number.
    if (Number.isFinite(secs)) waits.push(Math.min(secs, 86400));
  }
  // A sleep inside a loop costs its duration times the iterations, and the text says only the
  // duration — the poll loop, the worst shape, is the one a sum understates most. Matched on
  // shell STRUCTURE (`for … do`, `while … do`, PowerShell `foreach (`), not on the English
  // words: `echo "waiting for the build"; sleep 30` is not a loop.
  // A loop that also writes still polls, so this looks at the heredoc-stripped text, not at
  // the write-filtered one. PowerShell shapes included: it is the primary shell here.
  // The sleep must sit INSIDE a loop body (loopBodies, nesting respected): `for …; done; sleep 5`
  // is a loop and then a wait, not a poll — and since the no-poll hook BLOCKS on this verdict,
  // the old "400 characters after `do`" scan turned that idiom into a refused command.
  const loop = loopBodies(bare).some((body) => /\b(?:sleep|Start-Sleep)\b/i.test(body));
  return { waits, loop };
}

function countSleep(d, bare) {
  const { waits, loop } = sleepShape(bare);
  for (const secs of waits) {
    d.sleepSeconds = (d.sleepSeconds || 0) + secs;
    d.sleepCalls = (d.sleepCalls || 0) + 1;
  }
  if (loop) {
    d.sleepLoop = true;
    d.sleepCalls = d.sleepCalls || 0;
    d.sleepSeconds = d.sleepSeconds || 0;
  }
}

function buildDigest(records) {
  const failed = failedToolIds(records);
  const d = {
    prompt: "",
    agents: [],
    shell: [],
    skills: [],
    writes: [],
    slashCommands: [],
    order: [],
  };
  let fullText = "";
  let step = 0;
  const scripts = new Map(); // script path -> body, for collectScriptWrites
  for (const rec of records) {
    // Hook output is recorded as an attachment; the leak gate (§5) is the one gate whose trigger
    // lives there — the SessionStart line "LEAK REVIEW PENDING" — and nowhere in the agent's text.
    if (rec.type === "attachment" && rec.attachment && rec.attachment.type === "hook_additional_context") {
      const c = rec.attachment.content;
      const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : (x && x.text) || "")).join("\n") : "";
      if (/LEAK REVIEW PENDING/.test(t)) d.leakPending = true;
      if (/PARALLEL WORK:/.test(t)) d.parallelPending = true;
      // The release-surface alarm (§5): a commit by others on the paths that decide what users
      // install, not yet read by this developer.
      if (/RELEASE SURFACE CHANGED/.test(t)) d.releasePending = true;
      // The repo has other contributors, whether or not anything is pending right now: a pull
      // mid-task re-arms §1 here; a solo repo (neither line) never does.
      if (/PARALLEL WORK:|CONTRIBUTORS:/.test(t)) d.contributors = true;
      continue;
    }
    if (!d.prompt && isTaskOpening(rec)) {
      d.prompt = (userTurnText(rec) || "").slice(0, 2000);
      continue;
    }
    // slash commands the user typed still matter: /code-review is invoked that way too
    const uText = userTurnText(rec);
    if (uText !== null) {
      const m = uText.match(/<command-name>\s*(\/[a-z0-9:_-]+)/i) || uText.match(/^\s*(\/[a-z0-9:_-]+)/);
      if (m) {
        // keep the arguments too: /code-review --fix must be visible on the slash path as well
        const args = uText.match(/<command-args>([^<]*)</i);
        d.slashCommands.push((m[1] + (args ? " " + args[1] : "")).toLowerCase().trim());
      }
      continue;
    }
    if (rec.type !== "assistant" || !rec.message || !Array.isArray(rec.message.content)) continue;
    const t = textOf(rec.message.content);
    if (t) fullText += t + "\n";
    for (const b of rec.message.content) {
      if (!b || b.type !== "tool_use") continue;
      // A tool call whose result came back is_error did not happen: a nonexistent agent type, an
      // Edit whose string did not match. Shell is the exception - a command that exited non-zero
      // still ran, and dropping it would erase build attempts and writes made before the failure.
      if (b.name !== "Bash" && b.name !== "PowerShell" && failed.has(b.id)) continue;
      const inp = b.input || {};
      step += 1;
      if (isAgentCall(b)) {
        const type = inp.subagent_type || "general-purpose";
        d.agents.push({
          step,
          type,
          description: inp.description || "",
          promptHead: String(inp.prompt || "").slice(0, 500),
        });
        d.order.push(step + ":agent(" + type + ")");
      } else if (b.name === "Bash" || b.name === "PowerShell") {
        const full = String(inp.command || "");
        // detection runs on the FULL command; only the stored copy is truncated.
        const bare = bareOf(full);
        d.shell.push({
          step,
          command: full.slice(0, 300),
          // Heredoc bodies out, quotes kept: a test file written through a heredoc that MENTIONS
          // `cargo test` is not a build (four phantom "builds" fired the fix-batch gate on the
          // task that wrote them), while `sh -c "cargo build"` still is one.
          build: BUILD_RE.test(withoutHeredocs(full)),
          test: TEST_RUN_RE.test(bare),
          // Targeted-or-full and the run's identity are decided here too, on the full text: a
          // `python - <<'PYEOF' … PYEOF && cargo test -p moon-chart hvol` carries its cargo clause
          // past the 300-character stored copy, and judged on that copy the targeted run read as
          // a full suite run — two phantom "full" runs on the first digest this was tried on.
          // Heredocs out, QUOTES kept: on the quote-blanked text `--features "a b" hvol` lets
          // `--features` swallow the filter, and a quoted filter `"x::y"` vanishes from the key.
          targeted: testTargeted(withoutHeredocs(full)),
          testKey: testKey(withoutHeredocs(full)),
          fmt: FMT_RE.test(bare),
          leakMark: LEAK_MARK_RE.test(full),
          releaseAck: RELEASE_ACK_RE.test(full),
          ship: SHIP_RE.test(bare),
          others: OTHERS_RE.test(full),
          pull: PULL_RE.test(bare),
        });
        d.order.push(step + ":shell");
        collectWrites(full, step, d.writes);
        collectScriptWrites(full, step, d.writes, scripts);
        countSleep(d, bare);
      } else if (b.name === "Skill") {
        d.skills.push({ step, skill: inp.skill || "", args: inp.args || "" });
        d.order.push(step + ":skill(" + (inp.skill || "") + ")");
      } else if (b.name === "Write" || b.name === "Edit" || b.name === "NotebookEdit") {
        d.writes.push({ step, tool: b.name, file: inp.file_path || "" });
        // Only a THROWAWAY script is a fix script: one in the scratchpad or at a bare relative
        // path. A Write to the pipeline's own tooling followed by `node gate-check.js digest` — the
        // routine cycle here — would otherwise charge every quoted path in its comments as an edit.
        if (b.name === "Write" && SCRIPT_FILE_RE.test(inp.file_path || "") && THROWAWAY_RE.test(inp.file_path)) {
          scripts.set(inp.file_path, String(inp.content || ""));
        }
        d.order.push(step + ":" + b.name.toLowerCase());
      }
    }
  }
  // The class line is stated FIRST, so it must be read before any truncation.
  d.classLine = classDeclared(fullText);
  // Either language: the receipt itself is written in the developer language.
  d.hasReceipt = /(Class \+ recipe|Класс \+ рецепт)\s*:/i.test(fullText);
  d.assistantText = fullText.slice(-20000);
  return d;
}

function classDeclared(text) {
  // No \b after the keyword: in JS it is ASCII-only, so "Класс:" never matches a word boundary.
  // The LAST declaration wins, not the first: §0 requires re-stating the class out loud when the
  // work turns out bigger than declared, and keeping the first would record the lighter recipe
  // forever — hiding exactly the escalation the rule exists to make visible.
  const all = (
    text.match(/^\s*(?:\*\*)?(?:Класс|Class)(?:\s*\+\s*(?:recipe|рецепт))?\s*[:—-][^\n]{0,300}/gim) || []
    // A quoted receipt template ("Class + recipe: <what I stated at §0>") is not a declaration, and
    // taking the last match would let it overwrite the real one and flip isTrivial/isSmall.
  ).filter((line) => !/<[^>]*>/.test(line));
  if (all.length) return all[all.length - 1].trim();
  // Every class name, `small` included - without it a correctly declared small task reads as
  // "no class line" and collects the very warnings the class exists to avoid. A leading `-`/`*`
  // is allowed (a declaration is often a list item); a `|` row or `>` quote is not, and neither
  // is the spec's own "a / b" enumeration, which is the file being quoted back rather than a
  // decision. A ` / ` test would have been wrong here: §0's own class names are compound
  // ("rename / signature / contract"), so a real declaration contains one.
  const arrow = text.match(
    /^(?!\s*[-*|>])[^\n]{0,160}(trivial|тривиал|small|мелк|небольш|feature|refactor|rename|signature|contract|bug|regression|perf|behavior)[^\n]{0,240}(→|->)[^\n]{0,240}$/im
  );
  return arrow ? arrow[0].trim() : "";
}

module.exports = { buildDigest, classDeclared, collectWrites, scriptTargets, bareOf, withoutHeredocs, loopBodies, sleepShape };
