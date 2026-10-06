// The public-export screen: a project's identifier must not ride an export to the public rules
// repo — not in a file or its name, not inside the base64 bundle, not in the commit message or
// author, not in an earlier unpushed commit — and a missing, unreadable or empty term list must
// never read as clean.

const { t, tFs, tPath, tOs, pipeline, tempGitRepo } = require("./_harness");

{
  const screen = pipeline("lib/screen.js");
  const dir = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "screen-"));
  const termsFile = tPath.join(dir, screen.TERMS_FILE);
  // --- the term list ---------------------------------------------------------------------------
  const none = screen.loadTerms(dir);
  t(none.terms === null && none.missing, "screen: no term file -> missing, not an empty list", none);
  tFs.mkdirSync(termsFile);
  const asDir = screen.loadTerms(dir);
  t(asDir.terms === null && asDir.error && !asDir.missing, "screen: an unreadable term file is an error, not 'missing'", asDir.error);
  tFs.rmdirSync(termsFile);
  tFs.writeFileSync(termsFile, "﻿# private names\n\n  Acme-Branch  \nabc\nhost.example.internal\n", "utf8");
  const loaded = screen.loadTerms(dir);
  t(loaded.terms.join() === "Acme-Branch,host.example.internal" && loaded.short.join() === "abc", "screen: comments, blanks, BOM skipped; short terms set aside", [loaded.terms, loaded.short]);
  // Windows PowerShell 5 `>` writes UTF-16LE with a BOM: read as UTF-8 it would match nothing.
  tFs.writeFileSync(termsFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Acme-Branch\r\n", "utf16le")]));
  t(screen.loadTerms(dir).terms.join() === "Acme-Branch", "screen: a UTF-16LE term file is read as its terms", screen.loadTerms(dir).terms);
  tFs.writeFileSync(termsFile, Buffer.from("Acme-Branch\n", "utf16le")); // no BOM: NULs in the terms
  t(screen.loadTerms(dir).terms === null && /NUL/.test(screen.loadTerms(dir).error), "screen: an encoding that leaves NULs is an error", screen.loadTerms(dir).error);
  tFs.writeFileSync(termsFile, "Acme-Branch\nabc\nhost.example.internal\n", "utf8");
  // --- plain text ------------------------------------------------------------------------------
  const hits = screen.screenText("one\nsee origin/acme-branch here\nthree", loaded.terms);
  t(hits.length === 1 && hits[0].line === 2 && hits[0].term === "Acme-Branch", "screen: case-insensitive hit with its line", hits);
  t(screen.screenText("index of origin/port-base", loaded.terms).length === 0, "screen: clean text has no hits", "ok");
  const variants = ["origin/acme_branch", "Acme Branch", "acme-\nbranch"].map((v) => screen.screenText(v, loaded.terms).length);
  t(variants.every((n) => n === 1), "screen: another separator or a line break is still caught", variants);
  // --- an export checkout: a file, its name, the bundle decoded, the commit message ---------------
  const repo = tempGitRepo("screen-repo-");
  const g = repo.g;
  const root = repo.dir;
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "me@example.com"]);
  g(["config", "user.name", "Me"]);
  tFs.mkdirSync(tPath.join(root, "pipeline", "tests"), { recursive: true });
  tFs.writeFileSync(tPath.join(root, "CLAUDE.md"), "# rules\nnothing private\n", "utf8");
  tFs.writeFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), "#!/bin/sh\n", "utf8");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  const owned = ["CLAUDE.md", "pipeline", "docs"];
  const clean = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" });
  t(clean.ok && /clean/.test(clean.lines.join("\n")), "gate: a clean export passes", clean.lines);
  const fixture = 'const x = hook("PARALLEL WORK on origin/Acme-Branch");\n';
  // Shaped like make-bundle.js output, the function definition line included — the review
  // caught a counter that took `write_file() {` for one more payload line and refused every export.
  const bundle = (b64) => "#!/bin/sh\nwrite_file() {\n  mkdir -p \"$(dirname \"$1\")\"\n}\nwrite_file '.claude/pipeline/tests/x.test.js' '" + b64 + "'\n";
  const real = tPath.join(__dirname, "..", "install-pipeline.sh");
  if (tFs.existsSync(real)) {
    const rb = screen.decodeBundle(tFs.readFileSync(real, "utf8"));
    t(rb.files.length > 0 && rb.lines === rb.files.length, "gate: the real make-bundle output decodes every payload line", [rb.lines, rb.files.length]);
  }
  tFs.writeFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), bundle(Buffer.from(fixture).toString("base64")), "utf8");
  t(!/Acme/i.test(tFs.readFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), "utf8")), "gate: the fixture is invisible to a plain read of the bundle", "ok");
  const inBundle = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" });
  t(!inBundle.ok && /install-pipeline\.sh -> \.claude\/pipeline\/tests\/x\.test\.js \(decoded\)/.test(inBundle.lines.join("\n")), "gate: a term inside the base64 bundle refuses", inBundle.lines.slice(0, 2));
  tFs.writeFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), "#!/bin/sh\nwrite_file \".claude/x.js\" 'QUJD'\n", "utf8");
  const moved = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" });
  t(!moved.ok && /bundle format changed/.test(moved.lines.join("\n")), "gate: a bundle line it cannot decode refuses, never reads clean", moved.lines.slice(0, 2));
  tFs.writeFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), "#!/bin/sh\n", "utf8");
  t(!screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: host.example.internal note" }).ok, "gate: the commit message is screened", "refused");
  // A non-ASCII path comes back C-quoted without -z, and its file would be skipped unscreened.
  tFs.mkdirSync(tPath.join(root, "docs"));
  tFs.writeFileSync(tPath.join(root, "docs", "заметки.md"), "see acme-branch\n", "utf8");
  const nonAscii = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" });
  t(!nonAscii.ok && /docs\/заметки\.md:1/.test(nonAscii.lines.join("\n")), "gate: a non-ASCII file name is read and screened", nonAscii.lines.slice(0, 2));
  tFs.rmSync(tPath.join(root, "docs"), { recursive: true });
  tFs.writeFileSync(tPath.join(root, "pipeline", "acme-branch.md"), "nothing inside\n", "utf8");
  t(!screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" }).ok, "gate: a term in a file NAME refuses", "refused");
  tFs.rmSync(tPath.join(root, "pipeline", "acme-branch.md"));
  t(screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" }).ok, "gate: clean again once the files are fixed", "ok");
  // No usable list: a dry export warns, a commit is refused.
  tFs.renameSync(termsFile, termsFile + ".off");
  const dry = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "" });
  const commit = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: x" });
  t(dry.ok && /^WARNING/.test(dry.lines[0]) && !commit.ok && /^REFUSED: there is no term list/.test(commit.lines[0]), "gate: no term list warns a dry run, refuses a commit", [dry.lines[0].slice(0, 40), commit.lines[0].slice(0, 40)]);
  tFs.writeFileSync(termsFile, "abc\n", "utf8");
  const shortOnly = screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: x" });
  t(!shortOnly.ok && /no usable term \(1 under 4 characters ignored\)/.test(shortOnly.lines[0]), "gate: a list of short terms only says why it is unusable", shortOnly.lines[0]);
  tFs.renameSync(termsFile + ".off", termsFile);
  // --- the push: every unpushed commit, not only the new one -------------------------------------
  const remote = tempGitRepo("screen-remote-");
  remote.g(["init", "-q", "--bare"]);
  t(!screen.pushGate({ repo: root, terms: loaded.terms }).ok, "push: no upstream refuses (cannot tell what would be sent)", "refused");
  g(["remote", "add", "origin", remote.dir]);
  g(["push", "-q", "-u", "origin", "main"]);
  t(screen.pushGate({ repo: root, terms: loaded.terms }).ok, "push: nothing unpushed passes", "ok");
  tFs.writeFileSync(tPath.join(root, "pipeline", "hand.md"), "made by hand on origin/acme-branch\n", "utf8");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "hand commit"]);
  tFs.rmSync(tPath.join(root, "pipeline", "hand.md"));
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "rules: tidy"]);
  t(screen.gate({ repo: root, pipeDir: dir, owned, commitMsg: "rules: tidy" }).ok, "push: the working tree alone looks clean", "ok");
  const pg = screen.pushGate({ repo: root, terms: loaded.terms });
  t(!pg.ok && /2 unpushed commit/.test(pg.lines[0]) && /commit [0-9a-f]{8}:\d+ — Acme-Branch/.test(pg.lines.join("\n")), "push: an earlier unpushed commit carrying a term refuses", pg.lines.slice(0, 2));
  g(["reset", "-q", "--hard", "origin/main"]);
  tFs.writeFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), bundle(Buffer.from(fixture).toString("base64")), "utf8");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "bundle"]);
  tFs.writeFileSync(tPath.join(root, "pipeline", "install-pipeline.sh"), "#!/bin/sh\n", "utf8");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "bundle fixed"]);
  const pgBundle = screen.pushGate({ repo: root, terms: loaded.terms });
  t(!pgBundle.ok && /\(decoded\)/.test(pgBundle.lines.join("\n")), "push: a term in an unpushed commit's bundle is caught decoded", pgBundle.lines.slice(0, 2));
  // A term already published upstream: the commit that takes it OUT must be pushable.
  g(["reset", "-q", "--hard", "origin/main"]);
  tFs.writeFileSync(tPath.join(root, "CLAUDE.md"), "# rules\nold note about acme-branch\n", "utf8");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "published earlier"]);
  g(["push", "-q"]);
  tFs.writeFileSync(tPath.join(root, "CLAUDE.md"), "# rules\nnothing private\n", "utf8");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "rules: remove the note"]);
  const removal = screen.pushGate({ repo: root, terms: loaded.terms });
  t(removal.ok, "push: a commit that only REMOVES a term passes", removal.lines);
  t(screen.unpushed(root).length === 1, "push: unpushed lists what a push would send", screen.unpushed(root).length);
  repo.remove();
  remote.remove();
  tFs.rmSync(dir, { recursive: true, force: true });
}
