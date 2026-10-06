/**
 * moon-guard — MoonTerminal's shell rules and live counters.
 *
 *   - tool.call (Bash, PowerShell): refuses a cargo build/test/run/clippy
 *     without the MSVC target, the vcvars wrapper, and a git commit that would
 *     carry Cargo.lock while .cargo/config.toml holds a [patch] path override
 *   - tool.call (Bash, PowerShell): holds a push, a PR merge, a release, a
 *     discard of uncommitted work and a lock update (hooks/hold.ts) in a pane
 *     with a read-only preview of what it would change, until the person
 *     presses Proceed or Cancel; unanswered, it is refused with that preview
 *   - /proceed [cancel]: answers a hold from the prompt box (for a surface that
 *     draws no pane), or, with nothing held, lets the next held command through
 *   - /diag [<profile>|<path>|stop]: a pane with the last line of
 *     logs/render_diag.log, re-read once a second while the pane is open
 *
 * A hook that throws is skipped by the engine (fail open): these rules are a
 * convenience in front of the review and CI, not a security boundary — with
 * one exception, the hold: tool.call's `.catch` refuses a held command the
 * guard failed to hold, so a fault never runs it unconfirmed.
 */
import { read, update, atom } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { MoonGuardDiag, MoonGuardHold } from '../types'
import { cargoDenial, commitKind, hasPatchOverride, listsLock, lockDenial } from './cargo'
import { diagLogPath, isZero, parseDiag, STALE_MS, TAIL_JS } from './diag'
import { type Held, heldCommand, KIND_TITLE } from './hold'
import { previewOf } from './preview'

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

const HOLD_PANE = 'hold'
const PROCEED = 'proceed'
// How long a held command waits for the person before it is refused.
const HOLD_MS = 120_000
// How often the hold looks for the person's answer.
const POLL_MS = 250
// The hold's wait between looks. Not $.clock.sleep: HookBudget stops a hook's
// 10 s clock while any $ call is in flight EXCEPT a $.clock wait, so a hold
// built on $.clock.sleep is dropped after 10 s and the engine runs the command
// it was holding. A child process's lifetime does not count.
const NAP_JS = 'setTimeout(() => {}, Number(process.argv[1]))'
// The longest the hold waits for its own pane to close before it answers.
const CLOSE_MS = 2_000
// How long a /proceed typed with nothing held stays armed.
const ARM_MS = 10 * 60_000
// The command as the pane shows it: enough to recognise, not a wall of text.
const COMMAND_CHARS = 300
// Who can answer a hold: the person, never a plugin's own $.command.run.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const hold = atom({ plugin: 'moon-guard', key: 'hold' } as const, null as MoonGuardHold | null)

/**
 * The hold waiting right now and the person's answer to it (empty while none
 * came); `isReady` once its preview is on screen; `isClosing` once the hold
 * closes its own pane, so that close is not taken for the person's no.
 */
type Waiting = { id: number; title: string; answer: '' | 'go' | 'stop'; isReady: boolean; isClosing: boolean }

// The answer and the /proceed arming live in the module, not in $.state: a
// hook's dispatch reads state as it stood when the dispatch began, so the
// hold's own loop would never see a press or a /proceed written by another
// dispatch, and two parallel held commands would both read one arming as
// theirs. One hold at a time: a second held command in a parallel call is
// refused rather than stacking two panes the person cannot tell apart.
let waiting: Waiting | undefined
let holdSeq = 0
// Until when a /proceed typed with nothing held lets the next held command
// through, ms since the epoch; 0 when disarmed.
let armedUntil = 0

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

/**
 * The person's answer to hold `id`; the first one counts, one meant for an
 * earlier hold is dropped, and a Proceed before the preview is on screen is
 * not an answer — the preview is what the person confirms. A no always counts.
 */
function decide(id: number, answer: 'go' | 'stop') {
  if (!waiting || waiting.id !== id || waiting.answer) return
  if (answer === 'go' && !waiting.isReady) return
  waiting.answer = answer
}

/**
 * Holds one command for the person: reads its preview, shows it in a pane with
 * Proceed and Cancel, and waits. Resolves undefined to let the command run, or
 * the reason it is refused — which carries the preview, so the model can put
 * it in front of the person in the conversation.
 */
