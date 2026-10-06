/**
 * pipeline — the live half of the working pipeline (~/.claude/CLAUDE.md).
 *
 *   - tool.call (Bash, PowerShell): a by-hand `gate-check.js digest --hand`
 *     gets `--session <this session>`, so it never reads a neighbour's
 *     transcript
 *   - classic.Stop: after the settings Stop hooks ran (gate-check digest among
 *     them), reads this session's report and puts its WARN lines in the band,
 *     so the person sees them when the answer lands, not on the next prompt
 *   - classic.SessionStart: collects the alarm lines into the band, and moves
 *     an entry too large for the hook channel (the engine cuts it to a 2 KB
 *     preview) into the first message's context, whole
 *   - prompt.submit: the small model's §0 class for a typed prompt, attached as
 *     a hint for the model and shown in the band
 *   - agent.spawn: refuses a review agent whose prompt carries no diff (§6) and
 *     a second fix-diff in one task (§9) before they start, where gate-check
 *     could only report them after the turn; the band lists this task's
 *     review agents
 *
 * Every hook fails open: a throw is skipped by the engine and the chain runs
 * as if the mod were absent, which for each of these is the old behaviour.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PipelineBand, PipelineMovedContext } from '../types'
import {
  alarmLines,
  CLASS_LABELS,
  CLASSIFY_MAX_CHARS,
  fit,
  hintContext,
  isOversized,
  keptWithGates,
  labelName,
  MOVE_MAX_CHARS,
  movedName,
  movedPointer,
  opensTask,
  persistedPath,
  pinSession,
  REVIEW_AGENTS,
  shouldClassify,
  spawnDenial,
  warnLines,
} from './logic'

const EMPTY: PipelineBand = { alarms: [], warns: [], report: '', hint: '', agents: [] }
const band = atom({ plugin: 'pipeline', key: 'band' } as const, EMPTY)
const moved = atom({ plugin: 'pipeline', key: 'moved' } as const, [] as PipelineMovedContext[])

// This task's fix-diff spawns and review agents live in the module, not in
// $.state: a dispatch reads state as it stood when it began, so two fix-diff
// spawns in one response would both read 0 and both start. A spawn takes its
// slot before `next(e)` and gives it back only if the engine refused it.
let fixDiffRuns = 0
let taskAgents: string[] = []

// The classifier must not hold a prompt up: past this the prompt goes in without a hint.
const CLASSIFY_TIMEOUT_MS = 3_000
// A report older than the Stop that is reading it was written by an earlier turn.
const REPORT_SLACK_MS = 1_000

// Where gate-check writes its reports: the same root rule as lib/root.js.
async function pipelineDir($: EngineInterface): Promise<string | undefined> {
  const none = () => undefined
  const root =
    (await $.env.get('CLAUDE_PIPELINE_HOME').catch(none)) ||
    (await $.env.get('USERPROFILE').catch(none)) ||
    (await $.env.get('HOME').catch(none))
  return root ? `${root}/.claude/pipeline` : undefined
}

export const register: Register = (on, options) => {
  const wantClassify = options.classify !== false
  const showBand = options.band !== false

  on('tool.call', async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const pinned = pinSession(e.command, await $.session.id())
    return pinned === undefined ? next(e) : next({ ...e, command: pinned })
  })

  on('classic.Stop', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const r = await next(e)
    const dir = await pipelineDir($)
    if (!dir) return r
    const file = `${dir}/gate-report-${e.session_id.slice(0, 8)}.txt`
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.mtimeMs < startedAt - REPORT_SLACK_MS) return r
    const warns = warnLines(await $.fs.read(file))
    await update($, band, b => ({ ...b, warns, report: warns.length ? file : '' }))
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    const entries = r.additionalContext ?? []
    // Each entry whole: an oversized one may reach us as the engine's 2 KB
    // preview, and alarm lines past the cut must still count.
    const whole: string[] = []
    for (const entry of entries) {
      const saved = persistedPath(entry)
      whole.push(saved === undefined ? entry : ((await $.fs.read(saved).catch(() => undefined)) ?? entry))
    }
    await update($, band, () => ({ ...EMPTY, alarms: alarmLines(whole) }))
    fixDiffRuns = 0
    taskAgents = []
    // Whatever an earlier conversation of this process carried is not this one's.
    await update($, moved, () => [])
    // A resumed or forked conversation already has its first message: nothing
    // would carry a moved entry, so it stays where it is.
    if (e.source === 'resume' || e.source === 'fork') return r
    const kept: string[] = []
    const carried: PipelineMovedContext[] = []
    entries.forEach((entry, i) => {
      const text = whole[i] ?? entry
      if (!isOversized(entry)) {
        kept.push(entry)
        return
      }
      // A preview whose saved file could not be read has nothing whole to move,
      // and a text past the bound stays too: either keeps its gate lines first.
      const unreadable = persistedPath(entry) !== undefined && text === entry
      if (unreadable || text.length > MOVE_MAX_CHARS) {
        kept.push(keptWithGates(entry, text))
        return
      }
      const name = movedName(carried.length)
      carried.push({ name, text })
      kept.push(movedPointer(name, text))
    })
    await update($, moved, () => carried)
    if (kept.every((k, i) => k === entries[i])) return r
    // prompt.context fires when the first message is built; on /clear and
    // compaction the engine re-reads it, so the new blocks reach that one too.
    if (carried.length > 0) $.ui.invalidate('prompt.context')
    return { ...r, additionalContext: kept }
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const carried = await read($, moved)
    if (carried.length === 0) return r
    const names = new Set(carried.map(c => c.name))
    return { ...r, blocks: [...r.blocks.filter(b => !names.has(b.name)), ...carried] }
  })

  on('prompt.submit', async ($, e, next) => {
    // A new prompt: the alarms and the last report's WARNs have been seen.
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk') {
      await update($, band, b => ({ ...b, alarms: [], warns: [], report: '', hint: '' }))
    }
    // A new task: its agents and its one fix-diff are counted afresh.
    if (opensTask(e.text, e.origin.kind)) {
      fixDiffRuns = 0
      taskAgents = []
      await update($, band, b => ({ ...b, agents: [] }))
    }
    if (!wantClassify || !shouldClassify(e.text, e.origin.kind)) return next(e)
    const asked = $.model.classify(e.text.slice(0, CLASSIFY_MAX_CHARS), CLASS_LABELS).catch(() => undefined)
    const late = $.clock.sleep(CLASSIFY_TIMEOUT_MS).then(() => undefined)
    const got = await Promise.race([asked, late])
    if (!got) return next(e)
    const label = labelName(got)
    await update($, band, b => ({ ...b, hint: label }))
    return next({ ...e, context: [...(e.context ?? []), hintContext(label)] })
  })

  on('agent.spawn', async ($, e, next) => {
    const type = e.subagentType
    if (!REVIEW_AGENTS.has(type)) return next(e)
    const denied = spawnDenial(type, e.prompt, fixDiffRuns)
    if (denied) {
      taskAgents = [...taskAgents, `✖${type}`]
      await update($, band, b => ({ ...b, agents: taskAgents }))
      return { deny: denied }
    }
    if (type === 'fix-diff') fixDiffRuns += 1
    // The slot goes back when the spawn did not happen: refused or failed.
    const giveBack = () => {
      if (type === 'fix-diff') fixDiffRuns -= 1
    }
    const r = await next(e).catch(err => {
      giveBack()
      throw err
    })
    if ('deny' in r) {
      giveBack()
      return r
    }
    taskAgents = [...taskAgents, type]
    await update($, band, b => ({ ...b, agents: taskAgents }))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const b = await read($, band)
    if (b.alarms.length === 0 && b.warns.length === 0 && !b.hint && b.agents.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {b.alarms.slice(0, 4).map((line, i) => (
          <Text key={`alarm:${i}`} color="yellow">
            {fit(`⚠ ${line}`, width)}
          </Text>
        ))}
        {b.warns.length > 0 && (
          <Text key="warns" color="red">
            {fit(`✖ gate-check: ${b.warns.length} WARN · ${b.warns[0]}`, width)}
          </Text>
        )}
        {b.warns.length > 0 && (
          <Text key="report" dimColor>
            {fit(`  ${b.report}`, width)}
          </Text>
        )}
        {b.agents.length > 0 && (
          <Text key="agents" dimColor>
            {fit(`§6/§9 agents: ${b.agents.join(' · ')}`, width)}
          </Text>
        )}
        {b.hint && (
          <Text key="hint" dimColor>
            {fit(`§0 hint: ${b.hint}`, width)}
          </Text>
        )}
      </Box>
    )
  })
}
