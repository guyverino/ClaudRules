// Late agent answers. A reviewer that finishes after the developer has already typed the next
// prompt reports into the NEXT task's window, where its call is unknown and the answer is
// dropped. Seen on a live session: three angles fired, one or two in the ledger, and the
// scorecard leaning on the missing ones as "quiet". So the digest of task N also re-records task
// N-1 with those answers attached; the ledger keeps the latest row per task, so the fuller one wins.

const ledger = require("./ledger");
const { isTaskOpening, isAgentCall, notificationText, NOTIFY_ID_RE } = require("./transcript");
const { buildDigest } = require("./digest");
const { check } = require("./checks");

function notificationId(rec) {
  const text = notificationText(rec);
  if (!text.includes("<task-notification>")) return "";
  const m = text.match(NOTIFY_ID_RE);
  return m ? m[1] : "";
}

function agentCallIds(records) {
  const ids = new Set();
  for (const r of records) {
    const c = r && r.type === "assistant" && r.message && r.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (isAgentCall(b)) ids.add(b.id);
  }
  return ids;
}

// Rows to append for earlier tasks whose agents answered inside [start, end of tail). At most
// three windows back: an answer older than that is a session that sat idle, not a reviewer.
// Under the hand-back shape (ledger.js) the answer is an `<agent-message from="<agentId>">`
// turn, told apart by the agentId the earlier window's stub named — the notification that
// follows it holds only the usage, so keeping it alone would re-record the task with 0 findings.
function lateRowsFor(all, start, meta) {
  const own = agentCallIds(all.slice(start));
  const ownAgents = ledger.ownAgentIds(all.slice(start));
  const late = all.slice(start).filter((r) => {
    const id = notificationId(r);
    if (id) return !own.has(id);
    const agentId = ledger.handbackAgentId(r);
    return agentId && !ownAgents.has(agentId);
  });
  if (!late.length) return [];
  const rows = [];
  let end = start;
  for (let back = 0; back < 3 && end > 0; back++) {
    let s = end - 1;
    while (s > 0 && !isTaskOpening(all[s])) s--;
    if (!isTaskOpening(all[s])) break; // the tail cut the opening off: nothing to pin it to
    const window = all.slice(s, end);
    const ids = agentCallIds(window);
    const agents = ledger.ownAgentIds(window);
    const mine = late.filter((r) => ids.has(notificationId(r)) || agents.has(ledger.handbackAgentId(r)));
    if (mine.length) {
      const d = buildDigest(window);
      d.meta = Object.assign({}, meta, { recordsInTask: window.length, lateAnswers: mine.length, windowComplete: true });
      // The same count gate-check.js takes before its check — WITH the late answers, which are
      // exactly the batch that may cross the verify-finding threshold; without it the gate is
      // silent on every re-recorded task.
      d.reviewFindings = ledger.angleFindingCount(window.concat(mine));
      const res = check(d, d.meta.cwd);
      rows.push(ledger.buildRow(window.concat(mine), d, d.meta, res));
    }
    end = s;
  }
  return rows;
}

module.exports = { lateRowsFor };
