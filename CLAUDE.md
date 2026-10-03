# Working pipeline (project-agnostic)

How I run any non-trivial task. Stages with **hard gates** — a gate means *do not proceed until
it passes* — or I write into the §10 receipt what failed and why I'm going anyway. The repo's own
`CLAUDE.md` / `AGENTS.md` carries the project-specific facts (build command, components, theme,
deps, the `## Commands` and `## Secrets` blocks); this file is only the structure and the gates.
The measurements behind every number here live in the rules repo, `docs/RATIONALE.md` (cited as
R1…R8): the rules stay short, the reasons stay checkable.

Core stance: **the reviewer and the verifier are a separate agent whose job is to break the
change — not me re-reading my own diff.** A wrong-but-plausible change survives my own
proofreading; it does not survive an adversary. And a green build stays silent on a runtime
defect. Those two blind spots shape every stage; §10 proves the pipeline ran.

Language: everything that lands **in the code is English** — comments, doc comments, log and error
strings, identifiers, commit messages — whatever language we're talking in. Everything I say **to
the developer is in the developer's language**, including the §10 receipt.

## 0. Classify + state the recipe (one line, out loud, before the first edit)

- **trivial** — copy, comment, log text; nothing a caller or the runtime can observe. → stages
  0→4→5→10 (+11 if asked), I eyeball the diff myself. **If it changes anything at runtime it is
  not trivial** — a one-line flip of a threshold, condition, timeout or flag is observable, so it
  routes as **small** when it clears every small condition below, and as *feature* otherwise —
  unless the flip is about speed or timing, which is *perf / behavior* and owes §1's measurement
  first. Never trivial, however few lines it is.
- **rename / signature / contract change** → never trivial: grep every call site first.
- **small** — a contained change with a runtime surface: **1–3 files, one module**, touching
  **none** of: persisted state, the frame loop, the wire/external data, a public signature, or
  money and stored numbers — *computing* one, not merely displaying or passing an existing one
  through. "Touches the wire" means the same thing as the `external data` trigger below: a new
  call, a changed payload or protocol — **re-invoking an existing send path unchanged is not
  touching it**. A new panel button, a label, a filter, a menu entry, a local behavior tweak. Runs
  the cheap lane — one angle, build, one driven flow (R3).
  → **Escalate out loud** — to the class the change actually is, which for a rename is the rename
  row and its `contracts` angle, not feature — the moment any of these appears: the diff passes 3
  files or a second module, the angle returns a `high` finding, or one of the untouchable list
  above turns out to be involved. Escalating costs one restated line; guessing small to save an
  agent costs a defect.
- **feature / refactor** → all stages.
- **bug / regression** → stage 1 produces a repro FIRST; stage 7 replays it fail→pass.
- **perf / behavior** → stage 1 is *measure only*; guessing is banned (§1 gate).

