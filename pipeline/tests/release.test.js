// The release surface: the `## Release surface` section of the repo file names the paths that
// decide what users install; a commit by others or an open PR that touches one must be on
// screen until acknowledged — and nothing else must be.

const { t, tFs, tPath, pipeline, tempGitRepo } = require("./_harness");

{
  const rel = pipeline("lib/release.js");
  const repofile = pipeline("lib/repofile.js");
  const leak = pipeline("leak-check.js");
  // --- patterns: what a backticked entry means -------------------------------------------------
  const pats = rel.releasePatterns([{ text: "- `.github/workflows/` and `.github/scripts/*.sh`; `crates/core/src/update/`, `crates/core/src/update.rs`, `**/tests/ci_gate_contract.rs`, `./Makefile`\n- prose: `high`, `main`, `v*`, `RELEASE_ADMIN_TOKEN`" }]);
  t(pats.length === 6, "release: paths become patterns, prose does not", pats.map((p) => p.raw));
  const files = [".github/workflows/release.yml", ".github/scripts/x.sh", ".github/scripts/sub/y.sh", "crates/core/src/update/download.rs", "crates/core/src/update.rs", "crates/core/src/updater.rs", "Makefile", "vx", "crates/core/tests/ci_gate_contract.rs", "README.md", "docs/main"];
  const hit = rel.matchRelease(files, pats);
  t(hit.length === 6 && hit.includes("Makefile") && hit.includes("crates/core/tests/ci_gate_contract.rs") && !hit.includes(".github/scripts/sub/y.sh") && !hit.includes("crates/core/src/updater.rs") && !hit.includes("vx"), "release: dir prefix, one-segment star, double star, forced bare name; no over-match", hit);
  t(rel.matchRelease(["crates\\core\\src\\update\\x.rs"], pats).length === 1, "release: backslash paths match too", "ok");
  // A bare name (no slash) means the file wherever it lives; `./name` pins it to the root.
  const bare = rel.releasePatterns([{ text: "`release.yml`, `./Cargo.lock`, `*.sh`" }]);
  const bareHit = rel.matchRelease([".github/workflows/release.yml", "release.yml", "Cargo.lock", "crates/x/Cargo.lock", "a/b/c.sh", "notes.shx"], bare);
  t(bareHit.join() === ".github/workflows/release.yml,release.yml,Cargo.lock,a/b/c.sh", "release: a bare name matches at any depth, ./name only at the root", bareHit);
  t(rel.releasePatterns([]).length === 0 && rel.releasePatterns([{ text: "only `prose` here" }]).length === 0, "release: no paths -> no patterns", "ok");
  // --- the section reader is shared with Secrets and stops at the next ## ----------------------
  const secRoot = tFs.mkdtempSync(tPath.join(require("os").tmpdir(), "release-sec-"));
  tFs.writeFileSync(tPath.join(secRoot, "AGENTS.md"), "## Secrets\n\n- `vault.enc`\n\n## Release surface\n\n- `.github/workflows/`\n\n### sub stays\n\n- `scripts/`\n\n## Secretsfile\n\n- `not-a-secret`\n\n## Later\n\n- `.github/scripts/`\n");
  const rs = repofile.section(secRoot, null, "Release surface");
  t(rs.length === 1 && /scripts\/`/.test(rs[0].text) && !/Later|\.github\/scripts/.test(rs[0].text), "release: section ends at the next ##, keeps ###", rs.map((s) => s.text.length));
  const ss = repofile.section(secRoot, null, "Secrets");
  t(ss.length === 1 && /vault\.enc/.test(ss[0].text) && !/not-a-secret/.test(ss[0].text), "release: `## Secretsfile` is not `## Secrets`", ss.map((s) => s.text));
  t(leak.secretsSection(secRoot).length === 1 && leak.secretsSection(secRoot)[0].text === ss[0].text, "release: leak-check's secretsSection is the shared reader", "ok");
  tFs.rmSync(secRoot, { recursive: true, force: true });
  // --- the window: commits by others past the release marker --------------------------------
  const repo = tempGitRepo("release-win-");
  const root = repo.dir;
  const g = repo.g;
  g(["init", "-q"]);
  g(["config", "user.email", "me@example.com"]);
  g(["config", "user.name", "me"]);
  tFs.mkdirSync(tPath.join(root, ".github", "workflows"), { recursive: true });
  tFs.writeFileSync(tPath.join(root, "AGENTS.md"), "## Release surface\n\n- `.github/workflows/` and `updater/`\n");
  tFs.writeFileSync(tPath.join(root, ".github", "workflows", "release.yml"), "a\n");
  tFs.writeFileSync(tPath.join(root, "README.md"), "r\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "mine: base"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const none = rel.releaseChanges(root);
  t(none.declared && none.commits.length === 0 && none.firstRun, "release: nothing by others -> no commits, first run anchors at my last own commit", [none.declared, none.commits.length]);
  t(tFs.readFileSync(none.marker, "utf8").trim() === g(["rev-parse", "HEAD"]), "release: the first run PINS that base in the marker — my next own merge must not move it", none.marker);
  t(rel.releaseLines(none, [], "", "S") === "", "release: nothing pending prints NOTHING — silence is the normal state", JSON.stringify(rel.releaseLines(none, [], "", "S")));
  const other = (msg) => g(["-c", "user.email=o@example.com", "-c", "user.name=Other", "commit", "-q", "-m", msg]);
  tFs.writeFileSync(tPath.join(root, "README.md"), "r2\n");
  g(["add", "-A"]);
  other("theirs: docs only");
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const docsOnly = rel.releaseChanges(root);
  t(docsOnly.commits.length === 0, "release: a foreign commit outside the surface is silent", docsOnly.commits.length);
  tFs.writeFileSync(tPath.join(root, ".github", "workflows", "release.yml"), "b\n");
  tFs.mkdirSync(tPath.join(root, "updater"));
  tFs.writeFileSync(tPath.join(root, "updater", "check.rs"), "x\n");
  tFs.writeFileSync(tPath.join(root, "README.md"), "r3\n");
  g(["add", "-A"]);
  other("theirs: move the publish job");
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const touched = rel.releaseChanges(root);
  t(touched.commits.length === 1 && touched.commits[0].files.join() === ".github/workflows/release.yml,updater/check.rs", "release: a foreign commit on the surface is listed with ONLY the matched files", touched.commits.map((c) => c.files));
  const lines = rel.releaseLines(touched, [], "", "SCRIPT");
  t(/^RELEASE SURFACE CHANGED by Other — [0-9a-f]{8} theirs: move the publish job — \.github\/workflows\/release\.yml, updater\/check\.rs/m.test(lines) && /ack-release/.test(lines) && /"SCRIPT"/.test(lines), "release: the line names author, sha, subject, files and the ack command", lines.split("\n")[0]);
  // My own commit on the surface is mine to know about: not listed.
  tFs.writeFileSync(tPath.join(root, ".github", "workflows", "release.yml"), "c\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "mine: on the surface"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const afterMine = rel.releaseChanges(root);
  t(afterMine.commits.length === 1 && afterMine.commits[0].subject === "theirs: move the publish job", "release: my own commit on the surface is not listed, theirs still is (marker window, not since-my-last)", afterMine.commits.map((c) => c.subject));
  // Acknowledging moves the marker; the leak marker is a different file and stays where it was.
  const tip = g(["rev-parse", "HEAD"]);
  const marker = rel.ackRelease(root, tip);
  t(/release-surface-seen$/.test(marker) && tFs.readFileSync(marker, "utf8").trim() === tip, "release: ack writes the tip to .git/release-surface-seen", marker);
  t(!tFs.existsSync(tPath.join(root, ".git", "leak-reviewed")), "release: ack does not touch the leak marker", "ok");
  const acked = rel.releaseChanges(root);
  t(acked.commits.length === 0 && !acked.firstRun, "release: after ack the line is gone", acked.commits.length);
  tFs.writeFileSync(tPath.join(root, "updater", "check.rs"), "y\n");
  g(["add", "-A"]);
  other("theirs: relax the digest check");
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  t(rel.releaseChanges(root).commits.length === 1 && rel.releaseChanges(root).commits[0].subject === "theirs: relax the digest check", "release: a new foreign touch after ack shows up again", rel.releaseChanges(root).commits.map((c) => c.subject));
  // A merge commit by others lists no files without first-parent diffs: the change it brought
  // to main must still be seen (an "evil merge" resolution has no other commit to show it).
  g(["checkout", "-q", "-b", "side", "HEAD~1"]);
  tFs.writeFileSync(tPath.join(root, ".github", "workflows", "build.yml"), "m\n");
  g(["add", "-A"]);
  other("theirs: side branch");
  g(["checkout", "-q", "-"]);
  g(["-c", "user.email=o@example.com", "-c", "user.name=Other", "merge", "-q", "--no-ff", "side", "-m", "theirs: merge side"]);
  g(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const merged = rel.releaseChanges(root);
  const mergeCommit = merged.commits.find((c) => c.subject === "theirs: merge side");
  t(mergeCommit && mergeCommit.files.join() === ".github/workflows/build.yml", "release: a merge commit lists what it brought to main (first-parent), not nothing", merged.commits.map((c) => c.subject + ":" + c.files.join()));
  // The leak report lists the same merge commit in "touched by the commits under review", and its
  // code section carries the first-parent diff the list points at (leak marker absent -> window
  // from my last own commit, which is before the merge).
  const report = leak.buildReport(root).text;
  t(/### touched by the commits under review\n(?:.*\n)*?- [0-9a-f]{12} Other — theirs: merge side — \.github\/workflows\/build\.yml/.test(report), "release: the leak report's touched list names the merge commit and its file", report.split("\n").filter((l) => /^- [0-9a-f]{12} Other/.test(l)));
  t(/\+\+\+ b\/\.github\/workflows\/build\.yml/.test(report.slice(report.indexOf("## code (git show per commit)"))), "release: the report's code section shows the merge commit's first-parent diff", "ok");
  // A broken marker is said, and the base falls back — never a silent empty list.
  tFs.writeFileSync(marker, "0000000000000000000000000000000000000000\n");
  const broken = rel.releaseChanges(root);
  t(broken.markerBroken && broken.commits.length >= 1 && /RELEASE SURFACE: the stored marker/.test(rel.releaseLines(broken, [], "", "S")), "release: a marker that no longer resolves is reported, base falls back", [broken.markerBroken, broken.commits.length]);
  t(tFs.readFileSync(marker, "utf8").trim() === "0000000000000000000000000000000000000000", "release: a broken marker is NOT rewritten (a transient git failure must not re-pin past unread changes)", tFs.readFileSync(marker, "utf8").trim().slice(0, 8));
  // --- open PRs -------------------------------------------------------------------------------
  const prs = [
    { number: 7, author: "alice", branch: "feat/x", files: ["crates/a.rs", ".github/workflows/build.yml"], filesCapped: false },
    { number: 8, author: "me", branch: "feat/y", files: ["crates/b.rs"], filesCapped: false },
    { number: 9, author: "big", branch: "refactor", files: Array.from({ length: 100 }, (_, i) => "crates/f" + i + ".rs"), filesCapped: true },
  ];
  const prHits = rel.releasePRs(prs, touched.patterns);
  t(prHits.length === 2 && prHits[0].number === 7 && prHits[0].files.join() === ".github/workflows/build.yml" && prHits[1].number === 9 && prHits[1].filesCapped, "release: a PR touching the surface is listed; a capped file list is listed as unknown; a clean PR is not", prHits.map((p) => p.number));
  const prLines = rel.releaseLines(acked, prs, "", "S");
  t(/RELEASE SURFACE in open PR #7 by alice \(feat\/x\) — \.github\/workflows\/build\.yml/.test(prLines) && /#9 by big .*capped by the API/.test(prLines) && !/#8/.test(prLines), "release: PR lines name number, author, branch, files; capped says so", prLines);
  const noGh = rel.releaseLines(acked, null, "gh is not installed", "S");
  t(/RELEASE SURFACE in open PRs: UNKNOWN \(gh is not installed\)/.test(noGh), "release: gh unavailable is UNKNOWN, never 'no PR touches it'", noGh.trim());
  // No section: nothing declared, nothing printed, whatever the commits and PRs are.
  tFs.writeFileSync(tPath.join(root, "AGENTS.md"), "## Secrets\n\n- `vault.enc`\n");
  const undeclared = rel.releaseChanges(root);
  t(!undeclared.declared && rel.releaseLines(undeclared, prs, "", "S") === "", "release: no `## Release surface` section -> nothing declared, nothing printed", [undeclared.declared, undeclared.patterns.length]);
  repo.remove();
}
