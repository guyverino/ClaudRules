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
  // origin/main as a local ref: mainTip reads origin/main, not HEAD.
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
  t(/commits by others on main since your last own commit: 1/.test(rep.text) && /theirs: panel — 1 file\(s\): b\.txt/.test(rep.text), "others: report lists the commit and its files", rep.text.split("\n")[1]);
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
