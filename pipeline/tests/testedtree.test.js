// tested-tree.js: a green suite is recorded only for the tree it ran on, and `check` says "skip"
// only for that tree under that command. A false "skip" lands an untested tree on main — the one
// failure this script must never produce — so every case below is a way to get one.

const { t, tFs, tPath, tOs, tempGitRepo } = require("./_harness");
const { spawnSync } = require("child_process");

const SCRIPT = tPath.join(__dirname, "..", "tested-tree.js");

{
  const repo = tempGitRepo("tested-tree-");
  // The commands live OUTSIDE the repo: a script inside it would be part of the tree under test.
  const bin = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "tested-tree-bin-"));
  const script = (name, body) => {
    const p = tPath.join(bin, name);
    tFs.writeFileSync(p, body);
    return [process.execPath, p];
  };
  const pass = script("pass.js", "process.exit(0)");
  const fail = script("fail.js", "process.exit(3)");
  const touch = script("touch.js", "require('fs').writeFileSync('a.txt', 'changed by the run'); process.exit(0)");
  const tool = (mode, cmd) => spawnSync(process.execPath, [SCRIPT, mode, "--"].concat(cmd), { cwd: repo.dir, encoding: "utf8" });
  const check = (cmd) => tool("check", cmd).status;

  try {
    repo.g(["init", "-q"]);
    tFs.writeFileSync(tPath.join(repo.dir, "a.txt"), "one");
    tFs.writeFileSync(tPath.join(repo.dir, ".gitignore"), "target/\n");
    repo.g(["add", "-A"]);
    repo.g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);

    t(check(pass) === 1, "tested-tree: nothing recorded -> run", check(pass));
    t(tool("run", fail).status === 3, "tested-tree: run keeps the exit code", 3);
    t(check(fail) === 1, "tested-tree: a red run records nothing", check(fail));

    const run = tool("run", pass);
    t(run.status === 0 && /recorded/.test(run.stdout), "tested-tree: green run is recorded", run.stdout.trim());
    t(check(pass) === 0, "tested-tree: same tree -> skip", check(pass));
    t(check(fail) === 1, "tested-tree: other command -> run", check(fail));

    // Ignored output is not the tree; an untracked source file is.
    tFs.mkdirSync(tPath.join(repo.dir, "target"));
    tFs.writeFileSync(tPath.join(repo.dir, "target", "out.bin"), "build output");
    t(check(pass) === 0, "tested-tree: ignored file -> skip", check(pass));
    tFs.writeFileSync(tPath.join(repo.dir, "b.txt"), "new");
    t(check(pass) === 1, "tested-tree: untracked file -> run", check(pass));
    tFs.rmSync(tPath.join(repo.dir, "b.txt"));
    t(check(pass) === 0, "tested-tree: file removed -> skip", check(pass));

    // A red run on the very tree recorded green wipes the record: a flaky suite is not a pass.
    // flaky.js sits outside the repo, so rewriting it does not move the tree.
    const flaky = script("flaky.js", "process.exit(0)");
    tool("run", flaky);
    t(check(flaky) === 0, "tested-tree: flaky green recorded", check(flaky));
    tFs.writeFileSync(flaky[1], "process.exit(1)");
    tool("run", flaky);
    t(check(flaky) === 1, "tested-tree: red on green tree wipes", check(flaky));
    // Back to a green record for `pass`, so the cases below fail for their own reason.
    tool("run", pass);
    t(check(pass) === 0, "tested-tree: re-recorded", check(pass));

    // A cargo [patch] path override builds sources the hash never sees: no skip, no record. The
    // config is gitignored here, as it is in the project, so it does not move the tree itself.
    tFs.writeFileSync(tPath.join(repo.dir, ".gitignore"), "target/\n.cargo/\n");
    tool("run", pass);
    tFs.mkdirSync(tPath.join(repo.dir, ".cargo"));
    tFs.writeFileSync(tPath.join(repo.dir, ".cargo", "config.toml"), "[patch.'https://example.com/ui']\nui = { path = '../ui' }\n");
    t(check(pass) === 1, "tested-tree: [patch] active -> run", check(pass));
    const patchedRun = tool("run", pass);
    t(/not recorded/.test(patchedRun.stdout), "tested-tree: [patch] active -> no record", patchedRun.stdout.trim());
    tFs.rmSync(tPath.join(repo.dir, ".cargo"), { recursive: true, force: true });
    t(check(pass) === 0, "tested-tree: [patch] gone -> skip", check(pass));

    tFs.writeFileSync(tPath.join(repo.dir, "a.txt"), "two");
    t(check(pass) === 1, "tested-tree: edited file -> run", check(pass));

    // A tree that moved under the run is not the tree that passed.
    tFs.writeFileSync(tPath.join(repo.dir, "a.txt"), "one");
    const moved = tool("run", touch);
    t(moved.status === 0 && /not recorded/.test(moved.stdout), "tested-tree: tree moved in run", moved.stdout.trim());
    t(check(pass) === 1, "tested-tree: moved run not skipped", check(pass));

    // The real index stays as the developer left it: nothing staged by a hash.
    t(repo.g(["diff", "--cached", "--name-only"]) === "", "tested-tree: real index untouched", repo.g(["diff", "--cached", "--name-only"]));
  } finally {
    repo.remove();
    tFs.rmSync(bin, { recursive: true, force: true });
  }

  // Outside any repo: no tree, so never a skip.
  const plain = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "tested-tree-plain-"));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "check", "--", "x"], { cwd: plain, encoding: "utf8" });
    t(r.status === 1, "tested-tree: no repo -> run", r.status);
  } finally {
    tFs.rmSync(plain, { recursive: true, force: true });
  }
}
