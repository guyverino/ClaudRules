// The stack table: which files are code.

const { t, pipeline } = require("./_harness");
const { CODE_FILE_RE } = pipeline("lib/stacks.js");

// --- CODE_FILE_RE: extension precedence and non-obvious code -------------------------------
[
  ["notes.json", true, "json not truncated to js"],
  ["shader.wgsl", true, "shader counts as code"],
  ["Makefile", true, "extensionless build file"],
  ["photo.png", false, "asset is not code"],
].forEach(([file, exp, label]) => {
  t(CODE_FILE_RE.test(file) === exp, "codefile: " + label, CODE_FILE_RE.test(file));
});

// --- cargo test: full suite vs a targeted run, and the identity a repeat is judged on ----------
{
  const { testTargeted, testKey } = pipeline("lib/stacks.js");
  [
    ["cargo test -p moon-chart --target x86_64-pc-windows-msvc hvol 2>&1 | tail -3", true, "name filter after options"],
    ["cargo test -p moon-core --lib profile", true, "filter after --lib"],
    ["cargo test -p a --test theme_contract every_backend_draws", true, "filter after --test <name>"],
    ["cargo test --workspace --target x86_64-pc-windows-msvc 2>&1", false, "workspace is full"],
    ["cargo test -p moon-core --target x86_64-pc-windows-msvc --lib", false, "a crate's lib is full"],
    ["cargo test -p a --test theme_contract 2>&1", false, "one test target is full"],
    ["for t in a b; do cargo test $t --target x 2>&1; done", false, "a variable is not a filter"],
    ["cargo test -p a -- --nocapture", false, "harness flags are not a filter"],
    ["cargo build -p a", false, "not a test at all"],
  ].forEach(([cmd, exp, label]) => t(testTargeted(cmd) === exp, "targeted: " + label, testTargeted(cmd)));
  t(testKey("cargo test -p moon-chart   hvol 2>&1 | tail -3") === testKey("cargo test -p moon-chart hvol 2>/dev/null"), "testkey: redirect tail and spacing ignored", testKey("cargo test -p moon-chart   hvol 2>&1 | tail -3"));
  t(testKey("cargo test -p a x") !== testKey("cargo test -p a y"), "testkey: a different filter is a different run", true);
  t(testKey("ls") === "", "testkey: no cargo test, no key", JSON.stringify(testKey("ls")));
}
{
  const { testKey } = pipeline("lib/stacks.js");
  t(testKey("cd x && pytest tests/test_a.py -k foo 2>&1 | tail") === "pytest tests/test_a.py -k foo", "testkey: other runners get a key too", testKey("cd x && pytest tests/test_a.py -k foo 2>&1 | tail"));
}
{
  const { testTargeted, testKey } = pipeline("lib/stacks.js");
  const { withoutHeredocs } = pipeline("lib/digest.js");
  // Quotes kept: a quoted filter is a filter and a different one is a different run.
  t(testTargeted(withoutHeredocs('cargo test -p a --features "x y" hvol')) === true, "targeted: a quoted option value does not swallow the filter", true);
  t(testTargeted(withoutHeredocs('cargo test -p a "mod::case"')) === true, "targeted: a quoted filter is a filter", true);
  t(testKey('cargo test -p a "x::y"') !== testKey('cargo test -p a "x::z"'), "testkey: quoted filters differ", true);
  t(withoutHeredocs("python - <<'EOF'\ncargo test mention\nEOF\ncargo test -p a hvol").indexOf("mention") === -1, "heredoc: body stripped, quotes kept", true);
}