| class | §6 reviewers | §7 runtime verify | §9 delta | §8 /simplify |
|---|---|---|---|---|
| trivial | — I read the diff | — | — | — |
| **small** | **1** (the ground's angle; `half-fix` if none matched) | the flow + its one unhappy branch | conditional* | — |
| rename / signature / contract | 2 (contracts · flow) | if it has a runtime surface | conditional* | — |
| feature | 2 (flow · half-fix) | drive the flow | conditional* | — |
| refactor | 2 (flow · half-fix) | drive the flow | conditional* | yes |
| bug / regression / perf / behavior | 2 (half-fix · flow) | bug/regression: repro fail→pass · perf/behavior: numbers, not adjectives | conditional* | — |

\* §9's condition: the edits made after the review touched **3+ files of code or a signature** —
then `fix-diff` runs once. Tests and docs beside a fix do not count (R5). Otherwise I read my own
delta and the build covers it (§9 says why).

The row is the **only** review (R2): the angles return the acted-on `high` findings; everything
that used to follow them cost most of the review budget and returned `low`/`medium`. `/code-review`
and `/simplify` are not part of any lane — `/simplify` rides refactor, and either runs on request.
The **audit is the checker**, no agent: §10.

**One conditional angle, at most**, added to the row when the change lands on its ground (never
on trivial). The bullets are in **precedence order**: *of the ones that match*, I take the first
my row does not already name — if that leaves none, I add none and say so. This is not a
judgment call; left to judgment it resolves toward the loudest defect, and the loud ones are
already covered. Whichever way it lands goes in the line I state below, or §10 cannot check it:

- `value integrity` — it computes, converts, rounds or bounds money, a size/amount or a time
  interval. Merely passing an existing number through is not a trigger.
- `external data` — it adds a call to the feed, an API or IPC, or changes what an existing one
  sends or expects back (payload, protocol, timing). Calling an existing path again, unchanged,
  is not a trigger — the path was reviewed when it was written.
- `error paths` — it adds a failure mode: a new panic site, a new lock or await, a spawned task,
  or work moved into the update path.
- `seams` — it crosses the frame loop or persisted state, or touches 6+ files.
- `contracts` — a signature, enum, invariant or caller-visible timing changed. The trigger is the
  *behavior* a caller relies on, not the type, or it misses §4's first bullet entirely.
- `type design` — it introduces a new type, or widens an existing one: a struct that can now hold
  a state it should not, an `Option`/`bool` standing in for a state machine, a stringly typed
  field. The trigger is the *shape*, where `contracts` is the behavior.
- `tests` — it changes behavior that a test claims to cover, or adds a branch the suite cannot
  reach. Not "is there a test" — whether the existing one still asserts what it says it does.

The order is silent-first: a signature break is compiler-adjacent and loud, a rounding bug is
silent forever. **The slot stays one**: adding angles to this list widens the *choice*, never the
count — two candidates matching means I take the earlier bullet and say so.

I say the class AND its row in one line before I start — `feature → 3 agents (flow · half-fix +
external data) · drive the panel live · delta if the fixes span 3+ files` — **as the very first
text of the task** (the transcript keeps only the first text block, R6). **Test `small` first**,
against its list, before reaching for a heavier class (R3). Two classes are **never** reachable
through that test, however small the diff: a **bug / regression** owes §1's repro first, and
**perf / behavior** owes a measurement first — `small` says nothing about corrective work, so it
must not swallow it. Unsure between two classes → take the heavier one; that breaks a tie between
two that both fit, it is not licence to skip the `small` test. If the work turns out bigger than I
declared, I re-state the class out loud and run the fuller recipe; a silent upgrade is a skipped
gate wearing a disguise.

🚩 **Gate:** my first `Edit`/`Write` is a STOP — before it I have stated the class and the recipe.
The line I state now is line 1 of the §10 receipt. Not having a plan is not a reason to ask
permission; it's a reason to write one.

## 1. Ground truth (before writing anything)

Read the actual source (including vendored/forked deps, not from memory), the logs, or add a
counter and run.

🚩 **Gate (parallel work — repos with other contributors only):** the same thing must not be
built twice. The test for "other contributors" is the record, not a setting: the SessionStart
hook prints `PARALLEL WORK: n commit(s) by others … · open PRs: m` whenever anyone else has landed
or opened something since my last own commit (`CONTRIBUTORS:` when others commit here but nothing
is pending — then only a mid-task pull re-arms the gate); a repo where only I commit prints
nothing and this gate is `N/A`. When `PARALLEL WORK` is there — or the session pulled new commits
mid-task (a pull, a rebase, a merge, a fetch) in a repo with either line — **before the first
edit** (the first edit after the pull) I run
`node "{{CLAUDE_HOME}}\pipeline\leak-check.js" others` (every commit by others since my
last own commit with the files it touched, and every open PR with its files) and compare it with
the task: same files, same panel, same issue, same symptom. Overlap → I say which commit or PR and
**stop for the developer's call** — extend theirs, rebase on it, or drop the task — never build it
a second time. No overlap → one line, `parallel: none (n commits · m PRs read)`, which is part of
the §10 receipt. `open PRs: unavailable` is not "no PRs": I read them on the forge by hand or say
I could not.

🚩 **Gate:** if my answer to a frequency / perf / behavior question came out of my head → stop, go
measure or read the source first. One measurement beats five prompts of reasoning.

🚩 **Gate:** two failed fixes on the same problem, or a long dig with no working hypothesis → stop
and say so, with what I tried and what I now believe — a long investigation *with* a live
hypothesis is progress.

## 2. Model the runtime (the stage line-scanning skips)

Before changing anything that touches invalidation, updates, or data flow, name the causal chain:
**which slice of data changed → who observes it → who actually needs to re-render.** Before *any*
broadcast/refresh/notify, name the concrete changed input and the concrete consumer.

🚩 **Gate:** if the answer is "so everything updates / to be safe" → that is the defect, not the
fix. A periodic "just refresh" is not an invalidation model. Rework it.

## 3. Plan (feature / refactor)

Which files, which existing component I reuse, where it goes through the shared theme/config.
Split new code into modules up front rather than growing one file; follow the repo's established
module/panel pattern, don't invent a parallel one.

🚩 **Gate:** about to hand-roll something the framework/component library already provides → stop,
use or extend the existing one.

## 4. Implement

No values hardcoded next to a theme/config source of truth. Port migrations verbatim — don't
redesign logic mid-move. Prefer reading an authoritative flag over reconstructing state by
heuristic (disappearance, grace timers, "probably done"). Don't edit vendored/forked deps unless
explicitly asked — work around in the app layer and log the fork bug.

The five that bite silently (the shapes are generic; the project file names its own):

- Changed what a function *does* without changing its type → **the compiler stays silent**: a fn
  that used to abort now returns nothing, a new variant lands in a catch-all arm that swallows it,
  a caller depended on the old timing. Grep every call site and check each caller's assumption by
  hand.
- No unchecked unwrap / index / cast on anything empty-able, absent, or coming from the network or
  the user — a panic inside a hot loop takes the whole app down.
- Nothing blocking (I/O, a contended lock, a sync request) runs inside a per-frame or per-tick
  update; it goes to a task and comes back over a channel.
- Changed a persisted/serialized struct → an *existing* saved config must still load. Test
  against a real old file, not a freshly written one.
- Never edit from a remembered copy: if a build or a formatter ran since I read the file, re-read
  the region before editing it.

🚩 **Gate (decommission):** when this change supersedes something — migration, replaced impl,
removed feature — the orphaned old code sits OUTSIDE my diff, where every §6 agent is structurally
blind to it. Replacing a fn deletes the old one; moving code removes it from the source; renaming
leaves zero refs to the old name; no compat aliases. Before §10 I grep every symbol I superseded:
zero hits, or each survivor deferred with a stated reason.

## 5. Compile + static gates

🚩 **Foreign code is reviewed for leaks BEFORE the first build that includes it.** Build scripts,
code generators and dependency code (`build.rs`, a `postinstall`, a proc-macro) run at compile
time, with this user's rights — a build "just to see" is already the execution. When the session
opens with `LEAK REVIEW PENDING` (the SessionStart hook, `leak-check.js status`), or the publish
step finds commits by other authors on `origin/main` past the reviewed marker, I do not run the
build until: `node "{{CLAUDE_HOME}}\pipeline\leak-check.js" diff --out <scratch file>`
(the project's declared secret surface, the foreign commits' code, the lockfile delta, moved fork
pins with their diffs, and a signature pre-scan) → ONE background **`leak-review`** agent on that
file (opus, read-only; it reads the whole report once in a throwaway context — pulling that into
my own context would be paid on every later call) → its `VERDICT:` line goes into the §10 `check:`
line → `leak-check.js mark`. `SUSPECT` stops the task and goes to the developer with the cited
path; `UNSURE` is not `CLEAN`. My own commits are never in the file.

**What is secret is the project's to declare, not these rules'.** The repo file carries a
`## Secrets` section — the files, modules, types and paths that hold credentials, key material or
encrypted config, where their plaintext legitimately flows, and the guards that must stay — and
`leak-check.js` copies it into the report as the agent's first item, its names into the pre-scan.
A project with no such section is not exempt: the agent then hunts credentials, keys and encrypted
config on its own and says so in the verdict, and the missing section is a finding I write into
the repo file — a bootstrap, like the `## Commands` block below. A tracked repo file keeps it with
the code, and once it is on `origin/main` past the marker the review reads it at the reviewed base
(until then the report shows the working-tree copy, labelled); a gitignored one is per clone, and
a fresh checkout starts without it — the repo's own hygiene rules decide which, and I say which.

🚩 **Gate (release surface — repos that ship releases):** the same repo file carries a
`## Release surface` section — the paths that decide what users download and run as an update:
the release workflow and the scripts it calls, the CI that gates `main`, the contract test that
pins the publish gate, the in-app updater with its digest check, the contributor rules that
describe the gate. A change there by anyone else is how a release gets something built into it
that the source never showed, so it is never silent: the SessionStart hook prints
`RELEASE SURFACE CHANGED by <author> — <sha> <subject> — <files>` for every commit by others past
its own marker (`.git/release-surface-seen`, pinned at my last own commit on first sight), and
`RELEASE SURFACE in open PR #n` for every open PR touching one, as long as it is open; `others`
prints the same, and the leak report lists them as item 1b, where the agent's verdict names
each touched file. The line is an alarm, not a verdict, and it is **mine to clear by hand**: I
open each cited diff (`git show <sha> -- <file>`) and say in one line what it changed **before
any build, publish or release from that tree** — then
`node "{{CLAUDE_HOME}}\pipeline\leak-check.js" ack-release`. `mark` does not clear it,
and neither does my own merge on top; the checker (§10) WARNs on a build, a push, a forge merge
or `/publish` that came before the ack, the way it does for a build before `mark`. `UNKNOWN` (git or gh failed) is read by hand on the forge,
never taken as clean. A task of mine that edits one of those paths is never `small` — it routes
as *feature*, its §0 line names the path, and the §10 `check:` line says `release surface:
<file> edited by me`. A repo that ships releases and declares no section gets one, like
`## Secrets` above; a repo with no release pipeline says `N/A` here.

🚩 **Bootstrap (first contact with a repo, once):** if the repo file doesn't spell out the
**build / lint / format / test / run** commands, I don't guess and I don't skip. I read the
manifest, the CI workflow, the task runner; I run each to confirm it works; I write them into the
repo file as a `## Commands` block.

Run the formatter **once, here, before the build** — never as a hook on every edit: a formatter
that fires after each `Edit` moves the lines under my own next edit, and §4's last bullet then
bites on every second change. One run at this gate costs nothing and leaves the tree clean.

Run whatever *static* checks the repo has — contract tests, lint, format: they catch architecture
violations (hardcode, wrong layer, banned imports) before runtime. Contract tests that live inside
the test suite are not run here: they ride the suite's one run at the end of the task (§6, R8).
Build with the exact command
from that block — all targets and features (conditional blocks, tests, benches and examples are
where a signature break hides), plus the linter with **warnings denied**.

🚩 **Gate:** clean build **and** green static checks. A build that doesn't compile is never
bypassable. A *pre-existing* failure may be stepped over only if I name it and show it also fails
on an unmodified tree. "No static checks configured" is a finding to report, not a pass. **Never
validate the wrong build artifact** — same profile, same features as the change ships under; if it
only manifests under another profile, that's the one I build.

## 6. Adversarial review (separate agents — never me re-reading my own diff)

Instrument: one **named agent** per angle, defined in `~/.claude/agents/` and told there to
**refute, not confirm** — a fresh context is the whole point. Each definition carries its own
search procedure, return contract and read-only tool set (`Read, Grep, Glob` — no shell, no write
tools), so a reviewer physically cannot touch the tree while the build runs. `/code-review` runs
inline and inherits this session's context, my reasoning included, so it is never one of the
row's angles and is **not part of any lane** (R2). On request only; never `--fix` — it writes to
the tree.

Each agent gets the changed-file list, the diff, the repo file, and one paragraph of intent —
**never my reasoning for why it's correct**: it's the thing under test, and it comes back as
agreement. They have no shell, so whatever they must see travels in that prompt.

Fire every reviewer as parallel Agent calls in ONE response, each by its own name — and put the
build command in that same response, so the build runs while they do. One response, never a chain
of one-agent responses.

Each name is a different **search procedure**, not a different topic — fire exactly the ones my
§0 line named, no more and no fewer:

| # | angle | agent | appears |
|---|---|---|---|
| 1 | flow | `flow` | in a row |
| 2 | half-fix & consistency | `half-fix` | in a row |
| 3 | contracts & call sites | `contracts` | in the rename row · also a conditional |
| 4 | error paths & concurrency | `error-paths` | conditional only (R2) |
| 5 | seams | `seams` | conditional only |
| 6 | external data | `external-data` | conditional only |
| 7 | value integrity | `value-integrity` | conditional only |
| 8 | type design | `type-design` | conditional only |
| 9 | tests | `tests` | conditional only |

The §0 rows name only angles 1–3; 4 through 9 ride a §0 trigger and never a row. §0 spells the
names with spaces ("error paths", "external data"); the agent to invoke is the hyphenated id in
this table. What each one actually hunts is in its own file; if an angle keeps coming back thin, I
fix that file rather than padding the prompt.

Return contract (enforced in every agent file): a compact list of `file:line — one-line claim —
severity`. No prose, no code quotes, **no suggested fixes** — I derive the fix from the cited line
myself.

**When a batch comes back with more than 5 findings** (counted BEFORE dedupe), the
`verify-finding` pass is **not optional** (R4). It runs as **ONE agent for the whole batch**: I
number the findings, hand it the list, the changed-file list and the diff, and it opens the cited
lines once and returns one line per finding, `#n · score 0–100 · why`. Drop only what scores
**under 60** — the band above that is "plausible but unconfirmed", and the gate below forbids
dismissing exactly that — and say how many fell. This is a **pre-filter, not a verdict**: what
survives still goes through the gate below by hand. Five or fewer findings — skip it and open them
myself; the filter costs more than it saves at that size. A batch **dominated by `high`** is not an
exemption either: those are the claims where being wrong is most expensive. Nor is a batch
**dominated by `low` or by doc/comment findings** — "ten of them are stale doc lines, grep is
cheaper" is my own judgement put back in the seat the filter was built to take, and the checker
reads the count from the agents' answers, so the skip surfaces as a WARN whatever the receipt says.

🚩 **Gate:** dedupe by `file:line`, then open every cited line and re-derive severity myself — a
finding is a hypothesis, not a diagnosis. Most skeptical of race claims: agents routinely miss an
outer lock or an interleaving that can't happen inside one frame. Every finding ends either fixed
or **refuted against the source** — never dismissed as "sounds plausible either way", never
auto-applied because it sounded confident. When a finding turns on how a third-party API or
protocol actually behaves, **I fetch its current docs myself** before accepting or refuting it — a
stale-API mismatch is invisible to pure code-reading, and §10 names the library and what I
checked. Confirmed fixes go in as ONE batch, then §5's build and static checks re-run once — and
the suite takes its one run (below). Zero findings is legitimate
only if I say "0 findings" out loud.

🚩 **The full test suite runs ONCE per task, at the end** (R2, R8): after the last edit — this
batch, or the §8/§9 edits when they follow it, or the §5 build when nothing was fixed — never at
the §5 gate and never after every edit. **When §9 owes a `fix-diff`, the suite waits for its
answer** — never started beside it or before it: finding a reason for one more edit is that
agent's whole job, and the moment it finds one the suite runs again on the fixed tree. Beside
`fix-diff` only the build and the linter run (the §5 re-run the batch owes anyway); the suite
follows its answer — after its fix, or after "0 `high`".
A red end-of-task run, its fix and the re-run is the one tolerated second run. It runs through the
recorder, so the tree it passed on is remembered and the publish step does not test it again:
`node "{{CLAUDE_HOME}}\pipeline\tested-tree.js" run -- <the repo's suite command>` — spelled
exactly as the repo's publish step spells it, because the record matches on the command — and
before any suite run in a later step (a publish, a post-merge check),
`… tested-tree.js check -- <the same command>`: exit 0 = this exact tree already passed under this
exact command, skip it and say so; any other exit = run it, through `run`. A bug's repro test (§1,
§7) is targeted and is not this run. Between edits a `build` is enough; a **targeted** run on the one
failing case (`cargo test -p crate name`) is the build-equivalent and is not bounded — but it is
run **once per edit**: the same command again with nothing changed between only re-prints what
was already on screen, and each re-run is a whole turn over the full context. The batch itself
lands in **one pass**: every confirmed fix, then one build — not fix, check, next fix, next check
(seven checks in 76 s on one round). The checker counts the full suite past two on one tree (a
pull, rebase or switch puts a new tree under the next run), the repeat without an edit, and the
fix-by-fix build ping-pong after the review.

