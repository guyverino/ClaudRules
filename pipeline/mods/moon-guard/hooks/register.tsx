/**
 * moon-guard — MoonTerminal's shell rules and live counters.
 *
 *   - tool.call (Bash, PowerShell): refuses a cargo build/test/run/clippy
 *     without the MSVC target, the vcvars wrapper, and a git commit that would
 *     carry Cargo.lock while .cargo/config.toml holds a [patch] path override
 *   - /diag [<profile>|<path>|stop]: a pane with the last line of
 *     logs/render_diag.log, re-read once a second while the pane is open
 *
 * A hook that throws is skipped by the engine (fail open): these rules are a
 * convenience in front of the review and CI, not a security boundary.
 */
import { read, update, atom } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MoonGuardDiag } from '../types'
import { cargoDenial, commitKind, hasPatchOverride, listsLock, lockDenial } from './cargo'
import { diagLogPath, isZero, parseDiag, STALE_MS, TAIL_JS } from './diag'

const PANE = 'render-diag'
const COMMAND = 'diag'
const CELL = 28
const NO_LOG = 'no log yet'

const diag = atom({ plugin: 'moon-guard', key: 'diag' } as const, {
  path: '',
  line: '',
  writtenAt: 0,
  checkedAt: 0,
  error: '',
} as MoonGuardDiag)

// A tail can take longer than the one-second tick: the next tick skips
// instead of starting a second read that could land after a newer one.
let isLooking = false

async function lockStaged($: EngineInterface, root: string, kind: 'staged' | 'all'): Promise<boolean> {
  const config = await $.fs.read(`${root}/.cargo/config.toml`).catch(() => '')
  if (!hasPatchOverride(config)) return false
  const staged = await $.process.run(['git', 'diff', '--cached', '--name-only'], { cwd: root, timeoutMs: 5_000 })
  if (listsLock(staged.stdout)) return true
  if (kind !== 'all') return false
  const worktree = await $.process.run(['git', 'diff', '--name-only'], { cwd: root, timeoutMs: 5_000 })
  return listsLock(worktree.stdout)
}

// One look at the log for the open pane: re-reads its tail only when the file
// changed. Never rejects: a failure is written into the pane's state.
async function look($: EngineInterface) {
  if (isLooking) return
  isLooking = true
  try {
    const cur = await read($, diag)
    // /diag may switch to another log while this look runs: what it read then
    // belongs to the old path and is dropped.
    const mine = (fn: (d: MoonGuardDiag) => MoonGuardDiag) => (d: MoonGuardDiag) => (d.path === cur.path ? fn(d) : d)
    const now = await $.clock.now()
    const stat = await $.fs.stat(cur.path).catch(() => undefined)
    if (!stat || stat.kind !== 'file') {
      await update($, diag, mine(d => ({ ...d, line: '', writtenAt: 0, checkedAt: now, error: NO_LOG })))
      return
    }
    if (stat.mtimeMs === cur.writtenAt) {
      // Nothing new: only the age moves, and only its whole seconds are drawn.
      if (Math.floor((now - cur.writtenAt) / 1000) !== Math.floor((cur.checkedAt - cur.writtenAt) / 1000)) {
        await update($, diag, mine(d => ({ ...d, checkedAt: now })))
      }
      return
    }
    const tail = await $.process.run(['node', '-e', TAIL_JS, cur.path], { timeoutMs: 5_000 })
    // A tail that does not parse (nothing whole yet, another log's line): keep
    // the last good one and leave writtenAt behind, so the next tick reads again.
    const whole = tail.exitCode === 0 && parseDiag(tail.stdout) !== undefined
    await update(
      $,
      diag,
      mine(d => ({
        ...d,
        line: whole ? tail.stdout : d.line,
        writtenAt: whole ? stat.mtimeMs : d.writtenAt,
        checkedAt: now,
        error: tail.exitCode === 0 ? '' : tail.stderr.split('\n')[0] || `node exited ${tail.exitCode}`,
      })),
    )
  } catch (err) {
    const now = await $.clock.now().catch(() => 0)
    await update($, diag, d => ({ ...d, checkedAt: now || d.checkedAt, error: `tail failed: ${String(err)}` })).catch(
      () => undefined,
    )
  } finally {
    isLooking = false
  }
}

