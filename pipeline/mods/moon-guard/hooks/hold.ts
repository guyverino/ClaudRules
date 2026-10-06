/**
 * hold.ts — the pure half of moon-guard's hold (the "blast radius" pattern):
 * which shell commands are held for the person to confirm, which read-only
 * commands preview what they would change, and how those previews are read.
 * No `$`, so every rule is a plain function a test can call.
 *
 * Held: what leaves the machine or cannot be taken back — a push, a PR merge,
 * a release, throwing away uncommitted work, and moving the dependency lock.
 */
import { segments } from './cargo'

export type HoldKind = 'push' | 'merge' | 'release' | 'discard' | 'clean' | 'update'

/** One held command: what it is, the segment that made it so, and what to look at before it runs. */
export type Held = {
  kind: HoldKind
  /** The simple command (bare, see cargo.ts) that matched. */
  segment: string
  /** The repository it acts on, from `git -C <dir>`; undefined means the session root. */
  dir?: string
  /** Lines the person should not miss: a force push, a push to main, tags. */
  warnings: string[]
}

// git with any global options before its subcommand: `-C <dir>`, `-c k=v`,
// the ones that take a separate value, and every `--flag` / `--flag=value`
// (`--no-pager`, `--git-dir=…`). Skipping only `-C` let `git --no-pager push` through.
// A bare `-C`/`-c` is never a flag on its own: its value would be read as the subcommand.
const GIT_GLOBALS = String.raw`(?:(?:-[Cc]|--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix))\s+\S+\s+|(?:--[A-Za-z][\w-]*|-(?![Cc]\s)[A-Za-z][\w-]*)(?:=\S+)?\s+)*`
const GIT = String.raw`(?:^|[\s"'&(\\/])git(?:\.exe)?["']?\s+${GIT_GLOBALS}`
// A subcommand ends at whitespace or the end, never at a hyphen: `push-tools` is not `push`.
const SUB = String.raw`(?![\w-])`
const PUSH_RE = new RegExp(`${GIT}push${SUB}`)
const RESET_HARD_RE = new RegExp(`${GIT}reset${SUB}.*\\s--hard\\b`)
const CHECKOUT_PATHS_RE = new RegExp(`${GIT}checkout${SUB}(?:.*\\s--(?:\\s|$)|\\s+\\.(?:\\s|$))`)
const RESTORE_RE = new RegExp(`${GIT}restore${SUB}`)
const STASH_DROP_RE = new RegExp(`${GIT}stash\\s+(?:drop|clear)${SUB}`)
const BRANCH_DELETE_RE = new RegExp(`${GIT}branch${SUB}.*\\s(?:-D|--delete\\s+--force|-d\\s+-f|-df|-fd)\\b`)
const CLEAN_RE = new RegExp(`${GIT}clean${SUB}`)
const GH_MERGE_RE = /(?:^|[\s"'&(\\/])gh(?:\.exe)?["']?\s+pr\s+merge\b/
const GH_RELEASE_RE = /(?:^|[\s"'&(\\/])gh(?:\.exe)?["']?\s+release\s+(?:create|edit|delete|upload)\b/
const CARGO_UPDATE_RE = /(?:^|[\s"'&(\\/])cargo(?:\.exe)?["']?\s+(?:\+\S+\s+)?update\b/
const MAKE_UPDATE_RE = /(?:^|[\s"'&(])make(?:\.exe)?\s+update-[\w-]+/
// A dry run changes nothing: `--dry-run`, or git's own `-n` on push and clean.
const DRY_RE = /\s--dry-run\b/
const PUSH_DRY_RE = /\s(?:-n|--dry-run)(?:\s|$)/
const CLEAN_DRY_RE = /\s-[A-Za-z]*n[A-Za-z]*\b|\s--dry-run\b/
const CLEAN_FORCE_RE = /\s-[A-Za-z]*f[A-Za-z]*\b|\s--force\b/
// What a push must not slip past the person.
const FORCE_RE = /\s(?:-f\b|--force\b|--force-with-lease\b|--force-if-includes\b|-[A-Za-z]*f[A-Za-z]*\b|\+\S)/
const DELETE_RE = /\s(?:-d\b|--delete\b|:\S)/
const MAIN_RE = /\s(?:\S*:)?(?:refs\/heads\/)?(?:main|master)(?:\s|$)/
// A release tag is vMAJOR.MINOR.PATCH (CONTRIBUTING.md); a branch named v2.0-fix is not one.
const TAGS_RE = /\s(?:--tags\b|--follow-tags\b|(?:\S*:)?(?:refs\/tags\/)?v\d+\.\d+\.\d+(?:\s|$))/

const VALUE = String.raw`(?:"([^"]+)"|'([^']+)'|(\S+))`
const DIR_C_RE = new RegExp(String.raw`\bgit(?:\.exe)?["']?\s+(?:(?:-c\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?)\s+)*?-C\s+${VALUE}`)
const WORK_TREE_RE = new RegExp(String.raw`\bgit(?:\.exe)?["']?\s[^\n;&|]*?--work-tree(?:=|\s+)${VALUE}`)
const GIT_DIR_RE = new RegExp(String.raw`\bgit(?:\.exe)?["']?\s[^\n;&|]*?--git-dir(?:=|\s+)${VALUE}`)

/**
 * The repository a git command acts on, read from the raw text (a quoted path
 * may hold spaces): `-C <dir>`, else `--work-tree`, else the folder holding
 * `--git-dir`; undefined means the session root. The preview must read the
 * same repository the command would change.
 */
export function gitDir(command: string): string | undefined {
  const pick = (m: RegExpMatchArray | null) => (m ? (m[1] ?? m[2] ?? m[3]) : undefined)
  const gitFolder = pick(command.match(GIT_DIR_RE))
  return pick(command.match(DIR_C_RE)) ?? pick(command.match(WORK_TREE_RE)) ?? gitFolder?.replace(/[\\/]\.git[\\/]?$/, '')
}

function pushWarnings(seg: string): string[] {
  const out: string[] = []
  if (FORCE_RE.test(seg)) out.push('FORCE push: rewrites history on the remote')
  if (DELETE_RE.test(seg)) out.push('deletes a remote ref')
  if (MAIN_RE.test(seg)) out.push('targets main: the ruleset rejects a direct push there, a PR is the way')
  if (TAGS_RE.test(seg)) out.push('pushes tags: a v* tag starts the release workflow')
  return out
}

/**
 * The first held command in a shell command, or undefined when it holds none.
 * Data is not a command: a commit message or an echo naming `git push` holds
 * nothing (cargo.ts `segments` strips it), and a dry run changes nothing.
 */
export function heldCommand(command: string): Held | undefined {
  const dir = gitDir(command)
  for (const seg of segments(command)) {
    const s = ` ${seg}`
    const push = s.match(PUSH_RE)
    if (push && !PUSH_DRY_RE.test(s)) {
      // What follows the subcommand itself: a `push` inside `-C push-dir` is not it.
      const args = s.slice((push.index ?? 0) + push[0].length)
      return { kind: TAGS_RE.test(args) ? 'release' : 'push', segment: seg, dir, warnings: pushWarnings(args) }
    }
    if (GH_MERGE_RE.test(s)) return { kind: 'merge', segment: seg, dir: undefined, warnings: [] }
    if (GH_RELEASE_RE.test(s)) return { kind: 'release', segment: seg, dir: undefined, warnings: ['changes a published release'] }
    if (RESET_HARD_RE.test(s) || CHECKOUT_PATHS_RE.test(s) || STASH_DROP_RE.test(s) || BRANCH_DELETE_RE.test(s)) {
      return { kind: 'discard', segment: seg, dir, warnings: [] }
    }
    // `git restore` discards the working tree unless it only unstages (`--staged` without `--worktree`).
    if (RESTORE_RE.test(s) && (!/\s(?:-S|--staged)\b/.test(s) || /\s(?:-W|--worktree)\b/.test(s))) {
      return { kind: 'discard', segment: seg, dir, warnings: [] }
    }
    // Without -f git clean refuses to run (clean.requireForce); with -n anywhere it is a dry run.
    if (CLEAN_RE.test(s) && CLEAN_FORCE_RE.test(s) && !CLEAN_DRY_RE.test(s)) {
      return { kind: 'clean', segment: seg, dir, warnings: [] }
    }
    if ((CARGO_UPDATE_RE.test(s) && !DRY_RE.test(s)) || MAKE_UPDATE_RE.test(s)) {
      const all = MAKE_UPDATE_RE.test(s) ? /update-all\b/.test(s) : !/\s(?:-p|--package)\b/.test(s)
      const warnings = all ? ['moves EVERY dependency in Cargo.lock, the pinned forks included'] : []
      if (/moonproto/.test(s)) warnings.push('moonproto moves only together with the cores (CLAUDE.md)')
      return { kind: 'update', segment: seg, dir: undefined, warnings }
    }
  }
  return undefined
}

/** The `-p <crate>` / `--package <crate>` pairs of a cargo update, for its dry run. */
export function updatePackages(segment: string): string[] {
  const out: string[] = []
  const re = /\s(?:-p|--package)(?:\s+|=)(\S+)/g
  for (let m = re.exec(` ${segment}`); m; m = re.exec(` ${segment}`)) out.push('-p', m[1] ?? '')
  return out
}

/** The `-d`/`-x`/`-X` flags of a git clean, for its dry run. */
export function cleanFlags(segment: string): string[] {
  const out: string[] = []
  for (const m of segment.matchAll(/\s-([A-Za-z]+)\b/g)) {
    for (const c of m[1] ?? '') if ((c === 'd' || c === 'x' || c === 'X') && !out.includes(`-${c}`)) out.push(`-${c}`)
  }
  return out
}

/** The PR number a `gh pr merge` names, or undefined for the current branch's PR. */
export function prNumber(segment: string): string | undefined {
  return segment.match(/\bmerge\s+(?:#)?(\d+)\b/)?.[1]
}

type Check = { name?: string; context?: string; status?: string; conclusion?: string; state?: string }

/**
 * Lines that summarise `gh pr view --json number,title,state,baseRefName,
 * headRefName,mergeStateStatus,statusCheckRollup`: what merges where, and the
 * CI state — failing and pending checks by name, since merging over a red one
 * is the thing to see.
 */
export function prSummary(json: string): { lines: string[]; warnings: string[] } {
  let pr: {
    number?: number
    title?: string
    state?: string
    baseRefName?: string
    headRefName?: string
    mergeStateStatus?: string
    statusCheckRollup?: Check[]
  }
  try {
    pr = JSON.parse(json)
  } catch {
    return { lines: ['gh pr view returned no JSON'], warnings: [] }
  }
  const checks = pr.statusCheckRollup ?? []
  const verdict = (c: Check) => (c.conclusion || c.state || c.status || '').toUpperCase()
  const failed = checks.filter(c => /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/.test(verdict(c)))
  const pending = checks.filter(c => /PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING/.test(verdict(c)) || verdict(c) === '')
  const passed = checks.length - failed.length - pending.length
  const name = (c: Check) => c.name || c.context || '?'
  const warnings: string[] = []
  if (pr.state && pr.state !== 'OPEN') warnings.push(`PR is ${pr.state}`)
  if (failed.length) warnings.push(`red: ${failed.map(name).join(', ')}`)
  if (pr.mergeStateStatus && !/CLEAN|HAS_HOOKS|UNSTABLE/.test(pr.mergeStateStatus)) warnings.push(`merge state ${pr.mergeStateStatus}`)
  return {
    lines: [
      `#${pr.number ?? '?'} ${pr.title ?? ''}`.trim(),
      `${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'} · checks: ${passed} passed, ${failed.length} failed, ${pending.length} pending`,
      ...(pending.length ? [`pending: ${pending.map(name).join(', ')}`] : []),
    ],
    warnings,
  }
}

/** The lines of a `cargo update --dry-run` that say what would move (cargo writes them to stderr). */
export function updateLines(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^(Updating|Locking|Adding|Removing|Downgrading|Upgrading)\b/.test(l) && !/^Updating (git|crates\.io) (repository|index)\b/.test(l))
}

/** At most `n` lines, the cut said out loud. */
export function head(lines: readonly string[], n: number): string[] {
  return lines.length <= n ? [...lines] : [...lines.slice(0, n), `… ${lines.length - n} more`]
}

/** What one hold is called in the pane's title and in the model's deny reason. */
export const KIND_TITLE: Record<HoldKind, string> = {
  push: 'git push',
  merge: 'PR merge',
  release: 'release',
  discard: 'discard uncommitted work',
  clean: 'git clean',
  update: 'dependency lock update',
}