## 7. Runtime verification (the strongest gate)

Tests + review + green build stay silent on behavioral/resource defects — so *drive the actual
flow and observe it*:

- touched render/perf → re-measure with the counters; did real work actually drop, not "looks
  smoother".
- touched a behavior with a harness/smoke → run it (non-zero exit = fail).
- touched visible UI → drive it and **look at the frame** (screenshot); never infer it from the
  code.
- otherwise → exercise the real flow end to end and watch the result.
- always → drive at least one **unhappy** path: the error branch, the empty list, the dropped
  connection. Not only the path I built the feature for.

🚩 **Never poll with `sleep`** (R1). A task started in the background **announces itself** when it
finishes; waiting for it by hand is pure loss. Rules: work started in the background is not polled
— I do something else and read the notification; external state the harness cannot see (a CI run,
a deploy) gets ONE wait sized to how fast that state actually changes, never a blind 200 seconds; a
foreground `sleep` longer than ~15 s is the smell itself. When a wait genuinely has no alternative
— a local process that must finish handshaking before I can drive it — the wait is sized to that
handshake and stated in §10, not rounded up to a comfortable number. The checker counts the whole
task: a note under 30 s, a WARN from 30 s, a louder WARN from 120 s, and a WARN for any `sleep`
inside a loop. A wait I declared as unavoidable is excused the same way every other gate is:
`SKIPPED:`/`N/A:` with the reason, on the receipt line. And since the WARN came a task too late
to save the turn that waited, a **PreToolUse hook (`pipeline/no-poll.js`) refuses** a shell
command with a `sleep` inside a loop or a single wait of 30 s or more before it runs — the
refusal names §7; the answer is to end the turn and read the notification, or the `Monitor` tool
for a local process condition, never a reworded loop. The one wait §7 allows — the unavoidable
handshake — is declared **in the command itself**, `# unavoidable: <what must finish>`, and the
hook lets that single wait through; the receipt still owes its `SKIPPED:` line, and no
declaration passes a loop.

