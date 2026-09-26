# Why the rules say what they say — the measurements

`CLAUDE.md` states the rules; this file keeps the numbers behind them, with dates, so the rules
can stay short and the reasons can still be checked. Every figure below was taken from session
transcripts or the ledger (`pipeline/stats.js`), never from an orchestrator's own report.

## R1 — waiting by hand is the biggest cost (2026-09-10)

Seven tasks, 317 minutes, one session: **131 minutes (41 %)** went to polling background work
with `sleep` — 44 commands shaped `sleep 200; tail -6 …/tasks/*.output`, up to 240 s each. The
builds in that session took 2 minutes in total. Two "legacy" sessions with more agents (49 and
103) were *slower* per task (54 and 114 minutes). So the reviewers were never the cost; the
polling was. → §7 forbids polling; the checker counts sleep seconds (units, loops) and warns from
30 s / 120 s.

## R2 — the tail after the review, not the review, eats the hours (2026-09-11)

One session, 4 tasks, 278 active minutes: the four §6 angles took **22 min (8 %) in parallel** and
returned the acted-on `high` findings. The serial tail after them took ~50 %: `/code-review`
20 min, `fix-diff` 39 min over 11 runs (6 on one button), `/simplify` agents 17 min, an audit
agent 8 min, and **43 `cargo test` runs — 51 minutes**, more than all reviewers together. On one
78-minute task the angles took 4 minutes and the tail 68.

Over 44 ledgered tasks: `flow` + `half-fix` returned **16 acted-on `high`** on 20 reviewed tasks;
`fix-diff` **2 acted-on `high` in 33 runs** against 50 `low`/`medium`; `error-paths` 4 `high`
found, 1 acted, in 14 runs; the audit agent cost 34 minutes and 746 K tokens over 10 runs to
restate what a script prints for free. → the row is 2 angles + one conditional; `error-paths`
became conditional; `/code-review` left every lane; `/simplify` rides refactor only; `fix-diff`
is conditional and runs once; the audit is the checker; the suite runs twice per task.

## R3 — a cheap lane, or the pipeline stops being used (2026-09-10)

A full feature run cost ~590 K subagent tokens and ~28 minutes. On a real session four angles
fired on *every* task, including a two-file hotkey tweak. → the `small` class: one angle, a
build, one driven flow; test `small` first.

## R4 — `verify-finding` (2026-09-10, re-measured 2026-09-16)

Raw batches ran 7–14 findings; a threshold phrased as "~8 after dedupe" landed on the edge every
time and the filter had zero runs against batches of 20–30. Re-measured after 61 runs: **2.7 M
tokens, 44 K per finding**, one haiku agent per finding each re-opening the same 3–4 files; on
two tasks 16 runs changed at most 2 decisions. → the filter is mandatory above 5 raw findings,
and it runs as **one batch agent** over all findings (files read once), not one agent each.

## R5 — the delta pass trigger (2026-09-16)

`fix-diff`: 60 runs, 3.9 M tokens, 140 findings, **7 `high` (5 %)**. Its trigger "post-review
edits span 3+ files" fired on nearly every task — a fix, its test and a doc are already three.
Applied 2026-09-16: the count is files of *code* (test files and documents excluded by folder,
name convention and extension), or a signature; the checker's WARN says "code files".

## R6 — the ledger and the class line (2026-09-16)

515 ledger rows for 191 tasks: every Stop hook and every by-hand digest appended a row. The
reader already dedupes by task key; the by-hand digest now writes no row. 104 of 191 tasks had no
class line — most were questions or plans (no edits), which the summary now reports as `n/a`
instead of `no`. The transcript persists only the FIRST assistant text block of a task: the class
line must be the very first thing said, or the checker reports it missing.

## R7 — the refactor of the pipeline itself (2026-09-16)

`gate-check.js` had grown to 1142 lines, `test.js` to 764 with an `eval` of the source under
test. Split into `lib/` modules and `tests/` per subject: 260 cases green before and after. The
four `/simplify` agents on that refactor returned 88 findings for ~770 K tokens; ~25 were applied,
the rest were behaviour changes refused or duplicates — `/simplify` earns its place on a refactor
and nowhere else.
