---
name: publish
description: Publish a local change to Moonbot-Tech/MoonTerminal as a Pull Request and land it on main. Creates/uses a topic branch, rebases onto origin/main and resolves conflicts locally, runs the local gates (cargo fmt --check, build --all-targets, clippy -D warnings, cargo test, FireTest when a runtime surface is touched), reconciles the open GitHub issues (Closes / Refs, rewrite or split the partly-done ones after merge), pushes and opens a PR, then waits for CI to pass before squash-merging. Trigger on "выложи правку" / "publish my change" / "open a PR" / "/publish".
---

# Publish a change as a Pull Request

`Moonbot-Tech/MoonTerminal` is **one shared, PUBLIC repo**; contributors are Collaborators
who push **topic branches** to `origin` and open PRs — there are no per-person forks. CI on a
PR (`.github/workflows/build.yml`) builds the **release `.exe`**, runs **`cargo fmt --check`**
and **`cargo test --workspace`** (both blocking) and cargo-deny; it does **not** run clippy — so
clippy is OUR local gate, and every gate's result goes into the PR body.

The full written rules live in `docs-internal/AGENTS.md` → "Collaboration & Publishing". This
skill is the executable checklist. Do the stages in order; **stop and ask** the developer on
any unresolved conflict or any red gate — never publish over one.

## 0. Preconditions

- `gh` CLI must be authenticated (`gh auth status`). If not, stop and tell the developer.
- The working tree change is committed as one or more **conventional commits** in English
  (`feat(scope): ...`, `fix(scope): ...`, `chore: ...`), lowercase description, no trailing
  period, first line < 72 chars, and **no `Co-Authored-By` trailer**. If there are uncommitted
  changes, commit them first (ask for the message intent if unclear).
- Optional arg is the PR title, e.g. `/publish "feat(header): core selector before rate ticker"`.

## A. Get onto a clean topic branch

`main` is **read-only locally** — never push to it, never open a PR from it.

1. `git branch --show-current` — determine where we are.
2. **If on `main`** and it carries local commits not on `origin/main`:
   - Create the topic branch at the current tip: `git switch -c <type>/<slug>` (type ∈
     `feat|fix|chore`; slug = short kebab of the change).
   - Reset local `main` back to the remote: `git branch -f main origin/main` (do this only
     after the topic branch captured the work — verify `git log <branch> --oneline` shows it).
3. **If already on a topic branch**, keep it. Pick/confirm a branch name that matches the change.

## B. Sync onto origin/main (rebase) and resolve conflicts locally

A green build from *before* the sync says nothing about the merged result — always rebase, then
re-gate.

4. `git fetch origin`.
5. `git rev-list --left-right --count origin/main...HEAD` — how far behind/ahead we are.
5b. **Leak review of what came in from others** — before the rebase pulls their code under our
    build, from the Bash tool: `node "$HOME/.claude/pipeline/leak-check.js" status --hand`. Silence = nothing
    unreviewed. `LEAK REVIEW PENDING` = run `… diff --out <scratch file>`, fire the `leak-review`
    agent on that file (one background agent; keep working on the PR text meanwhile, but do not
    build), put its `VERDICT:` line into the report, then `… mark`. `SUSPECT` → stop and hand the
    cited data path to the developer; the PR waits. The rule and why it sits before the build:
    global CLAUDE.md §5.
6. `git rebase origin/main`. **It refuses to start on a dirty tree** — anything deliberately
   left out of this PR must be stashed first (`git stash push -m "<why>" -- <paths>`) and
   popped after the gates, not committed to get the rebase moving.
   - **On conflict: STOP.** Run `git status` / show the conflicting files, resolve them
     locally (or ask the developer when the resolution is ambiguous), `git add` them, then
     `git rebase --continue`. Never push with conflict markers or an in-progress rebase.
   - If a rebase looks unsafe (large/unclear conflicts), abort with `git rebase --abort` and
     report to the developer instead of guessing.
