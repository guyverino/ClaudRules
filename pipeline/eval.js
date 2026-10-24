#!/usr/bin/env node
// Runs the review angles against the seeded-defect battery (lib/eval-cases.js) and records what
// each one caught, missed and raised on a clean change — and verify-finding against batches of
// known real and false findings: a real one it scores under 60 is a miss of the filter. The
// ledger can only see findings that were acted on; this is the one place a MISS is counted,
// because only here is the answer known.
//
//   node eval.js                    every case (one headless agent run each — this costs tokens)
//   node eval.js --angle flow       the cases of one angle
//   node eval.js --case a,b         named cases
//   node eval.js --list             the cases, nothing run
//   node eval.js --dry              build each case and print the prompt, nothing run
//
// Each case becomes a throwaway git repo at the change's state, and the angle is run on it the way
// §6 briefs it — changed files, intent, diff, never an argument for correctness — through
// `claude -p --agent <angle>` with every hook switched off: a battery run must not write ledger
// rows, digests or reports of its own. One row per case goes to eval-results.jsonl beside the
// ledger; `node stats.js` reads the latest row per case.
//
// Exit 0 when every selected case ran (whatever it scored — this is a measurement, not a gate),
// 1 when a run failed to produce an answer, 2 on a bad command line.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { CASES } = require("./lib/eval-cases");
const { parseAgentResult } = require("./lib/ledger");
const { pipelineDir } = require("./lib/root");

const RESULTS = path.join(pipelineDir("eval"), "eval-results.jsonl");
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TOL = 2;

// The 1-based line of `text` in a case file's post-change content, or 0 when it is not there.
function siteLine(c, site) {
  const after = (c.files[site.file] || {}).after;
  if (typeof after !== "string") return 0;
  const idx = after.split("\n").findIndex((l) => l.includes(site.text));
  return idx + 1;
}

// The drop line §6 applies to verify-finding scores: under it, a finding is thrown away.
const DROP_BELOW = 60;

