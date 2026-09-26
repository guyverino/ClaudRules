// The payload Claude Code pipes into a hook on stdin, read the same way by every hook script.
//
// Only a hook feeds us a payload. Reading fd 0 when nothing is piped in blocks forever, which is
// exactly what a by-hand run does, so that case must opt out explicitly (--hand) or be detected
// as an interactive terminal.

const fs = require("fs");

function readStdin() {
  if (process.argv.includes("--hand") || process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// A hook payload carrying an unescaped Windows path fails JSON.parse; the fields we need are
// still recoverable by pattern, so never let a malformed payload silence the whole check.
function parseHook(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {}; // `null`, a number, a string: a payload with no fields
  } catch {
    const field = (name, jsonEscapes) => {
      const m = raw.match(new RegExp('"' + name + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
      if (!m) return "";
      // Two kinds of backslash live in a payload that failed to parse. A PATH carries the raw,
      // unescaped kind — that is the failure this fallback exists for — and `C:\temp` must stay
      // `C:\temp`, so only a doubled backslash is folded there. A COMMAND was escaped properly
      // (the path was the culprit, not it): its `\n` between clauses, `\"` around an argument,
      // `\\` in a path are JSON escapes, and left as text `until … ;\ndo sleep` would not read
      // as a loop and the no-poll hook would pass it.
      if (!jsonEscapes) return m[1].replace(/\\\\/g, "\\");
      return m[1].replace(/\\(["\\/nrt])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t" })[c] || c);
    };
    return {
      session_id: field("session_id"),
      cwd: field("cwd"),
      transcript_path: field("transcript_path"),
      // The PreToolUse payload's one field the no-poll hook reads; absent on the lifecycle hooks.
      tool_name: field("tool_name"),
      tool_input: { command: field("command", true) },
      malformed: true,
    };
  }
}

module.exports = { readStdin, parseHook };
