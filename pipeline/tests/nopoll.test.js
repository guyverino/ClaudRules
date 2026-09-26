// The no-poll hook: refuses a sleep loop or a 30 s+ wait before the shell runs it (§7), lets
// everything else through — including a payload it cannot read. Run as a process, the way the
// harness runs a hook: exit code and stderr are the whole contract.

const { t, tPath } = require("./_harness");
const { spawnSync } = require("child_process");

const SCRIPT = tPath.join(__dirname, "..", "no-poll.js");
const run = (payload) => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: payload, encoding: "utf8" });
  return { code: r.status, err: r.stderr || "" };
};
const cmd = (command, tool) => JSON.stringify({ tool_name: tool || "Bash", tool_input: { command } });

{
  const loop = run(cmd("until grep -q 'done' out.txt 2>/dev/null; do sleep 15; done; cat out.txt"));
  t(loop.code === 2 && /inside a loop/.test(loop.err), "nopoll: until … sleep loop refused", [loop.code, loop.err.slice(0, 60)]);
  const ps = run(cmd("while (-not (Test-Path x)) { Start-Sleep -Seconds 5 }", "PowerShell"));
  t(ps.code === 2, "nopoll: PowerShell loop refused", ps.code);
  const long = run(cmd("sleep 60; tail -c 1500 task.output"));
  t(long.code === 2 && /60 s wait/.test(long.err), "nopoll: a 60 s wait refused", [long.code, long.err.slice(0, 60)]);
  t(run(cmd("sleep 10; curl localhost:8080/ready")).code === 0, "nopoll: a 10 s handshake wait passes", true);
  t(run(cmd("cargo build -p a && ./run.sh")).code === 0, "nopoll: no sleep passes", true);
  // A sleep in a script being authored is data, not a wait.
  t(run(cmd("cat > s.sh <<'EOF'\nwhile true; do sleep 60; done\nEOF")).code === 0, "nopoll: heredoc body is not a wait", true);
  t(run("not json at all").code === 0, "nopoll: an unreadable payload lets the command through", true);
  t(run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "x" } })).code === 0, "nopoll: no command field passes", true);
}

// The review batch on the hook: a loop followed by a one-time wait is not a poll; a declared
// unavoidable wait passes (a loop never does); a payload that fails JSON.parse still yields
// its command through the pattern fallback.
{
  t(run(cmd("for f in a b; do cp $f out/; done; sleep 5; ls out")).code === 0, "nopoll: loop then a short wait after `done` passes", true);
  t(run(cmd("while (1) { git pull }; Start-Sleep -Seconds 3", "PowerShell")).code === 0, "nopoll: PowerShell loop then a wait after `}` passes", true);
  t(run(cmd("sleep 45; curl localhost/ready  # unavoidable: core handshake takes 40 s")).code === 0, "nopoll: a declared unavoidable wait passes", true);
  t(run(cmd("sleep 45  # unavoidable:")).code === 2, "nopoll: the declaration needs a reason", true);
  t(run(cmd("until [ -f x ]; do sleep 5; done  # unavoidable: waiting")).code === 2, "nopoll: no declaration passes a loop", true);
  // An unescaped Windows path in `cwd` (the shape hook.js documents) breaks JSON.parse; the
  // command is still there by pattern, its `\n` escape included.
  const broken = String.raw`{"session_id":"s","cwd":"C:\Users\x","tool_name":"Bash","tool_input":{"command":"until grep -q done out.txt;\ndo sleep 15; done"}}`;
  t(run(broken).code === 2, "nopoll: a payload that fails JSON.parse still yields its command", run(broken).code);
}

// The delta pass on the hook and its shared reading of a loop.
{
  t(run(cmd("while ($true) { if (Test-Path x) { break }; Start-Sleep 5 }", "PowerShell")).code === 2, "nopoll: PS poll with a nested block is still a loop", true);
  t(run(cmd("while true; do for f in a; do echo $f; done; sleep 5; done")).code === 2, "nopoll: a poll with an inner for…done is still a loop", true);
  t(run(cmd("sleep 45  # unavoidable:\nls")).code === 2, "nopoll: the reason must be on the declaration's line", true);
}