🚩 **Bootstrap (once per repo):** verification needs an **observation channel**, which a GUI lacks
by default. The repo file must name at least one: a run command that launches into a known state;
a counter/probe I read back after driving the flow; a smoke command that exits non-zero; or a path
the app writes a frame to. If none exists I build the cheapest one that fits the change, use it,
and write it into the repo file.

🚩 **Gate:** "it works" ≠ "it's done" — I checked the **side-effects** and modeled the whole
runtime, not just the happy path. I state the concrete observation: "repaints 60/s → 0 idle",
"smoke exited 0", "frame at /tmp/x.png shows the panel" — never "looks smoother". If I did *not*
verify live, §10 reads `NOT VERIFIED LIVE: <reason>` **plus the one thing that would have verified
it**. That string is a defect I'm handing over, not a pass — and the reason must be a fact about
the environment I can't change this session (no display, no credentials, needs a live feed). "No
harness exists" is not a reason — that's the bootstrap above. The one other exit is `N/A: no
runtime surface`, and it is a claim about the **diff** — nothing this change does is observable at
runtime. A feature always has a surface; if I'm reaching for N/A on one, I've misclassified it.

## 8. Cleanup

**Refactor only** (§0's table, R7), or when asked. Run `/simplify` over the diff for reuse /
simplification / dead code / altitude — **after** the §6 fixes land, over the already-fixed tree,
never concurrently with them (both write), and **before** any `fix-diff`. Read its diff once, on
the spot, and revert anything that alters behavior — I am the only one who knows what the behavior
was *supposed* to be. Its edits get no verification round of their own: they count toward §9's
condition like every other post-review edit.

On every class, grep for names this change retired — a dead-code lint won't catch them: a public
item and a never-true branch both look alive.

## 9. Delta (the exit check)

Everything I wrote after §6 — the fixes, the cleanup edits — is the least-reviewed code in the
change. **Condition:** those edits touched **3+ files of code or a signature** — a test file or a
document beside a fix is not a third file (R5: the old count fired on nearly every task and
returned 7 `high` in 60 runs) → one **separate agent**, `fix-diff` — *did these edits break, or fail
to actually fix, what they claim?* Scope: exactly those edits plus the call sites and readers of
what they touched — not a re-hunt of the tree §6 already covered.

Below that condition I read my own delta and the build covers it. This is the one place the
pipeline trusts my proofreading, and it is a measured call (R2), not a mood.

🚩 **Gate:** it runs **once**. A confirmed `high` → fix, build, and I read that fix myself — no
second run; the checker warns on it. The full suite (§6) is not started until this answer is
in — the build and the linter may run beside it, the suite may not; the checker warns on a suite
launched before the answer when its fix then re-ran it. A suite started after the answer that
goes red, its fix and the re-run is §6's tolerated second run, not this. Wrote nothing after §6 → §6
already covered the shipping tree; say so in §10.

## 10. Receipt — this block IS my completion message

This block is how I report a finished task; there is no other format. If I'm about to type "done"
in any other shape, I'm writing this instead. No block = not done. Sized to the task — trivial
collapses to a single line; otherwise every line is present and `N/A` is never deleted. If writing
it reveals a stage I skipped on autopilot, I go run that stage instead of writing the excuse.

```
Class + recipe: <what I stated at §0>
1 ground truth:  <file:line I read / the number I measured | N/A> · parallel: <none (n commits · m PRs read) | overlap: <sha/#PR> — stopped | N/A: no other contributors>
2 runtime model: <changed X -> observed by Y -> re-renders Z | N/A>
4 decommission:  <superseded symbols grepped, 0 hits | deferred: sym — reason | N/A>
5 build+static:  <exact command> -> <pass | fail: ... | no static checks — reported>
6 review:        <N agents · angles fired · conditional: <which | none added: trigger I checked + why not>>
  findings:      <n: n fixed / n refuted | 0 findings> · verify-finding <n dropped | N/A: ≤5>
  refuted:       <file:line — why it doesn't hold | none>
  docs checked:  <library/protocol + what I verified | none needed>
