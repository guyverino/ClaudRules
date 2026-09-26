// The agent definitions: every review angle and the delta pass share one return contract and one
// set of hard rules — the orchestrator parses the answers with one regex (ledger.js FINDING_RE),
// so the block must be byte-identical across them. Claude Code agent files have no include, so
// the copy lives in each file; this test is what keeps the ten copies from drifting apart.

const { t, tRoot, tFs, tPath } = require("./_harness");

const AGENTS = tPath.join(tRoot, ".claude", "agents");
// The scoring filter and the leak review answer in their own shapes (a score, a VERDICT line).
const OWN_CONTRACT = new Set(["verify-finding.md", "leak-review.md"]);

if (tFs.existsSync(AGENTS)) {
  const files = tFs.readdirSync(AGENTS).filter((f) => f.endsWith(".md"));
  const block = (f) => {
    const text = tFs.readFileSync(tPath.join(AGENTS, f), "utf8");
    const at = text.indexOf("## Return contract");
    return at === -1 ? null : text.slice(at).replace(/\r\n/g, "\n").trim();
  };
  const shared = files.filter((f) => !OWN_CONTRACT.has(f));
  const blocks = new Map(shared.map((f) => [f, block(f)]));
  const missing = [...blocks].filter(([, b]) => b === null).map(([f]) => f);
  t(missing.length === 0, "agents: every angle carries a Return contract", missing.length ? missing : "all");
  const distinct = new Set([...blocks.values()].filter(Boolean));
  t(distinct.size === 1, "agents: the contract + hard rules block is identical across " + shared.length + " angles", distinct.size + " variant(s)");
  // The front matter every agent needs: a name matching its file, read-only tools, a model.
  for (const f of files) {
    const text = tFs.readFileSync(tPath.join(AGENTS, f), "utf8");
    const name = (text.match(/^name:\s*(\S+)/m) || [])[1];
    const tools = (text.match(/^tools:\s*([^\n]+)/m) || [])[1] || "";
    t(name === f.replace(/\.md$/, ""), "agents: name matches file " + f, name);
    t(/^(Read|Grep|Glob)(,\s*(Read|Grep|Glob))*$/.test(tools.trim()), "agents: read-only tools in " + f, tools.trim());
  }
} else {
  t(true, "agents: no agents/ under this root (sandbox without agents)", "skipped");
}