// Pure: a verify-finding answer on a verify case. A real finding scored under the drop line was
// thrown away — the filter's miss; a false one at or above it got through — its false alarm. A
// finding the answer gives no score for is listed in `unscored` (and is a miss when it is real);
// an answer with no score line at all is malformed. The judgement and the format are kept apart:
// `#2 · 95 · …` (the word `score` dropped) or reasoning printed around the lines still scores,
// and is recorded as `offContract` — the agent's own contract is one line per finding, nothing else.
function scoreVerify(c, answer) {
  const text = String(answer || "");
  const scores = new Map();
  for (const m of text.matchAll(/^\s*#(\d+)\s*[·|-]?\s*(?:score\s*)?(\d{1,3})\b/gim)) {
    if (!scores.has(Number(m[1]))) scores.set(Number(m[1]), Number(m[2]));
  }
  const offContract = text.split("\n").some((l) => l.trim() && !/^#\d+ · score \d{1,3} · /.test(l.trim()));
  const defects = [];
  const unscored = [];
  let falseAlarms = 0;
  c.findings.forEach((f, i) => {
    const s = scores.get(i + 1);
    if (s === undefined) unscored.push(f.id);
    if (f.real) defects.push({ id: f.id, caught: s !== undefined && s >= DROP_BELOW, score: s === undefined ? null : s });
    else if (s !== undefined && s >= DROP_BELOW) falseAlarms += 1;
  });
  return {
    defects,
    caught: defects.filter((d) => d.caught).length,
    expected: defects.length,
    extras: 0,
    falseAlarms,
    unscored,
    offContract: scores.size > 0 && offContract,
    zero: false,
    malformed: scores.size === 0,
  };
}

// Pure: what one answer scored on one case. A finding matches a site by file basename (agents cite
// relative, absolute or ./-prefixed paths) and a line within the site's tolerance.
function score(c, answer) {
  if (c.kind === "verify") return scoreVerify(c, answer);
  const parsed = parseAgentResult(String(answer || ""));
  const base = (f) => path.basename(String(f).replace(/\\/g, "/"));
  const used = new Set();
  const defects = c.defects.map((d) => {
    // A finding already credited to one defect cannot be credited to a second one as well.
    const hit = parsed.findings.findIndex((f, i) =>
      !used.has(i) &&
      d.sites.some((s) => base(f.file) === base(s.file) && Math.abs(f.line - siteLine(c, s)) <= (s.tol == null ? DEFAULT_TOL : s.tol))
    );
    if (hit !== -1) used.add(hit);
    return { id: d.id, caught: hit !== -1, severity: hit !== -1 ? parsed.findings[hit].severity : "" };
  });
  const extras = parsed.findings.filter((_, i) => !used.has(i));
  return {
    defects,
    caught: defects.filter((d) => d.caught).length,
    expected: defects.length,
    extras: extras.length,
    // On a clean control every high or medium is a false alarm; a low is noise, counted in extras.
    falseAlarms: c.clean ? extras.filter((f) => f.severity !== "low").length : 0,
    zero: parsed.zero,
    malformed: !parsed.zero && parsed.findings.length === 0,
  };
}

function git(dir, args) {
  return execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=", "-c", "init.templateDir=", "-c", "core.autocrlf=false"].concat(args),
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

// The case as a repo at its post-change state, with the change as its staged diff. The settings
// file sits OUTSIDE the tree: the reviewer must not find the harness among the code under review.
function buildCase(c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-eval-"));
  try {
    return buildIn(root, c);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

function buildIn(root, c) {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const write = (side) => {
    for (const [rel, f] of Object.entries(c.files)) {
      const p = path.join(repo, rel);
      if (typeof f[side] === "string") {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, f[side], "utf8");
      } else if (fs.existsSync(p)) fs.rmSync(p);
    }
  };
  git(repo, ["init", "-q"]);
  write("before");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "commit", "-q", "--allow-empty", "-m", "base"]);
  write("after");
  git(repo, ["add", "-A"]);
  const diff = git(repo, ["diff", "--cached", "--no-color"]);
  const changed = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const settings = path.join(root, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true }), "utf8");
  return { root, repo, diff, changed, settings, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// The prompt §6 hands verify-finding: the numbered findings, the changed files, the diff — never
// which of them are real.
function verifyPrompt(c, tree) {
  return [
    "Findings from a code review of one change, to score.",
    "",
    "Changed files:",
    ...tree.changed.map((f) => "- " + f),
    "",
    "Intent: " + c.intent,
    "",
    "The repository at the change's state is your working directory.",
    "",
    "Diff:",
    "```diff",
    tree.diff.trimEnd(),
    "```",
    "",
    "Findings:",
    ...c.findings.map((f, i) => "#" + (i + 1) + " " + f.file + ":" + siteLine(c, f) + " — " + f.claim + " — " + f.severity),
  ].join("\n");
}

function prompt(c, tree) {
  if (c.kind === "verify") return verifyPrompt(c, tree);
  return [
    "Changed files:",
    ...tree.changed.map((f) => "- " + f),
    "",
    "Intent: " + c.intent,
    "",
    "The repository at the change's state is your working directory; files not listed above are",
    "unchanged by it.",
    "",
    "Diff:",
    "```diff",
    tree.diff.trimEnd(),
    "```",
  ].join("\n");
}

// The CLI to start. On Windows the npm install is a .cmd shim, which only a shell can start — and a
// timeout would then kill that shell, not the agent under it, so the shim's own target, claude.exe,
// is looked up on PATH and started directly. A .cmd/.bat (the shim itself, or a CLAUDE_BIN override)
// still goes through the shell as the last resort.
function resolveBin() {
  if (process.env.CLAUDE_BIN) return { bin: process.env.CLAUDE_BIN, shell: /\.(cmd|bat)$/i.test(process.env.CLAUDE_BIN) };
  if (process.platform !== "win32") return { bin: "claude", shell: false };
  for (const dir of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const exe of [path.join(dir, "claude.exe"), path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")]) {
      if (fs.existsSync(exe)) return { bin: exe, shell: false };
    }
  }
  return { bin: "claude", shell: true };
}

// One headless run of the named agent. Every token of a shell command line is ours (the agent name
// from the case table, a temp path) and quoted; the prompt itself travels on stdin, never through a
// shell. MCP servers are left out: the angles only read files.
function runAgent(angle, input, cwd, settings) {
  if (!/^[a-z-]+$/.test(angle)) throw new Error("bad angle name " + angle);
  const args = ["-p", "--agent", angle, "--settings", settings, "--strict-mcp-config", "--no-session-persistence", "--output-format", "json"];
  const { bin, shell } = resolveBin();
  const opts = { cwd, input, encoding: "utf8", timeout: RUN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 };
  const r = shell
    ? spawnSync([bin].concat(args).map((a) => '"' + a + '"').join(" "), Object.assign({ shell: true }, opts))
    : spawnSync(bin, args, opts);
  if (r.error) return { error: r.error.code || String(r.error) };
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return { error: "exit " + (r.signal || r.status) + ": " + String(r.stderr || r.stdout || "").trim().split("\n")[0] };
  }
  // The CLI puts the reason of a failed run (login, limit) in the JSON result, not on stderr: read
  // it before the exit status, or a non-zero exit is recorded with no reason at all.
  if (out.is_error || r.status !== 0 || r.signal) {
    const why = String(out.result || out.subtype || r.stderr || "is_error").trim().split("\n")[0];
    return { error: (r.status !== 0 || r.signal ? "exit " + (r.signal || r.status) + ": " : "") + why };
  }
  const u = out.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  return { text: String(out.result || ""), ms: out.duration_ms || 0, tokens };
}

function select(args) {
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : args[at + 1] || "";
  };
  const angle = valueOf("--angle");
  const names = valueOf("--case");
  if (angle === "" || names === "") return null;
  let picked = CASES;
  if (angle) picked = picked.filter((c) => c.angle === angle);
  if (names) {
    const want = names.split(",").map((s) => s.trim());
    const unknown = want.filter((n) => !CASES.some((c) => c.id === n));
    if (unknown.length) {
      process.stderr.write("eval: unknown case " + unknown.join(", ") + "\n");
      return null;
    }
    picked = picked.filter((c) => want.includes(c.id));
  }
  return picked;
}