7 runtime:       <flow I drove -> what I observed | N/A: no runtime surface | NOT VERIFIED LIVE: <reason> + would need: <the one check>>
8 cleanup:       </simplify read, n reverted | N/A: not refactor> · retired names grepped: <0 hits | ...>
9 delta:         <fix-diff ran once, n findings | read myself: <n> files, no signature | nothing written after §6>
check:           <gate-check by hand: clean | WARN ... — <fixed | why it stands> · report: gate-report-<session>.txt | N/A: trivial> · leak-review: <VERDICT: … (n commits) | N/A: no foreign commits this session> · release surface: <sha — what it changed, read by hand, ack | none pending | <file> edited by me | N/A: no section>
Deviation from the §0 recipe: <none | ...>
```

A skipped gate goes in as SKIPPED with a reason — a skip I don't write down is a lie. Filling a
line with a claim I didn't perform is worse; every line names a concrete artifact.

🚩 **Check (every class but trivial):** the receipt is my own account of myself, so it is not the
evidence. `~/.claude/pipeline/gate-check.js` reads the session transcript straight from disk and
compares what I declared with what the record shows — class line vs edits, angles named vs agents
fired, `fix-diff` count, `/simplify` order, test-suite runs, `sleep`, the receipt — and writes
`last-task-<session>.json` plus `gate-report-<session>.txt` beside it, per session, because several
run at once. There is no audit agent (R2).

It runs two ways, and the order matters: the **Stop hook** fires only when my turn ends, so the
digest it leaves behind describes the *previous* task. So before the receipt I run it **myself**,
from the repo root:

```
node "{{CLAUDE_HOME}}\pipeline\gate-check.js" digest --hand
```

Absolute path and `--hand` both matter: PowerShell does not expand `~` for a native argument, and
without the flag the script blocks on a stdin nobody is writing. **Check the `session:` and
`task prompt:` lines it prints against my own task** — with several sessions live in one repo the
newest journal is regularly a neighbour's. When they do not match, pin it: `--session <id>`. It
writes its digest to `hand-<session>.json`, never to the hook-owned files, and no ledger row. Every
WARN it prints goes into the `check:` line — fixed, or explained out loud; a WARN I drop quietly is
a skipped gate. The report path goes there too, so the check is the developer's to read, not only
mine.

The checker has its own regression suite — `node "{{CLAUDE_HOME}}\pipeline\test.js"`,
non-zero exit on failure. Every case in it is a hole that shipped once; after ANY edit under
`pipeline/` I run that instead of re-reading the diff.

🚩 **Review the reviewers (every ~20 recorded tasks, or when asked).** The same pass writes one
accounting line per task to `ledger.jsonl` — what each angle cost and what it caught, taken from
the transcript, never from my report. `node "{{CLAUDE_HOME}}\pipeline\stats.js"` turns it
into a scorecard and proposes measures at fixed thresholds: an angle with zero *unique* findings
acted on over 12+ runs leaves the row for the conditional list; under 40% acted on — judged over
at least 20 findings, so one of them cannot flip the verdict — means its search procedure gets
narrowed; mostly duplicating another angle means folding the two; three times the median cost per
useful finding means a cheaper model. **A proposal is not an action** — I apply one only after
reading the angle's own file, and the measure is never "delete": an angle with rare but serious
catches always looks worse in a table than a chatty one. Two things the table cannot see, and I
say so rather than pretending otherwise: it dedupes by exact `file:line`, so two angles describing
the same defect at different lines both count as unique; and misses — what the review let through
— are not in it at all.

The Stop hook stays as the part I cannot skip: if a task opens with a `<pipeline-gate-check>`
block, that is the previous task's report resurfacing — read it and say plainly whether a gate was
really skipped before starting the new work.

## 11. Commit (only when asked)

Follow the repo's commit conventions. Keep internal/working docs out of a public repo.

**The rules themselves live in a repo too** — the developer's own rules repo (public; only the developer pushes), whose checkout
on this machine is recorded in `~/.claude/pipeline/rules-repo.local` (written by its `install.js`,
never exported). A task that edited `~/.claude` (this file, an agent, anything under `pipeline/`)
or a project's gitignored skill ends with the export — and this is the one push that needs no
asking: that repo is the developer's own mirror of this machine, created for exactly this; the
ask-before-push rule is about the project repos:
`node "{{CLAUDE_HOME}}\pipeline\export-rules.js" --project <repo> --commit "rules: <what
changed>" --push` (the checkout path comes from that file; a positional path overrides it).
Skipped, the checkout drifts behind this machine and the next install elsewhere brings back the
old rules.

## The principle over all of it

**Model the runtime; don't scan lines.** "Find all problems" ≠ "find bugs in the shown code" —
trace the whole update/observe/render graph, not suspicious-looking lines. A sin outlives the test,
the review and the green build; only §2 (model) and §7 (runtime) catch it.

## Cost note

What scales with the task — its class, plus the one ground it lands on — is the **width** of §6,
never its existence: it fires on everything but trivial, and §7 on everything with a runtime
surface. The parallel reviewers are the default, not the expensive option — backgrounded behind the
build, they cost wall-clock once. The heavy runtime harness is what scales down on a small change,
not §7 itself: every non-trivial change gets **some** observation, even if it's one counter or one
screenshot. "Too expensive" is a reason to run the narrow version and say so in §10 — never a
reason to run zero.
