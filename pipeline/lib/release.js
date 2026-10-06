// The release surface: the paths that decide what users download and run as an update — the
// release workflow and the scripts it calls, the contract test that pins the publish gate, the
// in-app updater with its digest check. A change there by anyone else is how a release gets
// something built into it that the source never showed; the project declares the list in a
// `## Release surface` section of its repo file (lib/repofile.js), and this module answers one
// question for it: which commits by others, and which open pull requests, touched a declared
// path and have not been read by this developer yet.
//
// Two windows, two readers. Commits on the watched branch (origin/main, or the one the clone names
// in `git config leakcheck.branch`) are judged against a marker of their own,
// `.git/release-surface-seen` (per branch, `branchKey`; `leak-check.js ack-release` moves it): the leak marker moves on a
// leak VERDICT, and a release-path change must stay on screen until this developer has read that
// diff by hand, verdict or not. Open pull requests have no marker — one stays on screen for as
// long as it is open, which is the point. Nothing here is a verdict: the lines say WHAT to read.

const fs = require("fs");
const path = require("path");
const { git, foreignSince, upstream, branchKey } = require("./git");
const { section, backticked } = require("./repofile");

const HEADING = "Release surface";

function releaseMarkerPath(root) {
  const gitDir = git(["rev-parse", "--git-dir"], { cwd: root }) || ".git";
  return path.resolve(root, gitDir, "release-surface-seen" + branchKey(upstream(root).branch));
}

// A backticked entry is a path pattern when it looks like one: a separator or a dot
// (`.github/`, `Cargo.lock`, `*.sh`). Prose in backticks (`high`, `main`, `v*`) is left
// alone. A name with no `/` in it (`release.yml`, `*.sh`) matches at ANY depth — that is what a
// bare file name means to a reader, and root-only would silently match nothing for a file that
// lives in a folder; `./release.yml` pins it to the root, and `./Makefile` is how a bare name
// without a dot is declared at all. A trailing `/` means "and everything below"; `*` matches
// within one path segment, `**` across segments. Matching is on the repo-relative path with
// forward slashes, the way git names files.
function releasePatterns(sections) {
  const out = [];
  for (const raw of backticked(sections)) {
    const forced = raw.startsWith("./");
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p || /\s/.test(p) || !(forced || /[\/.]/.test(p))) continue;
    let re = forced || p.includes("/") ? "" : "(?:.*/)?";
    for (let i = 0; i < p.length; i += 1) {
      const ch = p[i];
      if (ch === "*") {
        if (p[i + 1] === "*") {
          re += ".*";
          i += 1;
        } else re += "[^/]*";
      } else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
    if (p.endsWith("/")) re += ".*";
    out.push({ raw, re: new RegExp("^" + re + "$") });
  }
  return out;
}

function matchRelease(files, patterns) {
  return (files || []).filter((f) => patterns.some((p) => p.re.test(f.replace(/\\/g, "/"))));
}

// Commits by others past the release marker that touched a declared path, each with only the
// files that matched. `unknown` when git could not answer — an empty list on a failed log would
// be a false "nobody touched it". One bounded log call carries the files (`--name-only`).
function releaseChanges(root, base) {
  const sections = section(root, base, HEADING);
  const patterns = releasePatterns(sections);
  if (!patterns.length) return { declared: false, sections, patterns, commits: [], marker: "" };
  const marker = releaseMarkerPath(root);
  const f = foreignSince(root, marker);
  // No marker yet: the base is this developer's last own commit on the watched branch — and it is PINNED here,
  // now. Left floating, the developer's own next merge on top of a foreign release-path change
  // would move the base past it and the line would vanish with nothing acknowledged: exactly the
  // commit this check exists to keep on screen. A marker that does NOT resolve is never
  // rewritten: `cat-file` failing can be a transient git error (a lock held by another session's
  // fetch) as easily as a rewritten history, and re-pinning on it at "my last own commit" once
  // moved this marker past an unread foreign change on the very day it was written. The
  // fallback base is recomputed each run and the line says so until `ack-release` writes a tip.
  if (f.firstRun && !f.markerBroken && f.base) fs.writeFileSync(marker, f.base + "\n", "utf8");
  if (!f.foreign.length) return { declared: true, sections, patterns, commits: [], marker, tip: f.tip, base: f.base, firstRun: f.firstRun, markerBroken: f.markerBroken };
  // `--diff-merges=first-parent`: without it a merge commit lists NO files, and a change that
  // reached the watched branch through a merge (an "evil merge" resolution included) would be invisible here.
  const out = git(["log", "--format=%x1e%H", "--name-only", "--diff-merges=first-parent", f.base + ".." + f.tip], { cwd: root, timeout: 8000 });
  if (out === null) return { declared: true, sections, patterns, commits: [], marker, tip: f.tip, base: f.base, unknown: true, markerBroken: f.markerBroken, remote: upstream(root).remote };
  const filesOf = new Map();
  for (const block of out.split("\x1e").slice(1)) {
    const [sha, ...rest] = block.split("\n");
    filesOf.set(sha.trim(), rest.filter(Boolean));
  }
  const commits = [];
  for (const c of f.foreign) {
    const files = matchRelease(filesOf.get(c.sha) || [], patterns);
    if (files.length) commits.push(Object.assign({}, c, { files }));
  }
  return { declared: true, sections, patterns, commits, marker, tip: f.tip, base: f.base, firstRun: f.firstRun, markerBroken: f.markerBroken };
}