function main() {
  const args = process.argv.slice(2);
  const picked = select(args);
  if (!picked || !picked.length) {
    process.stderr.write("eval: nothing selected (see --list)\n");
    process.exit(2);
  }
  if (args.includes("--list")) {
    for (const c of picked) {
      const what = c.kind === "verify"
        ? c.findings.length + " finding(s), " + c.findings.filter((f) => f.real).length + " real"
        : c.clean ? "clean" : c.defects.length + " defect(s)";
      console.log(c.id.padEnd(22) + c.angle.padEnd(16) + what);
    }
    return;
  }
  const dry = args.includes("--dry");
  let failed = 0;
  let inARow = 0;
  for (const c of picked) {
    // Two failed runs in a row is a limit, an expired login or a broken install, not two bad cases:
    // every further case would only write one more error row.
    if (inARow >= 2) {
      console.log("\nstopped: two runs in a row failed — fix the cause, then re-run the rest with --case.");
      break;
    }
    let tree;
    try {
      tree = buildCase(c);
    } catch (e) {
      failed += 1;
      inARow += 1;
      console.log(c.id.padEnd(22) + c.angle.padEnd(16) + "CASE BUILD FAILED — " + String(e.message || e).split("\n")[0]);
      if (!dry) fs.appendFileSync(RESULTS, JSON.stringify({ ts: new Date().toISOString(), case: c.id, angle: c.angle, clean: !!c.clean, error: "build: " + String(e.message || e).split("\n")[0] }) + "\n", "utf8");
      continue;
    }
    try {
      const input = prompt(c, tree);
      if (dry) {
        inARow = 0;
        console.log("=== " + c.id + " (" + c.angle + ")\n" + input + "\n");
        continue;
      }
      const run = runAgent(c.angle, input, tree.repo, tree.settings);
      const row = { ts: new Date().toISOString(), case: c.id, angle: c.angle, clean: !!c.clean };
      if (run.error) {
        failed += 1;
        inARow += 1;
        Object.assign(row, { error: run.error });
        console.log(c.id.padEnd(22) + c.angle.padEnd(16) + "RUN FAILED — " + run.error);
      } else {
        inARow = 0;
        const s = score(c, run.text);
        Object.assign(row, s, { ms: run.ms, tokens: run.tokens, answer: run.text.slice(0, 4000) });
        // An answer outside the contract is neither a miss nor a clean pass: stats.js leaves it
        // unscored and lists it, so a polluted run cannot pose as a result either way.
        const missed = s.defects.filter((d) => !d.caught).map((d) => d.id).join(", ");
        const verdict = s.malformed
          ? "MALFORMED — unscored"
          : c.clean
          ? s.falseAlarms ? s.falseAlarms + " FALSE ALARM(S)" : "clean held"
          : c.kind === "verify"
          ? s.caught + "/" + s.expected + " real kept" + (missed ? " — DROPPED " + missed : "") +
            (s.falseAlarms ? " · " + s.falseAlarms + " FALSE KEPT" : "") + (s.unscored.length ? " · unscored " + s.unscored.join(", ") : "") +
            (s.offContract ? " · off-contract" : "")
          : s.caught + "/" + s.expected + " caught" + (missed ? " — MISSED " + missed : "");
        console.log(c.id.padEnd(22) + c.angle.padEnd(16) + verdict + (c.kind === "verify" ? "" : " · extras " + s.extras) + " · " + Math.round(run.ms / 1000) + "s");
      }
      fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n", "utf8");
    } finally {
      tree.remove();
    }
  }
  if (!dry) console.log("\nrows appended to " + RESULTS + " — `node stats.js` shows the latest per case.");
  process.exit(failed ? 1 : 0);
}

module.exports = { score, scoreVerify, siteLine, buildCase, prompt, resolveBin, DROP_BELOW, RESULTS };

if (require.main === module) main();