6a. **What came in, against this PR** — the rebase may have pulled the same work done by someone
    else, or an open PR may be doing it right now: `node "$HOME/.claude/pipeline/leak-check.js" others`
    lists every commit by others since the developer's last own commit with its files, and the
    open PRs with theirs. Compare with `git diff --stat origin/main...HEAD`: a commit or PR on the
    same files or the same symptom is read (`git show <sha>` / `gh pr view <n> --json title,body,files`)
    before anything else happens. Same fix already on `main` → this PR is a duplicate: stop and
    report, do not publish. Same area, different fix → say so in the PR body and reference it.
    Nothing overlapping → one line in the report: `parallel: none (n commits · m PRs read)`.
    The rule: global CLAUDE.md §1.

## C. Local gates — run AFTER the rebase (Windows MSVC target)

Run from the PowerShell tool (linker already on PATH). Any red result → **STOP, do not push**,
report exactly what failed.

6b. Format FIRST — CI's `Formatting (cargo fmt)` job is blocking, and PR #505 went red on it
    twice because this stage had no fmt step and a path filter on the `--check` output missed
    every file (on Windows rustfmt prints `Diff in \\?\D:\...\crates\...\tests.rs` — backslashes
    and a `\\?\` prefix, so a grep for `crowd/place` matches nothing). No filter: `main` is
    fmt-clean (the CI job proves it on every merge), so a plain run touches only this change.
    ```powershell
    cargo fmt --all
    cargo fmt --all -- --check
    ```
    The second line must exit 0; anything it reformatted belongs to this branch and gets committed
    with it.

7. Build all targets:
   ```powershell
   cargo build -p moon-ui-gpui --bin moonterminal --target x86_64-pc-windows-msvc --all-targets
   ```
8. Lint (CI does not do this):
   ```powershell
   cargo clippy -p moon-ui-gpui --bin moonterminal --target x86_64-pc-windows-msvc --all-targets -- -D warnings
   ```
   **This repo carries large pre-existing clippy debt — `-D warnings` exits 101 on a clean
   `origin/main` too, so an absolute pass is not the gate.** The gate is *no NEW finding*:
   take each reported location inside a file this change touches and check it against the
   diff hunks. A finding on a line the change did not touch is pre-existing — note that its
   line number will be *shifted* by insertions above it, so compare by content, not by number.
   If anything is genuinely new, fix it. Prove the rest with a baseline run rather than
   asserting it:
   ```powershell
   git switch --detach origin/main
   cargo clippy -p moon-core --target x86_64-pc-windows-msvc --all-targets -- -D warnings
   git switch -
   ```
   (Stash any unstaged work first — `git rebase`/`switch` refuse to run with a dirty tree.)
9. Tests (theme_contract + units):
   ```powershell
   cargo test -p moon-core --target x86_64-pc-windows-msvc
   cargo test -p moon-ui-gpui --target x86_64-pc-windows-msvc
   ```
10. **FireTest — only if the change touches chart / render / windows / input:**
    ```powershell
    target\x86_64-pc-windows-msvc\debug\moonterminal.exe --debug-script chart-smoke
    target\x86_64-pc-windows-msvc\debug\moonterminal.exe --debug-script order-cancel-lag
    ```
    Non-zero exit = hard fail.

Record the actual results (fmt `--check` exit 0, test count, `zero warnings`, FireTest exit codes) — they go verbatim
into the PR's "How to verify".

## C2. Issues — what does this PR close? (before the PR body is written)

The tracker is the developer's memory of what is still owed. A PR that fixes an issue without
saying so leaves it open forever; one that fixes half and closes the whole hides the other half.
So every publish reconciles against the open issues — not only when the task started from one.

10b. List them and match against THIS change — the diff, the commit messages, the task as the
     developer phrased it:
     ```bash
     gh issue list --state open --limit 200 --json number,title,body --jq '.[] | "#\(.number) \(.title)"'
     ```
     Read the titles; open (`gh issue view <n>`) every one that plausibly overlaps — same panel,
     same feature, same symptom — and decide per issue, against the issue's own wording, not the
     title alone:
     - **Fully done** → the PR body gets its own line `Closes #<n>` (one per issue; GitHub closes
       them on merge to `main`, squash included). Prose mentions like "(#515)" do NOT close anything
       — that is how #521 sat open after its fix landed and had to be closed by hand.
     - **Partly done** → `Refs #<n>` in the PR body, and after the merge the issue is brought up to
       date so it describes only what is left: `gh issue comment <n>` with what landed (PR link) and
       what remains, then `gh issue edit <n> --title/--body` to the remainder. Open a NEW issue
       (`gh issue create`) and close the old one only when the remainder is a different topic from
       the issue's title — a rewritten issue keeps its number and its discussion, a new one does not.
     - **Not touched** → nothing, and it is not listed.
     When overlap is ambiguous (the issue asks for X, the PR does X differently), do not guess the
     developer's intent — ask, naming the issue and the difference.

