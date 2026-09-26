// leak-check: the signature pre-scan, the project's `## Secrets` declaration (read at the
// reviewed base) and the Cargo.lock delta.

const { t, tFs, tPath, tOs, pipeline, tempGitRepo } = require("./_harness");

// --- leak-check: the signature pre-scan and the Cargo.lock delta ---------------------------
{
  const leak = pipeline("leak-check.js");
  const diff = [
    "diff --git a/crates/x/src/net.rs b/crates/x/src/net.rs",
    "--- a/crates/x/src/net.rs",
    "+++ b/crates/x/src/net.rs",
    "@@ -10,3 +10,6 @@",
    " fn keep() {}",
    "+let c = reqwest::Client::new();",
    "+let url = \"https://collect.example.com/v1\";",
    "-let old = TcpStream::connect(\"1.2.3.4:80\");",
    "+let s = ServersFile::default(); // touches the vault type but no signature word",
    "+let seed = 42; // 'seed' alone must not fire",
  ].join("\n");
  const hits = leak.prescan(diff);
  t(hits.some((h) => h.label === "network API" && h.line === 11), "leak: added reqwest hit on its new line", hits.filter((h) => h.label === "network API").map((h) => h.line));
  t(hits.some((h) => h.label === "network endpoint" && /collect\.example/.test(h.text)), "leak: added URL hit", hits.filter((h) => h.label === "network endpoint").length);
  t(!hits.some((h) => /TcpStream/.test(h.text)), "leak: a REMOVED line does not hit", hits.filter((h) => /TcpStream/.test(h.text)).length);
  t(!hits.some((h) => /seed = 42/.test(h.text)), "leak: bare 'seed' is not a secret", hits.filter((h) => /seed/.test(h.text)).length);
  const doc = "+++ b/README.md\n@@ -1,1 +1,2 @@\n+see https://example.com for docs";
  t(leak.prescan(doc).length === 1, "leak: a URL in a doc still surfaces (agent clears it)", leak.prescan(doc).length);
  // The project's declared secret surface: read from the repo file's `## Secrets` section, its
  // backticked names join the pre-scan (a touched declared file, an added line naming a declared
  // type), prose words in backticks do not.
  const secretsRoot = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "leak-secrets-"));
  t(leak.secretsSection(secretsRoot).length === 0, "leak: no repo file -> no declared section", leak.secretsSection(secretsRoot).length);
  tFs.writeFileSync(tPath.join(secretsRoot, "AGENTS.md"), "# x\n\n## Commands\n\nbuild\n\n## Secrets\n\n- the vault `servers.enc`, type `config/schema.rs::ServersFile`, module `config/crypto/`\n- a `high` finding; `open`; `Debug`\n\n### sub-heading stays inside\n\n- `refuse_blind_overwrite`\n\n## After\n\nnot secret\n");
  const sec = leak.secretsSection(secretsRoot);
  t(sec.length === 1 && sec[0].file === "AGENTS.md" && /refuse_blind_overwrite/.test(sec[0].text) && !/not secret/.test(sec[0].text), "leak: Secrets section ends at the next ## heading, keeps ###", sec.map((s) => s.file + ":" + s.text.length));
  const toks = leak.declaredTokens(sec);
  t(toks.includes("servers.enc") && toks.includes("config/schema.rs::ServersFile") && toks.includes("refuse_blind_overwrite"), "leak: declared tokens carry files, paths and symbols", toks);
  t(!toks.includes("high") && !toks.includes("open") && !toks.includes("Debug"), "leak: short prose words are not tokens", toks);
  const declaredDiff = "+++ b/crates/core/src/config/crypto/wrap.rs\n@@ -1,1 +1,2 @@\n+let s = ServersFile::default();\n+let n = 1;\n+++ b/README.md\n@@ -1,1 +1,1 @@\n+plain\n";
  const dh = leak.prescan(declaredDiff, toks);
  t(dh.some((h) => h.label === "declared secret file" && /wrap\.rs/.test(h.file)), "leak: a touched declared file is a hit on its own", dh.map((h) => h.label));
  t(dh.some((h) => h.label === "declared secret surface" && h.line === 1), "leak: an added line naming a declared type hits", dh.filter((h) => h.label === "declared secret surface").map((h) => h.line));
  t(dh.filter((h) => /README/.test(h.file)).length === 0, "leak: an undeclared file with plain lines is silent", dh.filter((h) => /README/.test(h.file)).length);
  t(leak.prescan(declaredDiff).filter((h) => /declared/.test(h.label)).length === 0, "leak: no tokens -> no declared hits", "silent");
  // The file that carries the declaration is a hit when a foreign commit touches it, tokens or not.
  const declDiff = "+++ b/AGENTS.md\n@@ -1,1 +1,1 @@\n+## Secrets\n+++ b/docs/x.md\n@@ -1,1 +1,1 @\n+x\n";
  t(leak.prescan(declDiff).some((h) => h.label === "declaration edited" && h.file === "AGENTS.md" && h.line === 0), "leak: an edited repo file is a 'declaration edited' hit", leak.prescan(declDiff).map((h) => h.label + ":" + h.file));
  t(!leak.prescan(declDiff).some((h) => /docs\/x\.md/.test(h.file)), "leak: an ordinary doc is not a declaration", "silent");
  // Tracked declaration: read at the reviewed base, not from the working tree a foreign commit
  // may have rewritten; an untracked one (gitignored) has no base and is read as it is.
  const repo = tempGitRepo("leak-base-");
  const gitRoot = repo.dir;
  const g = repo.g;
  g(["init", "-q"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "t"]);
  tFs.writeFileSync(tPath.join(gitRoot, "AGENTS.md"), "## Secrets\n\n- `base-vault.enc`\n");
  tFs.mkdirSync(tPath.join(gitRoot, "docs-internal"));
  tFs.writeFileSync(tPath.join(gitRoot, ".gitignore"), "docs-internal/\n");
  tFs.writeFileSync(tPath.join(gitRoot, "docs-internal", "AGENTS.md"), "## Secrets\n\n- `local-only.enc`\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  const baseSha = g(["rev-parse", "HEAD"]);
  tFs.writeFileSync(tPath.join(gitRoot, "AGENTS.md"), "## Secrets\n\n- (trimmed by a later commit)\n");
  tFs.writeFileSync(tPath.join(gitRoot, "CLAUDE.md"), "## Secrets\n\n- `added-after-base.enc`\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "foreign"]);
  const atBase = leak.secretsSection(gitRoot, baseSha);
  const tracked = atBase.find((s) => s.file === "AGENTS.md");
  t(tracked && /base-vault/.test(tracked.text) && !/trimmed/.test(tracked.text) && /reviewed base/.test(tracked.at), "leak: tracked declaration comes from the reviewed base", atBase.map((s) => s.file + "@" + s.at));
  const untracked = atBase.find((s) => s.file === "docs-internal/AGENTS.md");
  t(untracked && /local-only/.test(untracked.text) && /^working tree/.test(untracked.at), "leak: an untracked declaration is read from the working tree", untracked && untracked.at);
  t(leak.secretsSection(gitRoot).some((s) => s.file === "AGENTS.md" && /trimmed/.test(s.text)), "leak: no base given -> working tree (test/legacy path)", "ok");
  // A declaration added after the base in a TRACKED file is shown from the working tree, labelled
  // as not-at-base (the developer's own bootstrap until `mark`); a deleted declaring file still
  // comes from the base — the current index must not decide.
  const added = atBase.find((s) => s.file === "CLAUDE.md");
  t(added && /added-after-base/.test(added.text) && /NOT at the reviewed base/.test(added.at), "leak: a tracked declaration added after the base is shown, labelled", added && added.at);
  g(["rm", "-q", "AGENTS.md"]);
  g(["commit", "-q", "-m", "foreign delete"]);
  const afterDelete = leak.secretsSection(gitRoot, baseSha).find((s) => s.file === "AGENTS.md");
  t(afterDelete && /base-vault/.test(afterDelete.text) && /reviewed base/.test(afterDelete.at), "leak: a deleted declaring file still reads at the base", afterDelete && afterDelete.at);
  const delDiff = "--- a/AGENTS.md\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-## Secrets\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n+x\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +1,1 @@\n+y\n";
  const delHits = leak.prescan(delDiff).filter((h) => h.label === "declaration edited");
  t(delHits.length === 2 && delHits.some((h) => h.file === "AGENTS.md" && /deleted or renamed/.test(h.text)) && delHits.some((h) => h.file === "CLAUDE.md"), "leak: a deleted declaring file is a hit; a modified one hits once", delHits.map((h) => h.file));
  repo.remove();
  tFs.rmSync(secretsRoot, { recursive: true, force: true });
  // Cargo.lock: a moved rev on the same git URL is a pin move, not a source change; a new
  // package and a registry->git move are.
  const pkg = (name, version, source) => "\n[[package]]\nname = \"" + name + "\"\nversion = \"" + version + "\"\nsource = \"" + source + "\"\n";
  const lockOf = (rev, extra) => "version = 3\n" + pkg("moon-gpui", "0.0.0", "git+https://github.com/Moonbot-Tech/MoonUI?branch=master#" + rev) + (extra || "");
  const pinMove = leak.lockDiff(lockOf("aaaa1111"), lockOf("bbbb2222"));
  t(pinMove.pins.length === 1 && pinMove.pins[0].from === "aaaa1111" && pinMove.sourceChanged.length === 0, "leak: moved fork pin is a pin, not a source change", [pinMove.pins.length, pinMove.sourceChanged.length]);
  const newPkg = leak.lockDiff(lockOf("a"), lockOf("a", pkg("qrcode", "0.14.1", "registry+https://github.com/rust-lang/crates.io-index")));
  t(newPkg.added.length === 1 && /^NEW qrcode@0.14.1/.test(newPkg.added[0]), "leak: a new package is listed as NEW", newPkg.added);
  const bumped = leak.lockDiff(lockOf("a", pkg("serde", "1.0.1", "registry+x")), lockOf("a", pkg("serde", "1.0.2", "registry+x")));
  t(bumped.added.length === 1 && /^bumped serde@1.0.2/.test(bumped.added[0]), "leak: a version bump is 'bumped', not NEW", bumped.added);
  const moved = leak.lockDiff(lockOf("a", pkg("serde", "1.0.1", "registry+x")), lockOf("a", pkg("serde", "1.0.1", "git+https://evil.example/serde#c0ffee")));
  t(moved.sourceChanged.length === 1 && /registry\+x -> git\+https:\/\/evil/.test(moved.sourceChanged[0]), "leak: registry->git is a SOURCE CHANGE", moved.sourceChanged);
  t(leak.SIGNATURES.every(([label, re]) => typeof label === "string" && re instanceof RegExp), "leak: every signature is labelled", leak.SIGNATURES.length);
}
