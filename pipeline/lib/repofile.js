// The project's repo file and its declared sections. Two of them are read by the pipeline today:
// `## Secrets` (what the leak review protects first) and `## Release surface` (the paths that
// decide what users install as an update). One reader for both, so the base-vs-working-tree
// rule below holds for every declaration the same way.
//
// The copy at the REVIEWED BASE wins whenever the file exists there: the declaration sits on the
// same side of the trust boundary as the code under review, and a foreign commit that trims an
// entry — or deletes the file, which the SessionStart ff-merge has already pulled by the time
// this runs — would otherwise rewrite the baseline of the very review that should catch it.
// Judged by the base, not by the current index, for exactly that deletion case. A file absent
// at the base is read from the working tree and labelled so: an untracked one (a gitignored docs
// folder) has no base at all, and a tracked one added since is the developer's own bootstrap
// until `mark` moves the base past it — the pre-scan's "declaration edited" hit says whether the
// commits under review touched it, and the label tells the agent which copy it is reading.

const fs = require("fs");
const path = require("path");
const { git } = require("./git");

const REPO_FILES = ["AGENTS.md", "CLAUDE.md", "docs-internal/AGENTS.md", ".claude/CLAUDE.md"];

// Every `## <heading>` section across the repo files (all that exist), each labelled with the
// copy it came from. `heading` is matched as whole words at the start of the title; the title
// may carry a tail (`## Secrets (what the review protects)`), and `## Secretsfile` is not a hit.
function section(root, base, heading) {
  const parts = [];
  for (const rel of REPO_FILES) {
    let text = base ? git(["show", base + ":" + rel], { cwd: root }) : null;
    let at = text === null ? "working tree" : "reviewed base " + base.slice(0, 12);
    if (text === null) {
      try {
        text = fs.readFileSync(path.join(root, rel), "utf8");
      } catch {
        continue;
      }
      if (base) at = "working tree — NOT at the reviewed base; a 'declaration edited' hit below means the commits under review wrote it";
    }
    // From the heading to the next `## ` heading (or the end); `### ` sub-headings stay inside.
    const re = new RegExp("^##[ \\t]+" + heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b[^\\n]*\\n([\\s\\S]*?)(?=^##[ \\t](?!#)|(?![\\s\\S]))", "m");
    const m = text.match(re);
    if (m && m[1].trim()) parts.push({ file: rel, at, text: m[1].trim() });
  }
  return parts;
}

// Every backticked entry of a section, in order, deduplicated. The callers decide what an entry
// means: a secret token for the pre-scan, a path pattern for the release surface.
function backticked(sections) {
  const out = new Set();
  for (const s of sections) for (const m of s.text.matchAll(/`([^`\n]{1,200})`/g)) out.add(m[1].trim());
  return [...out];
}

module.exports = { REPO_FILES, section, backticked };
