#!/usr/bin/env node
// PreToolUse hook on Bash / PowerShell: refuses a command that waits by polling, BEFORE it runs.
//
// §7 says it, the checker warns about it afterwards, and the orchestrator did it anyway — 21
// `until grep -q … ; do sleep 15; done` loops on one feature, four of them a background watcher
// polling an agent's output file while a foreground loop polled the watcher. A WARN in the next
// task's report changes nothing about the turn that already waited; a refusal here does.
//
// Refused: any sleep inside a loop, and a single wait of 30 s or more (§7's smell is ~15 s; the
// checker already notes anything under 30). §7 does allow a wait that is genuinely unavoidable —
// a local handshake that must finish — sized to it and declared; that declaration used to live
// only in the receipt, written AFTER the command, so a hard block here would have made such a
// wait unrunnable. The declaration therefore travels IN the command: a `# unavoidable: <reason>`
// comment lets a single long wait through (the checker still counts it and the receipt still
// owes the SKIPPED: line). A loop never passes — a poll is not a handshake, whatever the comment.
// Exit code 2 blocks the call and hands the reason to the orchestrator; anything else lets the
// command through. A payload this script cannot read lets the command through too — a hook that
// blocks on its own failure is a broken shell.
//
// The reading of `sleep` is digest.js's (bareOf + sleepShape): heredoc bodies and quoted spans
// are not waits, a `sleep` in a script being authored is data. One reading, or the hook would
// pass what the checker later flags.
//
// Cost: one node spawn in front of every Bash/PowerShell call, measured at 30–35 ms (median 32,
// ten runs) on this machine — against a shell turn that takes seconds.

const { readStdin, parseHook } = require("./lib/hook");
const { bareOf, sleepShape } = require("./lib/digest");

const SINGLE_LIMIT_S = 30;
// The reason must be there, on the same line: `# unavoidable:` alone declares nothing, and the
// next command line is not its reason.
const DECLARED_RE = /#[ \t]*unavoidable[ \t]*:[ \t]*\S/i;

function main() {
  const hook = parseHook(readStdin());
  const input = hook.tool_input && typeof hook.tool_input === "object" ? hook.tool_input : {};
  const cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd) return 0;
  const { waits, loop } = sleepShape(bareOf(cmd));
  const longest = waits.length ? Math.max(...waits) : 0;
  let why = "";
  if (loop) {
    why =
      "a sleep inside a loop polls: background work announces itself when it finishes — end the turn " +
      "and read the notification (an agent, a backgrounded build); for a local process condition use " +
      "the Monitor tool, not a shell loop. No declaration passes a loop";
  } else if (longest >= SINGLE_LIMIT_S && !DECLARED_RE.test(cmd)) {
    why =
      "a " + Math.round(longest) + " s wait by hand: §7 sizes a wait to the handshake it waits for (~15 s) " +
      "and everything longer is background work that announces itself — end the turn instead. " +
      "A wait that is genuinely unavoidable is declared in the command itself, `# unavoidable: <what must finish>`, " +
      "and again in the receipt (SKIPPED: reason)";
  }
  if (!why) return 0;
  process.stderr.write("no-poll (rules §7): refused — " + why + ".\n");
  return 2;
}

process.exit(main());
