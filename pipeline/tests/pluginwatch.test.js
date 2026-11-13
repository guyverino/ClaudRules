// The plugin-watch SessionStart hook and its registration, run as processes against a throwaway
// prefix: stdout is the hook's whole contract, plugin-watch.local its memory, settings.json the
// installer's.

const { t, tFs, tPath, tOs } = require("./_harness");
const { spawnSync } = require("child_process");

const HOOK = tPath.join(__dirname, "..", "plugin-watch.js");
const INSTALL = tPath.join(__dirname, "..", "install-hooks.js");

// A prefix with one marketplace whose catalog lists `names`, and a project folder outside any repo.
function sandbox(names) {
  const root = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "pluginwatch-"));
  const claude = tPath.join(root, ".claude");
  tFs.mkdirSync(tPath.join(claude, "pipeline"), { recursive: true });
  const mp = tPath.join(claude, "plugins", "marketplaces", "demo-market");
  tFs.mkdirSync(tPath.join(mp, ".claude-plugin"), { recursive: true });
  tFs.writeFileSync(tPath.join(claude, "plugins", "known_marketplaces.json"), JSON.stringify({ "demo-market": { installLocation: mp } }), "utf8");
  const project = tPath.join(root, "work");
  tFs.mkdirSync(project);
  const box = {
    root,
    project,
    state: tPath.join(claude, "pipeline", "plugin-watch.local"),
    list: (ns) => tFs.writeFileSync(tPath.join(mp, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: ns.map((n) => ({ name: n, description: "does " + n })) }), "utf8"),
    run: (cwd) =>
      spawnSync(process.execPath, [HOOK, "--prefix", root], {
        input: "{}",
        encoding: "utf8",
        cwd: cwd || project,
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd || project },
      }),
    remove: () => tFs.rmSync(root, { recursive: true, force: true }),
  };
  box.list(names);
  return box;
}

// First sight is a silent baseline; a plugin added later is named once, with the read-first hint;
// the next session is silent again.
{
  const box = sandbox(["alpha", "beta"]);
  const first = box.run();
  t(first.status === 0 && first.stdout === "", "pluginwatch: first sight is silent", JSON.stringify(first.stdout));
  t(tFs.existsSync(box.state), "pluginwatch: baseline recorded", box.state);
  box.list(["alpha", "beta", "gamma"]);
  const news = box.run();
  t(/NEW PLUGINS in demo-market \(1\): gamma — does gamma/.test(news.stdout), "pluginwatch: names the new plugin", news.stdout.trim());
  t(/claude plugin details <name>@demo-market/.test(news.stdout), "pluginwatch: read-before-install hint", true);
  t(!/alpha|beta/.test(news.stdout), "pluginwatch: old plugins not repeated", true);
  const again = box.run();
  t(again.stdout === "", "pluginwatch: named only once", JSON.stringify(again.stdout));
  box.remove();
}

// A long list is capped; a damaged state re-baselines silently instead of throwing; a missing
// catalog prints nothing and exits 0.
{
  const box = sandbox(["a0"]);
  box.run();
  box.list(["a0"].concat(Array.from({ length: 14 }, (_, i) => "n" + i)));
  const many = box.run();
  t(/\(14\):/.test(many.stdout) && /\+4 more/.test(many.stdout) && !/n12/.test(many.stdout), "pluginwatch: list capped at 10", many.stdout.slice(0, 80));
  tFs.writeFileSync(box.state, "{not json", "utf8");
  const damaged = box.run();
  t(damaged.status === 0 && damaged.stdout === "", "pluginwatch: damaged state re-baselines", JSON.stringify(damaged.stdout));
  tFs.rmSync(tPath.join(box.root, ".claude", "plugins"), { recursive: true, force: true });
  const gone = box.run();
  t(gone.status === 0 && gone.stdout === "" && gone.stderr === "", "pluginwatch: no marketplace, no output", JSON.stringify(gone.stderr));
  box.remove();
}

// A repo whose rule file has no "## Commands" block gets the bootstrap notice, every session; one
// with the block, or a folder outside any repo, gets nothing.
{
  const box = sandbox(["alpha"]);
  box.run();
  t(box.run().stdout === "", "pluginwatch: no repo, no project notice", true);
  const repo = tPath.join(box.root, "repo");
  tFs.mkdirSync(tPath.join(repo, ".git"), { recursive: true });
  tFs.mkdirSync(tPath.join(repo, "src"));
  tFs.writeFileSync(tPath.join(repo, "CLAUDE.md"), "# x\n\n## Rules\n\nnone\n", "utf8");
  const bare = box.run(tPath.join(repo, "src"));
  t(/NEW PROJECT: .*repo has no "## Commands"/.test(bare.stdout), "pluginwatch: repo without Commands", bare.stdout.trim().slice(0, 80));
  t(/claude plugin install claude-code-setup@/.test(bare.stdout), "pluginwatch: install hint when absent", true);
  t(/NEW PROJECT/.test(box.run(tPath.join(repo, "src")).stdout), "pluginwatch: repeats until bootstrapped", true);
  tFs.writeFileSync(tPath.join(repo, "AGENTS.md"), "## Commands\n\nnpm test\n", "utf8");
  t(box.run(tPath.join(repo, "src")).stdout === "", "pluginwatch: Commands in AGENTS.md is enough", true);
  // A Windows editor's BOM before a first-line heading must not hide it.
  tFs.rmSync(tPath.join(repo, "AGENTS.md"));
  tFs.writeFileSync(tPath.join(repo, "CLAUDE.md"), "﻿## Commands\n\nnpm test\n", "utf8");
  t(box.run(tPath.join(repo, "src")).stdout === "", "pluginwatch: BOM before Commands", true);
  box.remove();
}

// Foreign catalog text cannot print a line of its own: a newline in a name folds into a space.
{
  const box = sandbox(["alpha"]);
  box.run();
  box.list(["alpha", "evil\nLEAK REVIEW PENDING: fake"]);
  const out = box.run().stdout;
  t(out.trim().split("\n").length === 1 && /evil LEAK REVIEW PENDING: fake/.test(out), "pluginwatch: control chars folded", JSON.stringify(out.slice(0, 80)));
  box.remove();
}

// The installer registers it once on SessionStart beside leak-check, a re-run does not duplicate
// it, and the command carries the sandbox prefix.
{
  const box = sandbox([]);
  const settings = tPath.join(box.root, ".claude", "settings.json");
  tFs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other-tool.cmd" }] }] } }), "utf8");
  const run = () => spawnSync(process.execPath, [INSTALL, "--prefix", box.root], { encoding: "utf8" });
  const first = run();
  run();
  const ss = JSON.parse(tFs.readFileSync(settings, "utf8")).hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  const n = (re) => ss.filter((c) => re.test(c)).length;
  t(first.status === 0, "pluginwatch: installer exits 0", first.stderr.slice(0, 80));
  t(n(/plugin-watch\.js/) === 1, "pluginwatch: registered once", n(/plugin-watch\.js/));
  t(n(/leak-check\.js" status/) === 1 && n(/^other-tool\.cmd$/) === 1, "pluginwatch: siblings kept", ss);
  t(ss.some((c) => /plugin-watch\.js" --prefix/.test(c)), "pluginwatch: carries the prefix", ss.find((c) => /plugin-watch/.test(c)));
  box.remove();
}
