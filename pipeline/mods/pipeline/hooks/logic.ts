/**
 * logic.ts — the pure half of the pipeline mod: no `$`, no engine, so every
 * rule here is a plain function a test can call.
 */

/** Longest SessionStart context entry that still travels the hook channel whole. */
export const HOOK_CONTEXT_LIMIT = 10_000

// gate-check.js digest run by hand, as §10 spells it (the path may be quoted),
// up to its --hand on the same line.
const GATE_HAND_RE = /(gate-check\.js["']?\s+digest\b[^\n]*?)--hand\b/
const SESSION_RE = /--session\b/

/**
 * The command with what is data rather than shell taken out: heredoc bodies
 * and quoted spans holding whitespace (a commit message, an echo).
 */
export function bare(command: string): string {
  return (
    command
      .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<$2$3')
      // One pass, left to right, so quotes pair up in order: a pass per quote
      // kind would take the gap between two quoted spans for a span.
      .replace(/"([^"\n]*)"|'([^'\n]*)'/g, (span: string, dq?: string, sq?: string) =>
        /\s/.test(dq ?? sq ?? '') ? (dq !== undefined ? '""' : "''") : span,
      )
  )
}

/**
 * A by-hand `gate-check.js digest --hand` with `--session <sid>` added, or
 * undefined when the command runs no such thing (a commit message naming it
 * runs nothing) or already pins a session.
 *
 * Without the pin gate-check takes the newest transcript for the cwd, which
 * with several sessions live in one repo is regularly a neighbour's.
 */
export function pinSession(command: string, sessionId: string): string | undefined {
  const shell = bare(command)
  if (!sessionId || !GATE_HAND_RE.test(shell) || SESSION_RE.test(shell)) return undefined
  return command.replace(GATE_HAND_RE, `$1--hand --session ${sessionId}`)
}

// The SessionStart lines that ask for an action before the first edit or build:
// leak-check.js status (parallel work, leak review, release surface) and a
// project hook's dependency pin that fell behind.
const ALARM_RE = /^(PARALLEL WORK|LEAK REVIEW PENDING|RELEASE SURFACE)\b|: ОТСТАЁТ(\s|$)/

export function fit(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

/** The alarm lines of the SessionStart context, in order, each once. */
export function alarmLines(contexts: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const entry of contexts) {
    for (const raw of entry.split('\n')) {
      const line = raw.trim()
      if (ALARM_RE.test(line)) seen.add(line)
    }
  }
  return [...seen]
}

// The lines gate-check (lib/digest.js) arms its §1/§5 gates from, which it
// reads in the hook channel alone: the alarms, and CONTRIBUTORS, which re-arms
// §1 after a mid-task pull.
const GATE_RE = /^(PARALLEL WORK|LEAK REVIEW PENDING|RELEASE SURFACE|CONTRIBUTORS)\b/

/** The lines of a text gate-check reads at session start, in order. */
export const gateLines = (text: string) =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(l => GATE_RE.test(l))

/**
 * An oversized entry kept in the hook channel, with its gate lines put first:
 * the engine cuts it to a 2 KB preview, and the lines past the cut would be lost.
 */
export const keptWithGates = (entry: string, whole: string) => [...gateLines(whole), entry].join('\n')

/** The WARN lines of a gate-check report. */
export function warnLines(report: string): string[] {
  return report
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^WARN\b/.test(l))
}

const PERSISTED_RE = /^<persisted-output>[\s\S]*?Full output saved to:\s*(\S[^\n]*?)\s*$/m

/**
 * The file the engine saved an oversized hook output to, when the entry is
 * its `<persisted-output>` preview; undefined for a whole entry.
 */
export function persistedPath(entry: string): string | undefined {
  if (!entry.startsWith('<persisted-output>')) return undefined
  return entry.match(PERSISTED_RE)?.[1]
}

/** Whether a SessionStart context entry is too large for the hook channel. */
export const isOversized = (entry: string) => entry.length > HOOK_CONTEXT_LIMIT || persistedPath(entry) !== undefined

/**
 * Largest text moved into the first message: past it the model would read only
 * a head and a path anyway (prompt.submit's own bound), so it stays as it was.
 */
export const MOVE_MAX_CHARS = 100_000

/** The context block name a moved entry renders under: unique, readable. */
export const movedName = (index: number) => `sessionStartContext${index + 1}`

/**
 * What stays in the hook channel in place of a moved entry, so the model knows
 * where it went. The entry's gate lines stay here too: gate-check
 * (lib/digest.js) arms its §1/§5 gates from the hook channel alone.
 */
export function movedPointer(name: string, text: string): string {
  const first = fit(text.split('\n').find(l => l.trim() !== '')?.trim() ?? '', 120)
  const pointer = `[pipeline mod] A SessionStart context of ${text.length} characters ("${first}") is too large for the hook channel; it is delivered whole in the first message's context block "${name}".`
  return [pointer, ...gateLines(text)].join('\n')
}

/**
 * The §0 classes, each with the one line the small model reads; the label the
 * mod reports is the part before the colon.
 */
export const CLASS_LABELS = [
  'trivial: copy, comment or log text only; nothing observable at runtime changes',
  'small: a contained runtime change in 1-3 files of one module',
  'rename: a rename, signature or contract change that callers see',
  'feature: new behaviour, possibly across several files or modules',
  'refactor: restructuring code without changing its behaviour',
  'bug: a defect or regression to reproduce and fix',
  'perf: speed, timing, render frequency or resource use',
  'research: a question, review or investigation with no code edits',
] as const

export const labelName = (label: string) => (label.split(':')[0] ?? '').trim()

/** Shortest typed prompt worth classifying: below it a follow-up ("do 1+2") says nothing alone. */
export const CLASSIFY_MIN_CHARS = 40
/** The part of a long prompt the classifier reads. */
export const CLASSIFY_MAX_CHARS = 4_000

/** A prompt the person typed, long enough to classify, and not a slash command. */
export function shouldClassify(text: string, originKind: string): boolean {
  if (originKind !== 'composer' && originKind !== 'bridge' && originKind !== 'sdk') return false
  const t = text.trim()
  return t.length >= CLASSIFY_MIN_CHARS && !t.startsWith('/')
}

/** The note the model reads beside the prompt. */
export function hintContext(label: string): string {
  return `[pipeline mod] §0 hint: the small model reads this prompt, taken alone, as "${label}". A hint, not the class: the §0 small-test and the stated class line still decide.`
}