10c. The reconciliation goes into the report (step 16) as its own line: `issues: closes #a, #b ·
     refs #c (remainder: …) · N open checked, none other touched`. "Checked N, none touched" is a
     result and is said explicitly — silence would be indistinguishable from not having looked.

## D. Publish

11. Push the branch:
    - New branch: `git push -u origin <branch>`.
    - A branch that already backs an open PR and was just rebased: `git push --force-with-lease`
      (never plain `--force`).
12. Open or update the PR with `gh`. There is **no committed PR template** — this skill carries
    the structure. Keep it public-safe: no secrets, no balances/keys, no customer data.

    ```bash
    gh pr create --base main --title "<conventional title>" --body "$(cat <<'EOF'
    ## What & why
    <what changed and the reasoning — the problem, not just the diff>

    ## Notable decisions
    <non-obvious choices and their trade-offs>

    ## Known limitations
    <deliberate gaps, deferred follow-ups — call them out, don't hide them>

    ## Issues
    Closes #<n>
    Refs #<m> — <what remains after this PR>
    <or: "none of the N open issues is touched by this change">

    ## How to verify
    ```
    cargo build -p moon-ui-gpui --bin moonterminal --target x86_64-pc-windows-msvc --all-targets
    cargo fmt --all -- --check
    cargo clippy ... -- -D warnings
    cargo test  -p moon-core -p moon-ui-gpui
    ```
    <N tests green, zero warnings; FireTest chart-smoke/order-cancel-lag exit 0 if run>
    EOF
    )"
    ```
    If a PR for this branch already exists, use `gh pr edit --body ...` instead of `create`.

