// Parallel work: what others landed on the watched branch (main, or `git config leakcheck.branch`)
// since this developer's last own commit, and what they have open — the input of rules §1 ("do
// not build what someone already built"). The `others` mode prints the full report; the
// SessionStart hook prints one line through statusLine.

const { execFileSync } = require("child_process");
const { git, whoAmI, upstream, upstreamTip, parseLog, LOG_FORMAT } = require("./git");

// --- parallel work ---------------------------------------------------------------------------
// The window is "since my last own commit on the watched branch", not the leak marker: when I last published I
// had rebased onto everything before it, so that is the last point where I knew what others were
// doing. Newest first. A repo where nobody else commits returns nothing — that IS the test for
// "a repo with other contributors"; no configuration says so.
const OTHERS_WINDOW = 300;
// The file list is opt-in (`others` mode) and capped at FILES_CAP commits: the SessionStart hook
// prints subjects only, and every git call here is bounded — the hook must never hold the
// session. `othersInWindow` counts commits by others anywhere in the
// window: THAT is the "repo with other contributors" test, not the count since my last commit,
// which is legitimately zero right after I publish.
const FILES_CAP = 100;
function othersSince(root, opts) {
  const o = opts || {};
  const mine = o.mine || whoAmI(root).mine;
  const tip = o.tip || upstreamTip(root);
  if (!tip) return { commits: [], ownFound: true, window: 0, othersInWindow: 0, filesCapped: false };
  const bounded = { cwd: root, timeout: 4000 };
  // One log call carries the files too (`--name-only`, records separated by \x1e): a `diff-tree`
  // per commit cost 1.5 s for a hundred of them, one log costs the same as without the files.
  const withFiles = Boolean(o.files);
  const args = ["log", withFiles ? "--format=%x1e" + LOG_FORMAT.slice("--format=".length) : LOG_FORMAT, "-n", String(OTHERS_WINDOW)];
  // A merge commit lists no files without `--diff-merges`; first-parent is what it brought to main.
  if (withFiles) args.push("--name-only", "--diff-merges=first-parent");
  args.push(tip);
  let logOut = git(args, withFiles ? { cwd: root, timeout: 8000 } : bounded);
  // The file listing is the expensive half: when it times out, the subjects alone are still
  // worth having (that is all the hook ever prints), so fall back to the plain log and report
  // the files as unknown rather than the whole window.
  let filesUnknown = false;
  if (logOut === null && withFiles) {
    filesUnknown = true;
    logOut = git(["log", LOG_FORMAT, "-n", String(OTHERS_WINDOW), tip], bounded);
  }
  // A failed or timed-out log is not an empty one: "0 commits by others" would be a false clean.
  if (logOut === null) return { commits: [], ownFound: false, window: 0, othersInWindow: 0, filesCapped: false, unknown: true };
  let recent;
  const filesOf = new Map();
  if (withFiles && !filesUnknown) {
    recent = [];
    for (const block of logOut.split("\x1e").slice(1)) {
      const [head, ...rest] = block.split("\n");
      const c = parseLog(head)[0];
      if (!c) continue;
      recent.push(c);
      filesOf.set(c.sha, rest.filter(Boolean));
    }
  } else {
    recent = parseLog(logOut);
  }
  const at = recent.findIndex((c) => mine(c));
  const slice = at === -1 ? recent : recent.slice(0, at);
  const commits = slice.filter((c) => !mine(c));
  const othersInWindow = recent.filter((c) => !mine(c)).length;
  let filesCapped = false;
  if (withFiles) {
    commits.forEach((c, i) => {
      if (i >= FILES_CAP) filesCapped = true;
      else c.files = filesUnknown ? null : filesOf.get(c.sha) || []; // null prints as "files UNKNOWN"
    });
  }
  return { commits, ownFound: at !== -1, window: recent.length, othersInWindow, filesCapped };
}
// Open pull requests through gh: work in flight is the likeliest duplicate of a task about to
// start. Every PR, the developer's own included — an own forgotten branch is a duplicate too.
// gh missing or unauthenticated is reported as such, never as "no PRs". Two caps are surfaced
// rather than swallowed: the list itself (PR_LIMIT — a busier repo says "capped"), and the files
// per PR, which gh's query fetches 100 at most (measured on this repo: gh 100 vs git 142 on one
// PR) — a large refactor PR, the likeliest to overlap a task, is exactly where that bites.
const PR_LIMIT = 100;
const PR_FILES_CAP = 100;
function openPRs(root, timeoutMs) {
  let raw;
  try {
    raw = execFileSync("gh", ["pr", "list", "--state", "open", "--limit", String(PR_LIMIT), "--json", "number,title,author,headRefName,files,updatedAt"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs || 8000,
    });
  } catch (e) {
    const why = /ENOENT/.test(String(e.message)) ? "gh is not installed" : /timed out|ETIMEDOUT/i.test(String(e.message)) ? "gh timed out" : (String(e.stderr || e.message).trim().split("\n")[0] || "gh failed");
    return { prs: null, why };
  }
  try {
    const prs = JSON.parse(raw || "[]").map((p) => ({
      number: p.number,
      title: p.title || "",
      author: (p.author && p.author.login) || "?",
      branch: p.headRefName || "",
      files: (p.files || []).map((f) => f.path),
      filesCapped: (p.files || []).length >= PR_FILES_CAP,
      updatedAt: p.updatedAt || "",
    }));
    return { prs, why: "", capped: prs.length >= PR_LIMIT };
  } catch (e) {
    return { prs: null, why: "gh returned something that is not JSON" };
  }
}
// The list is read by eye against the task, so it stays short: a handful of paths, not the tree.
function fileSummary(files, max, capped) {
  if (files === null || files === undefined) return "files UNKNOWN (git failed or timed out)";
  const n = max || 4;
  const shown = files.slice(0, n).join(", ");
  const count = capped ? files.length + "+ file(s) (list capped by the API)" : files.length + " file(s)";
  return count + (files.length ? ": " + shown + (files.length > n ? ", +" + (files.length - n) + " more" : "") : "");
}
function parallelReport(root) {
  const o = othersSince(root, { files: true });
  const p = openPRs(root);
  const out = [];
  out.push("# parallel work · " + new Date().toISOString());
  const remote = upstream(root).remote;
  if (o.unknown) out.push("commits by others on " + remote + " since your last own commit: UNKNOWN (git log failed or timed out) — run `git log " + remote + "` by hand");
  else out.push(
    "commits by others on " + remote + " since your last own commit: " + o.commits.length +
      (o.ownFound ? "" : " (no own commit in the last " + o.window + " — the window is capped, older work is not listed)") +
      (o.filesCapped ? " (files listed for the newest " + FILES_CAP + " only)" : "")
  );
  for (const c of o.commits) out.push("- " + c.sha.slice(0, 8) + " " + c.name + " — " + c.subject + " — " + (c.files === undefined ? "files not listed" : fileSummary(c.files)));
  if (p.prs === null) out.push("open pull requests: UNAVAILABLE (" + p.why + ") — read them by hand on the forge before the first edit");
  else {
    out.push("open pull requests: " + p.prs.length + (p.capped ? " (capped at " + PR_LIMIT + " — more exist, read the rest on the forge)" : ""));
    for (const pr of p.prs) out.push("- #" + pr.number + " " + pr.author + " (" + pr.branch + ") — " + pr.title + " — " + fileSummary(pr.files, 4, pr.filesCapped));
  }
  return { text: out.join("\n"), commits: o.commits, prs: p.prs, prsWhy: p.why };
}

