// The repository as the pipeline sees it: a bounded `git`, the developer's identity, the freshest
// view of main, the reviewed marker, and the commits by others past it. Shared by the leak review
// (leak-check.js) and the parallel-work check (lib/parallel.js).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function git(args, opts) {
  try {
    return execFileSync("git", args, Object.assign({ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }, opts || {})).trimEnd();
  } catch {
    return null;
  }
}

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]);
}

function markerPath(root) {
  const gitDir = git(["rev-parse", "--git-dir"], { cwd: root }) || ".git";
  return path.resolve(root, gitDir, "leak-reviewed");
}

// Commits on origin/main past the marker whose author is not this developer. With no marker the
// base is this developer's own last commit on main: reviewing months of history is not what the
// gate is for, and HEAD is the wrong anchor (see below).
// Both the configured email AND name: squash-merges through GitHub carry the noreply address,
// so the email alone counted this developer's own PRs as foreign.
function whoAmI(root) {
  const me = (git(["config", "user.email"], { cwd: root }) || "").toLowerCase();
  const myName = (git(["config", "user.name"], { cwd: root }) || "").toLowerCase();
  return { me, myName, mine: (c) => c.email === me || (myName && c.name.toLowerCase() === myName) };
}
// The freshest view of main: the private ref `status` fetches, when it is ahead of the
// tracking ref (the project hook may or may not have fetched yet); origin/main otherwise.
function mainTip(root) {
  const tracking = git(["rev-parse", "origin/main"], { cwd: root }) || "";
  const fetched = git(["rev-parse", "--verify", "--quiet", "refs/leak-check/origin-main"], { cwd: root }) || "";
  return fetched && tracking && fetched !== tracking && git(["merge-base", "--is-ancestor", tracking, fetched], { cwd: root }) !== null
    ? fetched
    : tracking || fetched;
}
const parseLog = (txt) =>
  (txt || "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [sha, email, name, subject] = l.split("\x1f");
      return { sha, email: (email || "").toLowerCase(), name, subject };
    });
const LOG_FORMAT = "--format=%H%x1f%ae%x1f%an%x1f%s";

// The same window against another marker file: the release surface keeps its own
// acknowledgement (.git/release-surface-seen), because the leak marker moves on a leak verdict
// and a change to the release paths must stay on screen until the developer has read THAT diff.
function foreignCommits(root) {
  return foreignSince(root, markerPath(root));
}
function foreignSince(root, marker) {
  const { me, mine } = whoAmI(root);
  const tip = mainTip(root);
  const stored = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  let base = stored;
  let firstRun = false;
  // A stored marker that no longer resolves is not a first run: history was rewritten or the
  // object was dropped, and that is the moment a silent reset would hide the most. Say so.
  const markerBroken = Boolean(stored) && git(["cat-file", "-e", stored + "^{commit}"], { cwd: root }) === null;
  if (!stored || markerBroken) {
    // No marker: everything by others since THIS developer's last own commit on origin/main is
    // unreviewed. HEAD would be wrong here — the project's own session hook ff-merges
    // origin/main in the same SessionStart batch, so by the time this runs HEAD may already
    // include the very commits a first run should surface.
    const recent = parseLog(tip ? git(["log", LOG_FORMAT, "-n", "200", tip], { cwd: root }) : "");
    const lastMine = recent.find((c) => mine(c));
    base = lastMine ? lastMine.sha : git(["rev-parse", "HEAD"], { cwd: root }) || "";
    firstRun = true;
  }
  const commits = tip && base ? parseLog(git(["log", LOG_FORMAT, base + ".." + tip], { cwd: root })) : [];
  return { me, mine, base, tip, firstRun, markerBroken, all: commits, foreign: commits.filter((c) => !mine(c)) };
}

// The bounded fetch both the SessionStart hook and the by-hand modes run first. Into a PRIVATE
// ref, not origin/main: the project's own hook fetches origin/main in the same batch, and two
// fetches racing for one ref lock would make one of them fail. mainTip reads this ref when it is
// ahead of origin/main. A failed or slow fetch just leaves the ref where it was.
function fetchMain(root) {
  git(["fetch", "--quiet", "origin", "+refs/heads/main:refs/leak-check/origin-main"], { cwd: root, timeout: 6000 });
}

module.exports = { git, repoRoot, markerPath, whoAmI, mainTip, parseLog, LOG_FORMAT, foreignCommits, foreignSince, fetchMain };