13. **Wait for CI, THEN land it.** The developer's "publish" means the change reaches `main`,
    not that a PR is open — do not stop at the PR and wait to be asked. But the merge is the
    LAST step, gated on green CI — never before.

    **Do NOT use `gh pr merge --auto` on this repo.** `--auto` only waits for *required* status
    checks, and this repo configures none — so it merges the instant the PR is mergeable,
    before CI has run. That is exactly how a red `main` gets shipped. Wait explicitly instead:
    ```bash
    gh pr checks <n> --watch --fail-fast   # blocks until every check finishes; non-zero on any failure
    ```
    Only if that exits 0 — every check green — merge (squash is this repo's convention; its
    history carries the `(#NN)` suffix squash appends):
    ```bash
    gh pr merge <n> --squash
    ```
    **Any red check → STOP, do not merge, report which check failed.** This repo does not commit
    `Cargo.lock` and its deps are branch refs, so CI can turn red with no change to this diff at
    all — a dependency's HEAD moved. When that happens the failure is not yours to merge over and
    not yours to fix by forcing; report it and leave `main` untouched.

    A local stage-C gate you could not clear is also a stop: never merge over it.

    **13a. Green CI on the PR is not green CI on `main`. Re-sync before landing.**

    A PR's checks run against the base it was pushed on. On a busy day several PRs sit green at
    once, each tested against a base that does not contain the others, and the first thing to see
    the combination is the post-merge build — after it is already on `main`. Two clean diffs that
    touch different lines of the same `match` merge textually clean and break each other.

    So immediately before `gh pr merge`, ask whether the base moved:
    ```bash
    git fetch origin
    git rev-list --left-right --count origin/main...HEAD   # left>0 means main moved under us
    ```
    - **Left is 0** — nothing landed since the rebase in stage B. Merge.
    - **Left is >0** — `main` moved. Do NOT merge on the strength of the old run:
      1. `git rebase origin/main` (conflicts: stage B's rules apply).
      2. Re-run stage C on the COMBINED tree — at minimum both test commands; the whole stage if
         the rebase pulled in anything that touches this diff's files.
      3. `git push --force-with-lease`, then wait for CI again (`gh pr checks <n> --watch`).
      4. Only then merge.

    **Check that the push actually landed — twice bitten here.** `--force-with-lease` is refused
    with `! [rejected] … (stale info)` whenever the local knowledge of the remote ref is stale,
    which a background `gh` call is enough to cause. And never pipe the push through `tail`/`head`
    in an `&&` chain: the pipeline's status is the LAST command's, so a rejected push exits 0 and
    the chain proceeds to watch — and pass — the run from BEFORE the push. Push on its own line,
    then confirm the remote is where you think:
    ```bash
    git fetch origin
    git rev-parse --short HEAD origin/<branch>   # the two must match before you merge
    ```
    On 2026-08-27 this exact combination reported a green PR while the branch on origin still
    carried the pre-rebase commit.

    A red result here is the point of the step, not an obstacle to it: it is a break that would
    otherwise have landed on `main` under two green checkmarks. Fix it on this branch.

14. **Verify `main` yourself after landing — the post-merge run often never finishes.**

    `.github/workflows/build.yml` sets `concurrency: cancel-in-progress: true` with the ref in the
    group, so every push to `main` CANCELS the previous `main` build. When merges land back to back
    — routine here — most post-merge runs die within seconds and only the last one in the burst
    actually builds. A cancelled run is not a pass, and in the GitHub UI it reads as an innocuous
    `!` rather than as "nobody tested this".

    So the merge is not done until you have tested the merged `main` locally:
    ```powershell
    git switch main
    git pull --ff-only
    cargo test -p moon-core --target x86_64-pc-windows-msvc
    cargo test -p moon-ui-gpui --target x86_64-pc-windows-msvc
    ```
    Red → say so at once and fix it on a new `fix/...` branch through this same skill; a broken
    `main` blocks every other contributor and is not something to discover tomorrow. This is the
    check that caught #346 vs #348 on 2026-08-27, where both PRs were green, the merge was clean,
    and `main` failed `every_field_default_style_uses_the_shared_size`.

15. Clean up: `git switch main`, `git pull --ff-only`, delete the merged branch locally and on
    origin. Leave the developer on an up-to-date `main` with a clean tree — the next task must
    not start on the branch that was just merged.
15b. Settle the issues from C2: confirm every `Closes #n` actually closed (`gh issue view <n>
    --json state`); for each `Refs #n`, post the comment and rewrite the issue to its remainder
    (or create the follow-up and close the old one) as decided there. Do this AFTER the merge —
    an issue rewritten before the PR lands describes a state that does not exist yet.
16. Report back the merge commit, the PR URL, a one-line gate summary (fmt/build/clippy/test/
    FireTest results), the `issues:` line from C2 with what was closed / rewritten / created, and
    the result of the post-merge `main` test run from step 14.

## Scope & hygiene rules

- **One PR = one topic.** Unrelated formatting/refactor drift → a separate branch/PR or a
  tracked follow-up issue (do not smuggle it in). Say what you split out.
- If the change touches user-facing behavior, an API, or a config/setting, update the matching
  doc **in the same PR** — a stale doc is part of the breakage.
- Commits, PR text, and everything written to the tracker — new issues, rewritten titles and
  bodies, comments (C2 / 15b) — in English; talk to the developer in Russian.
- Never bypass a gate silently. A skipped gate is stated in the report with its reason.