// The mod loads for every session of this user; its rules are MoonTerminal's.
const MARKER = 'crates/moon-ui-gpui/Cargo.toml'

async function inMoonTerminal($: EngineInterface): Promise<boolean> {
  return $.fs.exists(`${await $.session.root()}/${MARKER}`).catch(() => false)
}

export const register: Register = on => {
  // One timer per load, started where the engine keeps it alive; it reads the
  // log only while the pane is open.
  let timer: { cancel: () => void } | undefined
  let isOpen = false
  // Whether this session works in MoonTerminal, asked once per load.
  let isMoon: Promise<boolean> | undefined

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    isMoon ??= inMoonTerminal($)
    if (!(await isMoon)) return next(e)
    const denied = cargoDenial(e.command)
    if (denied) return { deny: denied }
    const kind = commitKind(e.command)
    if (kind && (await lockStaged($, await $.session.root(), kind))) return { deny: lockDenial() }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = $.clock.every(1000, () => {
      if (isOpen) void look($)
    })
    isMoon = inMoonTerminal($)
    if (!(await isMoon)) return r
    await $.command
      .register({
        name: COMMAND,
        description: 'render_diag.log live: the last per-second counter line (a profile such as debug or inspector, or a path; stop closes)',
        argumentHint: '[debug|inspector|<profile>|<path>|stop]',
        immediate: true,
      })
      .catch(err => $.ui.log(`moon-guard: /${COMMAND} not registered: ${err}`))
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stop') {
      isOpen = false
      await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: 'render_diag pane closed' }
    }
    const path = diagLogPath(await $.session.root(), arg)
    await update($, diag, () => ({ path, line: '', writtenAt: 0, checkedAt: 0, error: '' }))
    await look($)
    isOpen = true
    await $.ui.open({ id: PANE, title: 'render_diag' })
    return { text: `render_diag: ${path} · /${COMMAND} stop closes` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear keeps the process, its timer and an open pane, which goes on
    // refreshing; any other end drops both.
    if (e.reason !== 'clear') {
      isOpen = false
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const d = await read($, diag)
    const width = Math.max(30, e.props.bodyColumns)
    const parsed = parseDiag(d.line)
    const age = d.writtenAt ? d.checkedAt - d.writtenAt : 0
    const stale = !d.writtenAt || age > STALE_MS
    const perRow = Math.max(1, Math.floor(width / CELL))
    const pairs = parsed?.pairs ?? []
    const rows: [string, string][][] = []
    for (let i = 0; i < pairs.length; i += perRow) rows.push(pairs.slice(i, i + perRow))
    return (
      <Box flexDirection="column">
        <Text key="path" dimColor wrap="truncate-start">
          {d.path}
        </Text>
        {stale ? (
          <Text key="stale" color="yellow">
            {d.error === NO_LOG
              ? 'no render_diag.log here yet: set channels.render = true in cfg/diagnostics.toml beside the exe'
              : `no new line for ${Math.round(age / 1000)}s: counters off (channels.render) or the app is not running`}
          </Text>
        ) : (
          <Text key="fresh" color="green">{`live · window ${parsed?.windowMs ?? '?'} ms`}</Text>
        )}
        {d.error && d.error !== NO_LOG ? (
          <Text key="error" color="red">
            {d.error}
          </Text>
        ) : null}
        {rows.map((row, r) => (
          <Box key={`row:${r}`} flexDirection="row">
            {row.map(([k, v]) => (
              <Box key={`c:${k}`} width={CELL} flexShrink={0}>
                <Text dimColor={isZero(v)} wrap="truncate-end">{`${k}=${v}`}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
