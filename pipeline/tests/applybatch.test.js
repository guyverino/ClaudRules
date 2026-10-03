// apply-batch.js: a batch of replacements lands whole or not at all. Every case is a way the
// hand-rolled patch script left the tree half-written (03.10).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { t, pipeline } = require("./_harness");
const { parseSpec, planBatch, main } = pipeline("apply-batch.js");

const nl = String.fromCharCode(10);
const spec = (...sections) => sections.join(nl);
const hunk = (file, old, neu) => ["@@@ FILE " + file, "@@@ OLD", old, "@@@ NEW", neu, "@@@ END"].join(nl);

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-batch-"));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");
// main() prints; the cases only need its exit code, so the console is muted around it.
function run(dir, text, extra = []) {
  const specFile = path.join(dir, "batch.spec");
  fs.writeFileSync(specFile, text);
  const log = console.log;
  const err = console.error;
  const said = [];
  console.log = (...a) => said.push(a.join(" "));
  console.error = (...a) => said.push(a.join(" "));
  try {
    return { code: main(["node", "apply-batch.js", specFile, "--root", dir].concat(extra)), said: said.join(nl) };
  } finally {
    console.log = log;
    console.error = err;
  }
}

{
  const dir = sandbox({ "a.rs": "let a = 1;" + nl + "let b = 2;" + nl, "b.rs": "fn x() {}" + nl });
  const r = run(dir, spec(hunk("a.rs", "let a = 1;", "let a = 10;"), hunk("b.rs", "fn x() {}", "fn y() {}")));
  t(r.code === 0 && read(dir, "a.rs").includes("let a = 10;") && read(dir, "b.rs") === "fn y() {}" + nl, "batch: every hunk matched, all written", r.code);
}
{
  // The shape that bit: the third hunk is stale, the first two files must stay as they were.
  const dir = sandbox({ "a.rs": "one" + nl, "b.rs": "two" + nl, "c.rs": "three" + nl });
  const r = run(dir, spec(hunk("a.rs", "one", "ONE"), hunk("b.rs", "two", "TWO"), hunk("c.rs", "stale", "x"), hunk("c.rs", "missing too", "y")));
  t(r.code === 1 && read(dir, "a.rs") === "one" + nl && read(dir, "b.rs") === "two" + nl, "batch: one stale hunk writes nothing", r.code);
  t(/2 problem\(s\) across 4 hunk/.test(r.said), "batch: every miss is reported at once", r.said.split(nl)[0]);
}
{
  const dir = sandbox({ "a.rs": "x();" + nl + "x();" + nl });
  const r = run(dir, hunk("a.rs", "x();", "y();"));
  t(r.code === 1 && /found 2 times/.test(r.said) && read(dir, "a.rs") === "x();" + nl + "x();" + nl, "batch: an ambiguous OLD is a miss", r.said.split(nl)[1]);
}
{
  // A stale hunk names the line its first line still sits at: the next read goes straight there.
  const dir = sandbox({ "a.rs": "fn a() {" + nl + "    body_changed();" + nl + "}" + nl });
  const r = run(dir, hunk("a.rs", "fn a() {" + nl + "    body();", "z"));
  t(/line\(s\) 1\b/.test(r.said), "batch: a miss points at the nearest line", r.said.split(nl)[1]);
}
{
  const crlf = "a\r\nb\r\nc\r\n";
  const dir = sandbox({ "w.rs": crlf });
  const r = run(dir, hunk("w.rs", "a" + nl + "b", "a" + nl + "B"));
  t(r.code === 0 && read(dir, "w.rs") === "a\r\nB\r\nc\r\n", "batch: a CRLF file keeps CRLF", JSON.stringify(read(dir, "w.rs")));
}
{
  const bs = "let p = \"C:" + String.fromCharCode(92) + "x86_64\";";
  const dir = sandbox({ "p.rs": "let p = 0;" + nl });
  const r = run(dir, hunk("p.rs", "let p = 0;", bs));
  t(r.code === 0 && read(dir, "p.rs").startsWith(bs), "batch: backslashes land verbatim", read(dir, "p.rs").slice(0, 24));
}
{
  const dir = sandbox({ "a.rs": "old" + nl });
  const r = run(dir, spec(hunk("a.rs", "old", "mid"), hunk("a.rs", "mid", "new")));
  t(r.code === 0 && read(dir, "a.rs") === "new" + nl, "batch: a later hunk sees the earlier one", read(dir, "a.rs"));
}
{
  const dir = sandbox({ "a.rs": "x" + nl });
  const created = run(dir, hunk("sub/new.rs", "", "fn n() {}"));
  t(created.code === 0 && read(dir, "sub/new.rs") === "fn n() {}" + nl, "batch: an empty OLD creates a missing file, newline-terminated", JSON.stringify(read(dir, "sub/new.rs")));
  const over = run(dir, hunk("a.rs", "", "y"));
  t(over.code === 1 && read(dir, "a.rs") === "x" + nl, "batch: an empty OLD never overwrites", over.code);
}
{
  const dir = sandbox({ "a.rs": "one" + nl });
  const r = run(dir, hunk("a.rs", "one", "two"), ["--check"]);
  t(r.code === 0 && read(dir, "a.rs") === "one" + nl, "batch: --check writes nothing", r.code);
}
{
  // A file that is not UTF-8 would come back with U+FFFD for its bytes: refused, untouched.
  const dir = sandbox({ "a.rs": "ok" + nl });
  const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0x0a]);
  fs.writeFileSync(path.join(dir, "ru.txt"), cp1251);
  const r = run(dir, spec(hunk("a.rs", "ok", "fine"), hunk("ru.txt", "x", "y")));
  t(r.code === 1 && fs.readFileSync(path.join(dir, "ru.txt")).equals(cp1251) && read(dir, "a.rs") === "ok" + nl, "batch: a non-UTF-8 file is refused, nothing written", r.said.split(nl)[1]);
}
{
  // A rename that fails part-way (here: the target is a directory) puts back what it replaced.
  const dir = sandbox({ "a.rs": "one" + nl });
  fs.mkdirSync(path.join(dir, "z.rs"));
  const r = run(dir, spec(hunk("a.rs", "one", "ONE"), hunk("z.rs", "", "x")));
  const strays = fs.readdirSync(dir).filter((f) => f.endsWith(".apply-batch.tmp"));
  t(r.code === 3 && read(dir, "a.rs") === "one" + nl && strays.length === 0, "batch: a failed rename restores and cleans up", r.code + " " + strays.join(","));
}
{
  const dir = sandbox({ "a.rs": "one" + nl });
  const specFile = path.join(dir, "b.spec");
  fs.writeFileSync(specFile, hunk("a.rs", "one", "two"));
  const err = console.error;
  console.error = () => {};
  let code;
  try {
    code = main(["node", "apply-batch.js", specFile, "--root"]);
  } finally {
    console.error = err;
  }
  t(code === 2, "cli: --root without a value is a usage error", code);
}
if (process.platform === "win32") {
  // One file, two spellings: one state, both hunks land.
  const dir = sandbox({ "a.rs": "one two" + nl });
  const r = run(dir, spec(hunk("a.rs", "one", "1"), hunk("A.RS", "two", "2")));
  t(r.code === 0 && read(dir, "a.rs") === "1 2" + nl, "batch: Windows case spellings share one file", read(dir, "a.rs"));
} else {
  const dir = sandbox({ "run.sh": "echo a" + nl });
  fs.chmodSync(path.join(dir, "run.sh"), 0o755);
  const r = run(dir, hunk("run.sh", "echo a", "echo b"));
  t(r.code === 0 && (fs.statSync(path.join(dir, "run.sh")).mode & 0o777) === 0o755, "batch: the file mode survives", r.code);
}
{
  const bad = parseSpec(["@@@ FILE a.rs", "@@@ OLD", "x", "@@@ END"].join(nl));
  t(bad.errors.length > 0, "spec: END without NEW is malformed", bad.errors[0]);
  const open = parseSpec(["@@@ FILE a.rs", "@@@ OLD", "x", "@@@ NEW", "y"].join(nl));
  t(open.errors.some((e) => /no END/.test(e)), "spec: an unclosed hunk is malformed", open.errors[0]);
  const ok = parseSpec(["note: why", hunk("a.rs", "x", "y")].join(nl));
  t(ok.errors.length === 0 && ok.files[0].hunks[0].old === "x", "spec: notes outside a hunk are ignored", ok.errors.length);
  const dir = sandbox({});
  t(planBatch(parseSpec(hunk("gone.rs", "x", "y")), dir).misses.length === 1, "plan: a missing file with an OLD is a miss", 1);
}
