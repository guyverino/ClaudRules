// What the checker knows about toolchains: which shell commands are a build, a test-suite run, a
// formatter, and which files are code. One table, so a new stack is one edit here and nowhere
// else. The patterns are judged on the FULL command at digest time (see digest.js); the stored
// copy of a command is truncated to 300 characters.

// Longest first: an unanchored alternation would match "js" inside "json" and record notes.json
// as notes.js - a digest naming files that do not exist. The (?![A-Za-z0-9]) guards in digest.js
// finish the job for the target patterns.
const CODE_EXT = "tsx|jsx|json|yaml|yml|toml|cpp|java|ps1|rs|ts|js|py|go|kt|cs|rb|php|sh|md|c|h";

// A test-suite run, as distinct from a build: the count of these is what §6 bounds. `cargo test`
// with a `--test <name>` or `-p` narrowing still counts — the point is the habit, not the size.
const TEST_RUN_RE = /\b(cargo\s+test|npm\s+test|pnpm\s+test|yarn\s+test|pytest|go\s+test|dotnet\s+test)\b/i;
// `tested-tree.js check -- cargo test …` NAMES the suite to ask whether this tree already passed
// it; nothing runs. Cut out before TEST_RUN_RE, on the full text — the quoted script path the
// clause hangs off is blanked by the quote stripping. Only the clause AFTER the path goes: eating
// the path's closing quote left the quotes unbalanced, and the quote stripping then blanked a
// real `cargo test` chained after the check. `tested-tree.js run -- …` is a real run and stays.
const TREE_CHECK_RE = /(?<=tested-tree\.js["']?)\s+check\b[^;&|\n]*/gi;
const withoutTreeChecks = (text) => String(text || "").replace(TREE_CHECK_RE, " ");
// What puts a different tree under the next test run: §6 bounds the suite per tree, not per task.
// `(?![\w-])`: `git merge-base` and `git checkout-index` move nothing.
const TREE_MOVE_RE = /\bgit\s+(?:pull|rebase|merge|switch|checkout|stash\s+pop)(?![\w-])(?![^\n;&|]*--abort)/;
// The formatter, as §5 wants it: once before the build. Rust only for now — that is where the CI
// job is blocking and where a PR went red twice for want of one run.
const FMT_RE = /\b(cargo\s+fmt|rustfmt)\b/i;
const BUILD_RE = /\b(cargo\s+(build|test|check|clippy)|npm\s+(run|test|ci)\b|pnpm\s|yarn\s|pytest\b|go\s+(build|test)|make\s|dotnet\s+(build|test)|gradle\s|mvn\s|tsc\b|ruff\b|eslint\b|node\s+(--check|-c)\b)/i;
// Shaders, scripts and extensionless build files are code too: a .wgsl edit demanding no build
// and no reviewer is exactly the silent pass this checker exists to prevent.
const CODE_FILE_RE = new RegExp(
  "\\.(?:" + CODE_EXT + "|wgsl|frag|vert|glsl|hlsl|bat|psm1|sql)$" +
    "|(?:^|[\\\\/])(?:Makefile|Dockerfile|Cargo\\.lock)$",
  "i"
);
// §9 counts the post-review edits in files of CODE: a fix, its test and a doc are three files
// and fired the delta pass on nearly every task (R5: 60 runs, 7 high). A test file and a document
// are not code for THAT count (CODE_FILE_RE still calls a .md "code" for the build/review gates —
// an edited doc deserves a reviewer, but it does not widen a delta). Test files by the common
// conventions: a `tests/` `test/` `__tests__/` `benches/` `examples/` `docs/` folder anywhere
// (either separator — the digest stores paths as the tool gave them, backslashes included);
// `spec/` only at the root, since `src/spec/parser.rs` is a module; a `.test.` / `.spec.` /
// `_test.` name; and a bare sibling `tests.rs` / `test.rs`, this project's own Rust convention.
// The signature trigger stays the orchestrator's own call.
const TEST_OR_DOC_RE = /(?:^|[\\/])(?:tests?|__tests__|docs?|benches?|examples?)[\\/]|^specs?[\\/]|(?:[._-](?:test|tests|spec)|_test)\.[a-z]+$|(?:^|[\\/])tests?\.rs$|\.(?:md|txt|rst|adoc)$/i;
// A scratch file is not the project: writing one must not make a research task look like code.
// No leading separator required: a relative target like tmp/notes.json is scratch too.
const SCRATCH_RE = /(?:^|[\\/])(?:scratchpad|temp|tmp|\.claude[\\/]pipeline)[\\/]/i;

// The pipeline's own commands, classified the same way: a leak `mark`, the §1 parallel check,
// a mid-task pull. Judged on the FULL command, like build/test/fmt: a `mark` chained after a long
// `diff --out …` would fall past the 300-character stored copy.
const LEAK_MARK_RE = /leak-check\.js"?\s+mark\b/;
// §1's parallel-work check: the `others` mode, or listing the open PRs directly on the forge.
// `gh pr view <n>` is NOT it — one already-known PR is not a comparison against everything open.
const OTHERS_RE = /leak-check\.js"?\s+others\b|\bgh\s+pr\s+list\b/;
// A mid-task pull brings in what others landed since the session started: the §1 gate re-arms.
// `--abort` undoes one, and brings nothing in; `fetch` is in the rule's own list of triggers.
const PULL_RE = /\bgit\s+(?:pull|rebase|merge|fetch)\b(?![^\n;&|]*--abort)/;
// §5's release-surface gate: the acknowledgement that the RELEASE SURFACE diffs were read by
// hand, and the shapes of "shipping" that must not come before it — a push, a merge on the forge,
// a release created or uploaded. A build is judged by BUILD_RE like the leak gate.
const RELEASE_ACK_RE = /leak-check\.js"?\s+ack-release\b/;
const SHIP_RE = /\bgit\s+push\b|\bgh\s+(?:pr\s+merge|release\s+(?:create|upload|edit))\b/;

// Which agents are review angles and which are support: the checker counts the former as a
// fired angle, the ledger scores them; a support agent (a per-finding filter, the delta pass)
// is measured for cost only. One list, or a new angle is counted by one and not the other.
const REVIEW_AGENTS = new Set(["flow", "half-fix", "contracts", "error-paths", "seams", "external-data", "value-integrity", "type-design", "tests"]);
const SUPPORT_AGENTS = new Set(["fix-diff", "verify-finding"]);

// A literal for a RegExp source.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// §6 bounds the FULL suite at one run per task (two tolerated); a targeted run on one failing case
// between edits is the build-equivalent, and counting it as a suite run made the WARN fire on
// every task and taught the orchestrator to explain it away (33 runs on one feature: 8 full, the
// rest targeted).
// A cargo run is targeted when a bare word follows the subcommand that is neither an option nor
// an option's value: `cargo test -p moon-chart hvol` is targeted, `cargo test -p moon-core --lib`,
// `--workspace` and `cargo test $t` (a loop over targets) are full runs of what they name.
// `--no-run` compiles the test targets and runs nothing: a build, so it is never a suite run — and
// §9 allows the build beside fix-diff, which a "full" reading of it would flag.
// Other stacks: unknown shape, counted as full — the conservative side for a bound.
const CARGO_VALUE_OPTS = new Set([
  "-p", "--package", "--target", "--test", "--bin", "--example", "--bench", "--features", "--profile",
  "--manifest-path", "-j", "--jobs", "--exclude", "--target-dir", "--color", "--message-format", "-Z", "--config",
]);
const CARGO_TEST_CLAUSE_RE = /\bcargo\s+test\b([^;&|\n]*)/i;
function testTargeted(command) {
  const m = String(command || "").match(CARGO_TEST_CLAUSE_RE);
  if (!m) return false;
  const tokens = m[1].trim().split(/\s+/).filter(Boolean);
  const sep = tokens.indexOf("--"); // past it the words belong to the test binary, not to cargo
  if (tokens.slice(0, sep === -1 ? tokens.length : sep).includes("--no-run")) return true;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (CARGO_VALUE_OPTS.has(tok)) {
      i += 1; // its value
      continue;
    }
    if (tok.startsWith("-")) continue; // a flag, `--opt=value`, or the `--` separator
    if (/[<>$`]/.test(tok)) continue; // a redirect, or a variable whose scope the text cannot show
    return true;
  }
  return false;
}
// The identity of a test run, for "the same command again with no edit in between": the test
// clause (cargo, or any runner TEST_RUN_RE knows) with its whitespace collapsed and the redirect
// tail dropped. Other stacks get a key too, or the repeat gate would be cargo-only in silence.
const TEST_CLAUSE_RE = new RegExp(TEST_RUN_RE.source + "[^;&|\\n]*", "i");
function testKey(command) {
  const m = String(command || "").match(TEST_CLAUSE_RE);
  return m ? m[0].replace(/\s*\d?[<>].*$/, "").replace(/\s+/g, " ").trim().toLowerCase() : "";
}

module.exports = { CODE_EXT, TEST_RUN_RE, withoutTreeChecks, TREE_MOVE_RE, FMT_RE, BUILD_RE, CODE_FILE_RE, TEST_OR_DOC_RE, SCRATCH_RE, LEAK_MARK_RE, OTHERS_RE, PULL_RE, RELEASE_ACK_RE, SHIP_RE, REVIEW_AGENTS, SUPPORT_AGENTS, escapeRe, testTargeted, testKey };
