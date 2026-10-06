// leak-check `others`: commits by others since my last own commit, open PRs through gh,
// the file summary and its caps.

const { t, tFs, tPath, pipeline, tempGitRepo } = require("./_harness");

// --- leak-check: `others` — commits by others since my last own commit, PRs through gh -----------
{
  const leak = pipeline("lib/parallel.js");
  t(leak.fileSummary([]) === "0 file(s)", "others: empty file list", leak.fileSummary([]));
  t(leak.fileSummary(["a", "b", "c", "d", "e", "f"], 4) === "6 file(s): a, b, c, d, +2 more", "others: file list is capped with a count", leak.fileSummary(["a", "b", "c", "d", "e", "f"], 4));
  t(/^100\+ file\(s\) \(list capped by the API\)/.test(leak.fileSummary(new Array(100).fill("f"), 4, true)), "others: a PR at the API's file cap says 100+", leak.fileSummary(new Array(100).fill("f"), 4, true).slice(0, 40));
  t(/UNKNOWN/.test(leak.fileSummary(null)), "others: a failed diff-tree is UNKNOWN, not 0 files", leak.fileSummary(null));
  // A repo where only I commit: nothing by others, and the own commit is found (window not capped).
  const repo = tempGitRepo("leak-others-");
  const gitRoot = repo.dir;
  const g = repo.g;
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "me@example.com"]);
  g(["config", "user.name", "Me"]);
  tFs.writeFileSync(tPath.join(gitRoot, "a.txt"), "1\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "mine"]);
  // origin/main as a local ref: upstreamTip reads origin/main, not HEAD.
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const solo = leak.othersSince(gitRoot);
  t(solo.commits.length === 0 && solo.ownFound, "others: only my commits -> nothing, own found", solo);
  tFs.writeFileSync(tPath.join(gitRoot, "b.txt"), "2\n");
  g(["add", "-A"]);
  g(["-c", "user.email=o@example.com", "-c", "user.name=Other", "commit", "-q", "-m", "theirs: panel"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const o = leak.othersSince(gitRoot, { files: true });
  t(o.commits.length === 1 && o.commits[0].subject === "theirs: panel" && o.commits[0].files.join() === "b.txt" && o.othersInWindow === 1, "others: a commit by someone else since my last own, with its files", o.commits.map((c) => c.subject + ":" + c.files.join()));
  const noFiles = leak.othersSince(gitRoot);
  t(noFiles.commits[0].files === undefined, "others: files are opt-in (the hook path skips them)", noFiles.commits[0].files);
  const rep = leak.parallelReport(gitRoot);
  t(/commits by others on origin\/main since your last own commit: 1/.test(rep.text) && /theirs: panel — 1 file\(s\): b\.txt/.test(rep.text), "others: report lists the commit and its files", rep.text.split("\n")[1]);
  t(/open pull requests: (\d+|UNAVAILABLE \()/.test(rep.text), "others: PRs are a count or an explicit UNAVAILABLE, never silence", rep.text.split("\n").find((l) => /open pull/.test(l)));
  // Right after I publish on top of them, "since my last own" is 0 but the repo still has other
  // contributors: the hook's test is othersInWindow, not the since-count.
  tFs.writeFileSync(tPath.join(gitRoot, "c.txt"), "3\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "mine again"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const after = leak.othersSince(gitRoot);
  t(after.commits.length === 0 && after.othersInWindow === 1, "others: zero since my last commit, yet the repo has other contributors", [after.commits.length, after.othersInWindow]);
  repo.remove();
}

// The watched branch: `git config leakcheck.branch` points every gate at a branch other than main
// (work based on a branch that never merged there). Unset, nothing changes; set, the commits on
// THAT branch are watched and every line names it; a bad or absent branch is said, never silent.
{
  const { spawnSync } = require("child_process");
  const gitmod = pipeline("lib/git.js");
  const par = pipeline("lib/parallel.js");
  const LEAK = tPath.join(__dirname, "..", "leak-check.js");
  const leak = (root, mode) => spawnSync(process.execPath, [LEAK, mode, "--hand"], { cwd: root, encoding: "utf8" });
  const repo = tempGitRepo("leak-upstream-");
  const root = repo.dir;
  const g = repo.g;
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "me@example.com"]);
  g(["config", "user.name", "Me"]);
  tFs.writeFileSync(tPath.join(root, "a.txt"), "1\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "mine"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  g(["checkout", "-q", "-b", "dev"]);
  tFs.writeFileSync(tPath.join(root, "b.txt"), "2\n");
  g(["add", "-A"]);
  g(["-c", "user.email=o@example.com", "-c", "user.name=Other", "commit", "-q", "-m", "theirs: on dev"]);
  g(["update-ref", "refs/remotes/origin/dev", "HEAD"]);
  const def = gitmod.upstream(root);
  t(def.remote === "origin/main" && !def.configured && !def.invalid && def.privateRef === "refs/leak-check/origin-main", "upstream: main by default, old private ref kept", def);
  t(par.othersSince(root).commits.length === 0, "upstream: unset, a commit only on another branch is not watched", par.othersSince(root).commits.length);
  g(["config", "leakcheck.branch", "dev"]);
  const dev = gitmod.upstream(root);
  t(dev.remote === "origin/dev" && dev.configured && !dev.invalid && dev.privateRef === "refs/leak-check/origin-646576", "upstream: configured branch, hex-keyed private ref", dev);
  // Flat keys: foo vs foo/bar, main/x vs the origin-main ref, Foo vs foo — no two share a name.
  const keys = ["foo", "foo/bar", "main/x", "Foo"].map((b) => gitmod.branchKey(b));
  t(new Set(keys).size === 4 && keys.every((k) => !k.includes("/")) && gitmod.branchKey("main") === "", "upstream: branch keys are flat and distinct, main unkeyed", keys);
  const o = par.othersSince(root);
  t(o.commits.length === 1 && o.commits[0].subject === "theirs: on dev", "upstream: the configured branch is the one watched", o.commits.map((c) => c.subject));
  t(/commits by others on origin\/dev since/.test(par.parallelReport(root).text), "upstream: others report names the branch", par.parallelReport(root).text.split("\n")[1]);
  const st = leak(root, "status");
  t(/LEAK REVIEW PENDING: 1 commit\(s\) by others on origin\/dev/.test(st.stdout) && /PARALLEL WORK: 1 commit\(s\) by others on origin\/dev/.test(st.stdout), "upstream: status lines name the branch", st.stdout.split("\n").slice(0, 3));
  // This fixture has no origin remote, so every fetch fails: a configured branch says its tip may be stale.
  t(/LEAK CHECK: fetching origin\/dev failed .* may be stale/.test(st.stdout), "upstream: a failed fetch of a configured branch is said", st.stdout.split("\n")[0]);
  const mk = leak(root, "mark");
  const devMarker = tPath.join(root, ".git", "leak-reviewed-646576");
  t(mk.status === 0 && tFs.readFileSync(devMarker, "utf8").trim() === g(["rev-parse", "origin/dev"]) && !tFs.existsSync(tPath.join(root, ".git", "leak-reviewed")), "upstream: mark writes a per-branch marker at the branch tip", mk.stdout.trim());
  t(!/LEAK REVIEW PENDING: 1/.test(leak(root, "status").stdout), "upstream: after mark the branch has nothing pending", "ok");
  g(["config", "--unset", "leakcheck.branch"]);
  t(gitmod.markerPath(root).endsWith("leak-reviewed"), "upstream: back on main, the main marker is read, not the dev one", gitmod.markerPath(root));
  g(["config", "leakcheck.branch", "dev"]);
  g(["config", "leakcheck.branch", "bad..name"]);
  t(gitmod.upstream(root).invalid && gitmod.upstreamTip(root) === "", "upstream: an invalid name is invalid, no tip", gitmod.upstream(root));
  t(/not a valid branch name/.test(leak(root, "status").stdout), "upstream: status says an invalid name out loud", leak(root, "status").stdout.trim());
  const badMark = leak(root, "mark");
  t(badMark.status === 1 && /not a valid branch name/.test(badMark.stderr), "upstream: mark refuses an invalid name", [badMark.status, badMark.stderr.trim()]);
  g(["config", "leakcheck.branch", "-x"]);
  t(gitmod.upstream(root).invalid, "upstream: a name that reads as an option is invalid", gitmod.upstream(root).branch);
  g(["config", "leakcheck.branch", "gone"]);
  const gone = leak(root, "status");
  t(/^LEAK REVIEW PENDING: UNKNOWN — git config leakcheck\.branch = "gone" but there is no origin\/gone/.test(gone.stdout), "upstream: an absent configured branch is said as a pending review", gone.stdout.trim());
  const goneOthers = leak(root, "others").stdout;
  t(/there is no origin\/gone/.test(goneOthers) && !/commits by others/.test(goneOthers), "upstream: others says it, with no false 0-commit line", goneOthers.trim());
  const goneDiff = leak(root, "diff");
  t(goneDiff.status === 1 && /there is no origin\/gone/.test(goneDiff.stderr) && !/nothing by other authors/.test(goneDiff.stdout), "upstream: diff refuses an absent branch, no clean report", [goneDiff.status, goneDiff.stdout.slice(0, 60)]);
  repo.remove();
}
