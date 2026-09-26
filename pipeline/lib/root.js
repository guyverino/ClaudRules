// The root every pipeline path hangs off. A hook cannot be given arguments freely, so the env var
// is the one that matters in practice; --prefix exists for a by-hand or sandboxed run. Overriding
// HOME is NOT enough: on Windows os.homedir() reads USERPROFILE, which is how a "sandboxed" check
// silently exercised the live installation.
//
// One resolver for every script: gate-check and the ledger used to carry the same fourteen lines
// each, differing only in the name they printed.

const path = require("path");
const os = require("os");

// `who` names the caller in the two stderr notes. A relative root would resolve against whatever
// directory the turn happened to run in, so a digest or a ledger row would land somewhere nobody
// looks. Only an absolute path overrides the home — and a --prefix with no value at all is
// announced, not silently ignored: a sandbox run that quietly falls back to the live home writes
// exactly where it was told not to.
function pipelineRoot(who) {
  const tag = who || "pipeline";
  const at = process.argv.indexOf("--prefix");
  const fromArg = at !== -1 ? process.argv[at + 1] : "";
  const fromEnv = process.env.CLAUDE_PIPELINE_HOME || "";
  if (at !== -1 && !fromArg) process.stderr.write(tag + ": --prefix given with no value; using the home directory\n");
  for (const cand of [fromArg, fromEnv]) {
    if (cand && path.isAbsolute(cand)) return cand;
    if (cand) process.stderr.write(tag + ": ignoring relative pipeline root " + cand + "\n");
  }
  return os.homedir();
}

// ~/.claude/pipeline under that root: where digests, reports, the ledger and the markers live.
function pipelineDir(who) {
  return path.join(pipelineRoot(who), ".claude", "pipeline");
}

// Every .js the pipeline is made of, relative to its folder: the entry points, lib/, tests/.
// A scan, not a list, so a new module cannot be forgotten by the bundle or the export; the
// price is that a stray script left in these folders travels too, and the commit diff is where
// it shows. Used by make-bundle.js and export-rules.js — one folder list, not two.
function pipelineScripts(pipeDir) {
  const fs = require("fs");
  return ["", "lib", "tests"].flatMap((sub) => {
    const dir = path.join(pipeDir, sub);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => (sub ? sub + "/" + f : f));
  });
}

module.exports = { pipelineRoot, pipelineDir, pipelineScripts };
