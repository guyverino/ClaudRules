// make-bundle: the home rewrite anchors on THIS machine's ~/.claude, not on a user name.

const { t, tPath, tOs, pipeline } = require("./_harness");

// --- make-bundle: the home rewrite anchors on THIS machine's ~/.claude, not on a user name ---
{
  const bundle = pipeline("make-bundle.js");
  const home = tPath.join(tOs.homedir(), ".claude");
  const quoted = 'node "' + home + tPath.sep + "pipeline" + tPath.sep + 'gate-check.js" digest';
  const outQ = bundle.rewriteForPosix(quoted, "__H__");
  t(outQ === 'node "__H__/.claude/pipeline/gate-check.js" digest', "bundle: quoted script path rewritten with / tail", outQ);
  const fwd = bundle.rewriteForPosix(home.replace(/\\/g, "/") + "/agents/x.md", "__H__");
  t(fwd === "__H__/.claude/agents/x.md", "bundle: forward-slash spelling rewritten too", fwd);
  const other = bundle.rewriteForPosix("C:\\Users\\someone-else\\.claude\\pipeline\\x.js", "__H__");
  t(!/__H__/.test(other) || home.includes("someone-else"), "bundle: another user's home is not this machine's", other);
}
