// The repository as the pipeline sees it: a bounded `git`, the developer's identity, the freshest
// view of the watched branch (main unless the clone names another — `upstream`), the reviewed
// marker, and the commits by others past it. Shared by the leak review (leak-check.js) and the
// parallel-work check (lib/parallel.js).

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

// Per-branch names for the markers and the private fetch ref. main keeps the names earlier
// versions wrote, so an existing clone loses nothing; any other branch gets its name hex-encoded:
// a marker left at a tip of one branch must not judge another (it would pass the shared history
// as reviewed, or flood the window with the non-shared one), and a flat encoded name cannot clash
// — no `foo` vs `foo/bar` directory/file conflict, no `main/x` under the `origin-main` ref, and
// `Foo` vs `foo` stay apart on a case-insensitive file system that would share one loose ref.
const branchKey = (branch) => (branch === "main" ? "" : "-" + Buffer.from(branch, "utf8").toString("hex"));

function markerPath(root) {
  const gitDir = git(["rev-parse", "--git-dir"], { cwd: root }) || ".git";
  return path.resolve(root, gitDir, "leak-reviewed" + branchKey(upstream(root).branch));
}

// Commits on the watched branch (origin/main unless `upstream` says otherwise) past the marker
// whose author is not this developer. With no marker the base is this developer's own last
// commit there: reviewing months of history is not what the
// gate is for, and HEAD is the wrong anchor (see below).
// Both the configured email AND name: squash-merges through GitHub carry the noreply address,
// so the email alone counted this developer's own PRs as foreign.
function whoAmI(root) {
  const me = (git(["config", "user.email"], { cwd: root }) || "").toLowerCase();
  const myName = (git(["config", "user.name"], { cwd: root }) || "").toLowerCase();
  return { me, myName, mine: (c) => c.email === me || (myName && c.name.toLowerCase() === myName) };
}
// The branch the gates watch: origin/main, unless this clone names another one in
// `git config leakcheck.branch`. Work based on a long-lived branch (a port cut from a feature
// branch that never merged to main) builds THAT branch: watching main there flags code that
// never enters the build and leaves the built branch unwatched. Per clone on purpose, like the
// markers: a foreign commit cannot redirect the review, as it could by editing a tracked repo
// file. A value git would not accept as a branch name is reported as `invalid` — the callers
// say so rather than fall back to main, which would be the very false clean this exists to end.
function upstream(root) {
  const raw = (git(["config", "--get", "leakcheck.branch"], { cwd: root }) || "").trim();
  const branch = raw || "main";
  const invalid = branch.startsWith("-") || git(["check-ref-format", "refs/heads/" + branch], { cwd: root }) === null;
  return {
    branch,
    configured: Boolean(raw),
    invalid,
    remote: "origin/" + branch,
    privateRef: branch === "main" ? "refs/leak-check/origin-main" : "refs/leak-check/origin" + branchKey(branch),
  };
}
// The freshest view of the watched branch: the private ref `status` fetches, when it is ahead of
// the tracking ref (the project hook may or may not have fetched yet); the tracking ref otherwise.
function upstreamTip(root) {
  const up = upstream(root);
  if (up.invalid) return "";
  const tracking = git(["rev-parse", "--verify", "--quiet", up.remote], { cwd: root }) || "";
  const fetched = git(["rev-parse", "--verify", "--quiet", up.privateRef], { cwd: root }) || "";
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
// acknowledgement (.git/release-surface-seen, per branch like this one), because the leak marker moves on a leak verdict
// and a change to the release paths must stay on screen until the developer has read THAT diff.
function foreignCommits(root) {
  return foreignSince(root, markerPath(root));
}
function foreignSince(root, marker) {
  const { me, mine } = whoAmI(root);
  const tip = upstreamTip(root);
  const stored = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
  let base = stored;
  let firstRun = false;
  // A stored marker that no longer resolves is not a first run: history was rewritten or the
  // object was dropped, and that is the moment a silent reset would hide the most. Say so.
  const markerBroken = Boolean(stored) && git(["cat-file", "-e", stored + "^{commit}"], { cwd: root }) === null;
  if (!stored || markerBroken) {
    // No marker: everything by others since THIS developer's last own commit on the watched
    // branch is unreviewed. HEAD would be wrong here — the project's own session hook may
    // ff-merge that branch in the same SessionStart batch, so by the time this runs HEAD may
    // already include the very commits a first run should surface.
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
// fetches racing for one ref lock would make one of them fail. upstreamTip reads this ref when it is
// ahead of origin/main. A failed or slow fetch leaves the ref where it was — and returns false, so
// a caller watching a configured branch can say its tip may be stale (deleted on origin, or
// offline) instead of reading a frozen ref as current. The watched branch (`upstream`).
function fetchUpstream(root) {
  const up = upstream(root);
  if (up.invalid) return false;
  return git(["fetch", "--quiet", "origin", "+refs/heads/" + up.branch + ":" + up.privateRef], { cwd: root, timeout: 6000 }) !== null;
}

module.exports = { git, repoRoot, markerPath, branchKey, whoAmI, upstream, upstreamTip, parseLog, LOG_FORMAT, foreignCommits, foreignSince, fetchUpstream };
