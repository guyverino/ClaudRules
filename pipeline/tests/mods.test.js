// install-hooks.js registers the mods under pipeline/mods/ in settings.json's env block: each mod
// folder once, a foreign folder in the list kept, a folder with no plugin.json left out, and the
// key removed again when no mod is left.

const { t, tFs, tPath, tOs } = require("./_harness");
const { spawnSync } = require("child_process");

const INSTALL = tPath.join(__dirname, "..", "install-hooks.js");

{
  const root = tFs.mkdtempSync(tPath.join(tOs.tmpdir(), "mods-"));
  const mods = tPath.join(root, ".claude", "pipeline", "mods");
  const settings = tPath.join(root, ".claude", "settings.json");
  const plugin = (name) => {
    tFs.mkdirSync(tPath.join(mods, name, ".claude-plugin"), { recursive: true });
    tFs.writeFileSync(tPath.join(mods, name, ".claude-plugin", "plugin.json"), "{}", "utf8");
  };
  plugin("pipeline");
  plugin("moon-guard");
  tFs.mkdirSync(tPath.join(mods, "not-a-mod"), { recursive: true });
  const foreign = tPath.join(root, "elsewhere", "theirs");
  tFs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: foreign, OTHER: "1" } }), "utf8");
  const run = () => spawnSync(process.execPath, [INSTALL, "--prefix", root], { encoding: "utf8" });
  const dirs = () => (JSON.parse(tFs.readFileSync(settings, "utf8")).env || {}).CLAUDE_CODE_PLUGIN_DIRS;

  const first = run();
  const once = dirs();
  run();
  const twice = dirs();
  const want = [foreign, tPath.join(mods, "moon-guard"), tPath.join(mods, "pipeline")].join(tPath.delimiter);
  t(first.status === 0 && once === want, "mods: registered, foreign kept", once);
  t(twice === once, "mods: a re-run changes nothing", twice);
  t(JSON.parse(tFs.readFileSync(settings, "utf8")).env.OTHER === "1", "mods: other env keys kept", true);

  tFs.rmSync(mods, { recursive: true, force: true });
  tFs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: tPath.join(mods, "pipeline") } }), "utf8");
  run();
  t(!("env" in JSON.parse(tFs.readFileSync(settings, "utf8"))), "mods: none left, key removed", tFs.readFileSync(settings, "utf8").slice(0, 80));
  tFs.rmSync(root, { recursive: true, force: true });
}