async function holdFor($: EngineInterface, held: Held, command: string, signal: AbortSignal): Promise<string | undefined> {
  // Check and spend the arming in one synchronous step after the await: two
  // parallel held commands must not both read one arming as theirs.
  const now = await $.clock.now()
  if (armedUntil > now) {
    armedUntil = 0
    return undefined
  }
  const title = KIND_TITLE[held.kind]
  if (waiting) return `moon-guard: another command is held for the person right now; run this ${title} after that one is answered.`
  const mine: Waiting = { id: ++holdSeq, title, answer: '', isReady: false, isClosing: false }
  waiting = mine
  const exec = (argv: string[], cwd: string, timeoutMs: number) => $.process.run(argv, { cwd, timeoutMs })
  try {
    const dir = held.dir ?? (await $.session.root())
    const surfaces = await $.session.surfaces().catch(() => [])
    if (surfaces.length === 0) {
      const p = await previewOf(exec, held, dir)
      const lines = [`${title} in ${dir}`, ...[...held.warnings, ...p.warnings].map(w => `! ${w}`), ...p.lines].join('\n')
      return `moon-guard: this ${title} is held for the person, and no surface is attached to confirm it (a headless run). Preview:\n${lines}`
    }
    const id = mine.id
    const shown = command.length > COMMAND_CHARS ? `${command.slice(0, COMMAND_CHARS - 1)}…` : command
    // The pane goes up before the preview is read (a lock dry run can take a
    // while), with Cancel only: Proceed appears with the preview it confirms.
    await update($, hold, () => ({ id, title, command: shown, dir, lines: ['reading what it would change…'], warnings: held.warnings, deadline: 0, isPlaced: false }))
    const opened = await $.ui
      .open({ id: HOLD_PANE, title: `hold: ${title}`, focus: true })
      .catch(err => ({ isPlaced: false as const, reason: String(err) }))
    if (opened.isPlaced) await update($, hold, h => (h && h.id === id ? { ...h, isPlaced: true } : h))
    const preview = await previewOf(exec, held, dir)
    const warnings = [...held.warnings, ...preview.warnings]
    const summary = [`${title} in ${dir}`, ...warnings.map(w => `! ${w}`), ...preview.lines].join('\n')
    // The person's two minutes start once there is something to read.
    const deadline = (await $.clock.now()) + HOLD_MS
    // Ready before the Proceed button is drawn, so its first press counts.
    mine.isReady = true
    await update($, hold, h => (h && h.id === id ? { ...h, lines: preview.lines, warnings, deadline } : h))
    while (!mine.answer && !signal.aborted && (await $.clock.now()) < deadline) {
      // A nap that cannot start (no node) would spin this loop: fall back to
      // the clock, whose budget then runs out — and the `.catch` refuses.
      await $.process.run(['node', '-e', NAP_JS, String(POLL_MS)], { timeoutMs: POLL_MS + 5_000 }).catch(() => $.clock.sleep(POLL_MS))
    }
    if (mine.answer === 'go') return undefined
    if (mine.answer === 'stop') return `moon-guard: the person cancelled this ${title}; do not retry it unasked. Preview:\n${summary}`
    if (signal.aborted) return `moon-guard: this ${title} was interrupted while it was held; it did not run.`
    const why = opened.isPlaced ? '' : ` (no pane was drawn — ${opened.reason}; the band above the prompt carried the buttons)`
    return `moon-guard: this ${title} was held for the person and not answered within ${HOLD_MS / 1000} s${why}. Ask the person: they press Proceed when you run it again, or type /proceed first. Preview:\n${summary}`
  } finally {
    // Close our own pane while still the waiting hold, so the ui.close it
    // raises can be told apart from the person's — and cannot land on the
    // next hold.
    mine.isClosing = true
    await update($, hold, () => null).catch(() => undefined)
    // Bounded: a close that waits on its surface must not hold up the answer.
    await Promise.race([
      $.ui.close({ id: HOLD_PANE }).catch(() => undefined),
      $.process.run(['node', '-e', NAP_JS, String(CLOSE_MS)], { timeoutMs: CLOSE_MS + 5_000 }).catch(() => undefined),
    ])
    if (waiting === mine) waiting = undefined
  }
}

// The mod loads for every session of this user; its rules are MoonTerminal's.
const MARKER = 'crates/moon-ui-gpui/Cargo.toml'

async function inMoonTerminal($: EngineInterface): Promise<boolean> {
  return $.fs.exists(`${await $.session.root()}/${MARKER}`).catch(() => false)
}