// Open pull requests (lib/parallel.js openPRs result) that touch a declared path. A PR whose
// file list gh capped is reported as such: the untouched-looking remainder is unknown.
function releasePRs(prs, patterns) {
  if (!prs || !patterns.length) return [];
  const out = [];
  for (const pr of prs) {
    const files = matchRelease(pr.files, patterns);
    if (files.length || pr.filesCapped) out.push({ number: pr.number, author: pr.author, branch: pr.branch, files, filesCapped: pr.filesCapped });
  }
  return out;
}

// The lines the SessionStart hook and `others` print — empty when nothing is pending, never a
// reassuring "release surface clean": silence is the normal state, the line is the alarm.
// `prs` is `null` when gh could not answer, and that is said, because "no PR touches it" and
// "could not list PRs" must not read the same.
function releaseLines(rel, prs, prsWhy, script) {
  const out = [];
  if (!rel.declared) return "";
  if (rel.markerBroken) out.push("RELEASE SURFACE: the stored marker (" + rel.marker + ") did not resolve this run — git failed, history rewritten or object dropped; the window below starts at your last own commit " + (rel.base || "").slice(0, 8) + " and this line repeats until ack-release writes a tip.");
  if (rel.unknown) out.push("RELEASE SURFACE: UNKNOWN — git log failed or timed out; read " + (rel.remote || "origin/main") + " by hand for " + rel.patterns.map((p) => p.raw).join(", ") + ".");
  for (const c of rel.commits) out.push("RELEASE SURFACE CHANGED by " + c.name + " — " + c.sha.slice(0, 8) + " " + c.subject.slice(0, 70) + " — " + c.files.join(", "));
  if (rel.commits.length) {
    out.push(
      "  ^ paths the project declares as its release surface (what users install). Read each diff by hand — git show <sha> -- <file> — before any build, publish or release from this tree; " +
        'then node "' + script + '" ack-release. Not a leak verdict: `mark` does not clear this line (rules §5).'
    );
  }
  if (prs === null) out.push("RELEASE SURFACE in open PRs: UNKNOWN (" + prsWhy + ") — read the open pull requests on the forge for " + rel.patterns.map((p) => p.raw).join(", ") + ".");
  else for (const pr of releasePRs(prs, rel.patterns)) {
    out.push("RELEASE SURFACE in open PR #" + pr.number + " by " + pr.author + " (" + pr.branch + ") — " + (pr.files.length ? pr.files.join(", ") : "(no declared path in the first 100 files)") + (pr.filesCapped ? " — file list capped by the API at 100: read the PR's full file list on the forge" : ""));
  }
  return out.length ? out.join("\n") + "\n" : "";
}

function ackRelease(root, tip) {
  const marker = releaseMarkerPath(root);
  fs.writeFileSync(marker, tip + "\n", "utf8");
  return marker;
}

module.exports = { HEADING, releaseMarkerPath, releasePatterns, matchRelease, releaseChanges, releasePRs, releaseLines, ackRelease };
