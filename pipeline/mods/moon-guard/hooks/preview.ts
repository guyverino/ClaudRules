/**
 * preview.ts — what a held command would change, read with read-only commands
 * before the person decides: the commits a push sends, a PR's checks, the
 * files a discard throws away, what a clean deletes, how the lock would move.
 *
 * Every command is bounded and never throws: a preview that cannot be read
 * says so in its lines, and the hold goes on with what it has.
 */
import type { ProcessRunResult } from 'claude-code'

import { cleanFlags, head, type Held, prNumber, prSummary, updateLines, updatePackages } from './hold'

const GIT_MS = 5_000
const GH_MS = 15_000
// A dry run of cargo update may fetch the git dependencies first.
const CARGO_MS = 90_000
const MAX_LINES = 15

export type Preview = { lines: string[]; warnings: string[] }

/**
 * Runs one command by its argument vector, no shell: `$.process.run` in the
 * hook (the engine lets `$` cross no import, so the hook hands this in).
 */
export type Exec = (argv: string[], cwd: string, timeoutMs: number) => Promise<ProcessRunResult>

type Ran = { ok: boolean; out: string; err: string }

async function run(exec: Exec, argv: string[], cwd: string, timeoutMs: number): Promise<Ran> {
  try {
    const r = await exec(argv, cwd, timeoutMs)
    return { ok: r.exitCode === 0, out: r.stdout.trim(), err: r.stderr.trim() }
  } catch (err) {
    return { ok: false, out: '', err: String(err) }
  }
}

const lines = (text: string) => text.split(/\r?\n/).filter(l => l.trim() !== '')
const firstErr = (r: Ran) => lines(r.err)[0] ?? 'failed'

async function pushPreview(exec: Exec, dir: string): Promise<Preview> {
  const status = await run(exec, ['git', 'status', '-sb'], dir, GIT_MS)
  const out: string[] = [lines(status.out)[0] ?? `git status: ${firstErr(status)}`]
  let log = await run(exec, ['git', 'log', '--oneline', '-n', '40', '@{u}..HEAD'], dir, GIT_MS)
  if (!log.ok) {
    out.push('no upstream yet — commits not on origin/main:')
    log = await run(exec, ['git', 'log', '--oneline', '-n', '40', 'origin/main..HEAD'], dir, GIT_MS)
  }
  const commits = lines(log.out)
  out.push(...(log.ok ? (commits.length ? head(commits, MAX_LINES) : ['nothing new to send']) : [`git log: ${firstErr(log)}`]))
  const stat = await run(exec, ['git', 'diff', '--shortstat', 'origin/main...HEAD'], dir, GIT_MS)
  if (stat.ok && stat.out) out.push(`vs origin/main: ${stat.out}`)
  return { lines: out, warnings: [] }
}

async function mergePreview(exec: Exec, dir: string, held: Held): Promise<Preview> {
  const n = prNumber(held.segment)
  const fields = 'number,title,state,baseRefName,headRefName,mergeStateStatus,statusCheckRollup'
  const r = await run(exec, ['gh', 'pr', 'view', ...(n ? [n] : []), '--json', fields], dir, GH_MS)
  if (!r.ok) return { lines: [`gh pr view: ${firstErr(r)}`], warnings: ['could not read the PR — merge state unknown'] }
  return prSummary(r.out)
}

async function discardPreview(exec: Exec, dir: string, held: Held): Promise<Preview> {
  if (/\bstash\b/.test(held.segment)) {
    const r = await run(exec, ['git', 'stash', 'list'], dir, GIT_MS)
    const stashes = lines(r.out)
    return { lines: r.ok ? head(stashes.length ? stashes : ['no stashes'], MAX_LINES) : [`git stash list: ${firstErr(r)}`], warnings: [] }
  }
  if (/\bbranch\b/.test(held.segment)) {
    const name = held.segment.split(/\s+/).pop() ?? ''
    const r = await run(exec, ['git', 'log', '--oneline', '-n', '40', name, '--not', '--remotes'], dir, GIT_MS)
    const only = lines(r.out)
    return {
      lines: r.ok ? (only.length ? head(only, MAX_LINES) : ['every commit of it is on a remote']) : [`git log: ${firstErr(r)}`],
      warnings: only.length ? [`${only.length} commit(s) exist only on this branch`] : [],
    }
  }
  const status = await run(exec, ['git', 'status', '--short', '--untracked-files=no'], dir, GIT_MS)
  const changed = lines(status.out)
  if (!status.ok) return { lines: [`git status: ${firstErr(status)}`], warnings: [] }
  const stat = await run(exec, ['git', 'diff', '--shortstat', 'HEAD'], dir, GIT_MS)
  return {
    lines: changed.length ? [...head(changed, MAX_LINES), ...(stat.out ? [stat.out] : [])] : ['working tree clean: no uncommitted change to lose'],
    warnings: changed.length ? [`${changed.length} changed file(s) in the tree; the command may throw some away`] : [],
  }
}

async function cleanPreview(exec: Exec, dir: string, held: Held): Promise<Preview> {
  const r = await run(exec, ['git', 'clean', '-n', ...cleanFlags(held.segment)], dir, GIT_MS)
  const gone = lines(r.out)
  if (!r.ok) return { lines: [`git clean -n: ${firstErr(r)}`], warnings: [] }
  return { lines: gone.length ? head(gone, MAX_LINES) : ['nothing to delete'], warnings: gone.length ? [`deletes ${gone.length} untracked path(s)`] : [] }
}

async function updatePreview(exec: Exec, dir: string, held: Held): Promise<Preview> {
  if (!/\bcargo\b/.test(held.segment)) return { lines: [`${held.segment.trim()} — a Makefile target that refreshes Cargo.lock`], warnings: [] }
  const r = await run(exec, ['cargo', 'update', '--dry-run', ...updatePackages(held.segment)], dir, CARGO_MS)
  if (!r.ok) return { lines: [`cargo update --dry-run: ${firstErr(r)}`], warnings: [] }
  const moves = updateLines(r.err)
  return { lines: moves.length ? head(moves, MAX_LINES) : ['the lock would not move'], warnings: [] }
}

/** What the held command would change, read in `dir`; never rejects. */
export async function previewOf(exec: Exec, held: Held, dir: string): Promise<Preview> {
  try {
    switch (held.kind) {
      case 'push':
        return await pushPreview(exec, dir)
      case 'release':
        return /\bgh\b/.test(held.segment) ? { lines: [held.segment.trim()], warnings: [] } : await pushPreview(exec, dir)
      case 'merge':
        return await mergePreview(exec, dir, held)
      case 'discard':
        return await discardPreview(exec, dir, held)
      case 'clean':
        return await cleanPreview(exec, dir, held)
      case 'update':
        return await updatePreview(exec, dir, held)
    }
  } catch (err) {
    return { lines: [`preview failed: ${String(err)}`], warnings: [] }
  }
}