export const register: Register = (on, options) => {
  const wantHold = options.hold !== false
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
    const held = wantHold ? heldCommand(e.command) : undefined
    if (held) {
      const refused = await holdFor($, held, e.command, next.signal)
      if (refused) return { deny: refused }
    }
    return next(e)
  }).catch(($, e, next) => {
    // The rules above fail open (a convenience, not a boundary) — except a
    // held command: one the guard failed to hold must not run unconfirmed.
    if (next.called || (e.tool !== 'Bash' && e.tool !== 'PowerShell')) return next(e)
    const held = wantHold ? heldCommand(e.command) : undefined
    return held ? { deny: `moon-guard: the guard failed while holding this ${KIND_TITLE[held.kind]}; it did not run. Ask the person, then run it again.` } : next(e)
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
    if (wantHold) {
      await $.command
        .register({
          name: PROCEED,
          description: 'Answer the command moon-guard holds: run it (or, with nothing held, let the next held one through within 10 min); cancel refuses it',
          argumentHint: '[cancel]',
          immediate: true,
        })
        .catch(err => $.ui.log(`moon-guard: /${PROCEED} not registered: ${err}`))
    }
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

  on('command.run', { command: PROCEED }, async ($, e) => {
    if (!PERSON.has(e.origin?.kind ?? '')) return { text: 'moon-guard: only the person answers a hold' }
    const isCancel = e.args.trim() === 'cancel'
    if (waiting) {
      const { id, title, isReady } = waiting
      if (!isCancel && !isReady) return { text: `still reading what this ${title} would change — answer once the preview shows` }
      decide(id, isCancel ? 'stop' : 'go')
      return { text: `${isCancel ? 'cancelled' : 'proceeding'}: ${title}` }
    }
    if (isCancel) {
      armedUntil = 0
      return { text: 'nothing held; /proceed disarmed' }
    }
    armedUntil = (await $.clock.now()) + ARM_MS
    return { text: `armed: the next held command within ${ARM_MS / 60_000} min runs without a hold` }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    // The person closing the hold's pane answers it: no.
    if (e.id === HOLD_PANE && waiting && !waiting.isClosing) decide(waiting.id, 'stop')
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
    // A hold still waiting is answered no: nobody is left to press Proceed.
    // An arming belongs to the conversation it was typed in, /clear included.
    if (waiting) decide(waiting.id, 'stop')
    armedUntil = 0
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

  on('ui.render', { component: 'Pane', requestId: HOLD_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cur = await read($, hold)
    if (!cur) return <Text dimColor>nothing held</Text>
    return (
      <Box flexDirection="column">
        <Text key="title" bold>{`moon-guard holds: ${cur.title}`}</Text>
        <Text key="command" dimColor wrap="truncate-end">{`$ ${cur.command}`}</Text>
        <Text key="dir" dimColor wrap="truncate-start">{cur.dir}</Text>
        {cur.warnings.map((w, i) => (
          <Text key={`warn:${i}`} color="red" wrap="truncate-end">{`! ${w}`}</Text>
        ))}
        {cur.lines.map((l, i) => (
          <Text key={`line:${i}`} wrap="truncate-end">{l}</Text>
        ))}
        <Box key="buttons" flexDirection="row">
          {cur.deadline > 0 ? <Button key="proceed" label="Proceed" hotkey="1" variant="primary" onPress={() => decide(cur.id, 'go')} /> : null}
          {cur.deadline > 0 ? <Text key="gap"> </Text> : null}
          <Button key="cancel" label="Cancel" hotkey="2" onPress={() => decide(cur.id, 'stop')} />
        </Box>
        <Text key="hint" dimColor>{`unanswered in ${HOLD_MS / 60_000} min it is refused · /proceed · /proceed cancel`}</Text>
      </Box>
    )
  })

  // A surface that draws no pane: the band above the prompt carries the hold.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const cur = await read($, hold)
    if (!cur || cur.isPlaced) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text key="title" color="yellow" wrap="truncate-end">{`moon-guard holds: ${cur.title} — $ ${cur.command}`}</Text>
        {cur.warnings.slice(0, 2).map((w, i) => (
          <Text key={`warn:${i}`} color="red" wrap="truncate-end">{`! ${w}`}</Text>
        ))}
        {cur.lines.slice(0, 3).map((l, i) => (
          <Text key={`line:${i}`} dimColor wrap="truncate-end">{l}</Text>
        ))}
        <Box key="buttons" flexDirection="row">
          {cur.deadline > 0 ? <Button key="proceed" label="Proceed" hotkey="1" variant="primary" onPress={() => decide(cur.id, 'go')} /> : null}
          {cur.deadline > 0 ? <Text key="gap"> </Text> : null}
          <Button key="cancel" label="Cancel" hotkey="2" onPress={() => decide(cur.id, 'stop')} />
        </Box>
      </Box>
    )
  })
}
