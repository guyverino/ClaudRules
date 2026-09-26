// The reply-language hook and its registration. Run as processes against a throwaway prefix, the
// way the harness runs them: stdout is the whole contract of the hook, settings.json of the
// installer.

const { t, tFs, tPath, tOs } = require("./_harness");
const { spawnSync } = require("child_process");

const HOOK = tPath.join(__dirname, "..", "reply-lang.js");
const INSTALL = tPath.join(__dirname, "..", "install-hooks.js");
const sandbox = () => {
  const root = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "replylang-"));
  tFs.mkdirSync(tPath.join(root, ".claude", "pipeline"), { recursive: true });
  return root;
};
const hook = (root) => spawnSync(process.execPath, [HOOK, "--prefix", root], { input: "{}", encoding: "utf8" });

// The hook: silent without its file, one block naming the language with it.
{
  const root = sandbox();
  const none = hook(root);
  t(none.status === 0 && none.stdout === "", "replylang: no file, no output", JSON.stringify(none.stdout));
  const file = tPath.join(root, ".claude", "pipeline", "reply-lang.local");
  tFs.writeFileSync(file, "﻿\n  \nRussian\nnote: a second line must not leak\n", "utf8");
  const on = hook(root);
  t(on.status === 0 && /<reply-language>/.test(on.stdout) && /in Russian:/.test(on.stdout), "replylang: names the language", on.stdout.slice(0, 60));
  t(!/second line/.test(on.stdout), "replylang: only the first non-empty line", true);
  tFs.writeFileSync(file, "\n \n", "utf8");
  t(hook(root).stdout === "", "replylang: blank file, no output", true);
  tFs.rmSync(root, { recursive: true, force: true });
}

// The installer: two of ours on UserPromptSubmit, registering one must not drop the other, a
// re-run must not duplicate either, and a foreign hook in the same event survives.
{
  const root = sandbox();
  const settings = tPath.join(root, ".claude", "settings.json");
  const foreign = { type: "command", command: "other-tool.cmd" };
  tFs.writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [foreign] }] } }), "utf8");
  const run = () => spawnSync(process.execPath, [INSTALL, "--prefix", root], { encoding: "utf8" });
  const first = run();
  run();
  const ups = JSON.parse(tFs.readFileSync(settings, "utf8")).hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
  const n = (re) => ups.filter((c) => re.test(c)).length;
  t(first.status === 0, "replylang: installer exits 0", first.stderr.slice(0, 80));
  t(n(/gate-check\.js" report/) === 1, "replylang: report hook kept once", n(/gate-check\.js" report/));
  t(n(/reply-lang\.js/) === 1, "replylang: language hook registered once", n(/reply-lang\.js/));
  t(n(/^other-tool\.cmd$/) === 1, "replylang: foreign hook survives", ups);
  tFs.rmSync(root, { recursive: true, force: true });
}