// The one SessionStart line, or nothing. Only where someone else commits: a solo repo prints
// nothing, whatever gh says — the gate is N/A there by the rule's own words, and a false line
// would drag every session through it. The gh call is bounded so a slow forge cannot hold the
// session start; unavailable is said, not swallowed. `f` is foreignCommits' result (its tip is
// the freshest view of the watched branch) and `script` the path the line tells the reader to run. `prs` is
// an openPRs result the caller already paid for (the release-surface line needs the same list);
// left out, the call is made here, and only where others commit.
function statusLine(root, f, script, prs) {
  const o = othersSince(root, { files: false, tip: f.tip, mine: f.mine });
  if (o.unknown) {
    return 'PARALLEL WORK: UNKNOWN — git log failed or timed out; before the first edit of a task: node "' + script + '" others (rules §1).\n';
  }
  if (!o.othersInWindow) return "";
  const p = prs || openPRs(root, 5000);
  const nPr = p.prs ? p.prs.length : 0;
  // Nothing new and nothing open: still say the repo has other contributors, in one short line,
  // so the checker knows a mid-task pull re-arms §1 here (a solo repo stays silent).
  if (!(o.commits.length || nPr || p.prs === null)) {
    return "CONTRIBUTORS: this repo has commits by others (nothing new since your last own commit, no open PRs) — a mid-task pull re-arms rules §1.\n";
  }
  const subjects = o.commits.slice(0, 3).map((c) => c.subject.slice(0, 60)).join(" · ");
  return (
    "PARALLEL WORK: " + o.commits.length + " commit(s) by others on " + upstream(root).remote + " since your last own commit" + (subjects ? " (" + subjects + (o.commits.length > 3 ? " · …" : "") + ")" : "") +
      (o.ownFound ? "" : " [window capped at " + o.window + " — older work not counted]") +
      " · open PRs: " + (p.prs === null ? "unavailable (" + p.why + ")" : String(nPr) + (p.capped ? "+ (capped)" : "")) +
      '. Before the first edit of a task: node "' + script + '" others, then say in one line whether any of it already covers the task (rules §1).\n'
  );
}

module.exports = { othersSince, openPRs, fileSummary, parallelReport, statusLine };
