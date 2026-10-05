import { describe, expect, test } from 'claude-code/testing'

import {
  alarmLines,
  CLASS_LABELS,
  isOversized,
  keptWithGates,
  labelName,
  movedPointer,
  persistedPath,
  pinSession,
  shouldClassify,
  warnLines,
} from '../hooks/logic'

const SID = '1772a474-d164-41dc-862b-203f1c6bbf6d'

describe('logic', () => {
  test('a by-hand gate-check digest is pinned to the session', async () => {
    const ps = 'node "{{CLAUDE_HOME}}\\pipeline\\gate-check.js" digest --hand'
    expect(pinSession(ps, SID)).toBe(`node "{{CLAUDE_HOME}}\\pipeline\\gate-check.js" digest --hand --session ${SID}`)
    expect(pinSession('node ~/.claude/pipeline/gate-check.js digest --hand 2>&1 | tail -40', SID)).toContain(`--hand --session ${SID} 2>&1`)
  })

  test('anything else is left as written', async () => {
    expect(pinSession(`node gate-check.js digest --hand --session abc12345`, SID)).toBeUndefined()
    // two quoted spans: the gap between them is shell, not data
    expect(pinSession('node "C:/x y/gate-check.js" digest --hand --prefix "D:/a b"', SID)).toBeUndefined()
    expect(pinSession('node "C:/x/gate-check.js" digest --hand --prefix "D:/a b"', SID)).toContain(`--hand --session ${SID}`)
    expect(pinSession('node gate-check.js digest', SID)).toBeUndefined()
    expect(pinSession('node gate-check.js report --hand', SID)).toBeUndefined()
    expect(pinSession('node leak-check.js others --hand', SID)).toBeUndefined()
    expect(pinSession('node gate-check.js digest --hand', '')).toBeUndefined()
    expect(pinSession('git commit -m "fix: pin gate-check.js digest --hand runs"', SID)).toBeUndefined()
    expect(pinSession("cat > a.md <<'EOF'\nnode gate-check.js digest --hand\nEOF", SID)).toBeUndefined()
  })

  test('a moved entry keeps its alarm lines in the hook channel', async () => {
    const p = movedPointer('sessionStartContext1', 'Conventions\nLEAK REVIEW PENDING: 2 commit(s)\nbody')
    expect(p.split('\n')).toEqual([expect.stringContaining('"Conventions"'), 'LEAK REVIEW PENDING: 2 commit(s)'])
    const c = movedPointer('sessionStartContext1', 'x\nCONTRIBUTORS: this repo has commits by others\ny')
    expect(c).toContain('\nCONTRIBUTORS: this repo has commits by others')
  })

  test('an oversized entry kept whole puts its gate lines first', async () => {
    const kept = keptWithGates('<persisted-output>preview</persisted-output>', 'a\nPARALLEL WORK: 2 commit(s)\nb')
    expect(kept.split('\n')[0]).toBe('PARALLEL WORK: 2 commit(s)')
    expect(kept.endsWith('<persisted-output>preview</persisted-output>')).toBe(true)
  })

  test('alarm lines come out of the session-start context, once each', async () => {
    const ctx = [
      'Code conventions for this repository\nPARALLEL WORK: 1 commit(s) by others on main\n',
      'MoonUI: ОТСТАЁТ — пин 48f5a650, сейчас 4be35c16\nMoonTerminal: origin/main ушёл на 0\nPARALLEL WORK: 1 commit(s) by others on main',
      'LEAK REVIEW PENDING: 2 commit(s)\nRELEASE SURFACE CHANGED by kyrylo — abc\nCONTRIBUTORS: none new',
    ]
    expect(alarmLines(ctx)).toEqual([
      'PARALLEL WORK: 1 commit(s) by others on main',
      'MoonUI: ОТСТАЁТ — пин 48f5a650, сейчас 4be35c16',
      'LEAK REVIEW PENDING: 2 commit(s)',
      'RELEASE SURFACE CHANGED by kyrylo — abc',
    ])
    expect(alarmLines([])).toEqual([])
  })

  test('only WARN lines of a report count', async () => {
    const report = 'pipeline gate check\nsession: 1772a474\n\nok    s6 - review\nWARN  s7 - no runtime check\n  WARN  s9 - x\nsummary: 2 WARN'
    expect(warnLines(report)).toEqual(['WARN  s7 - no runtime check', 'WARN  s9 - x'])
    expect(warnLines('all gates clean')).toEqual([])
  })

  test('an oversized entry, whole or persisted, is told apart', async () => {
    const persisted = '<persisted-output>\nOutput too large (19.8KB). Full output saved to: C:\\Users\\G\\tool-results\\hook-1.txt\n\nPreview (first 2KB):\nCode conventions\n...\n</persisted-output>'
    expect(persistedPath(persisted)).toBe('C:\\Users\\G\\tool-results\\hook-1.txt')
    expect(isOversized(persisted)).toBe(true)
    expect(isOversized('x'.repeat(10_001))).toBe(true)
    expect(isOversized('x'.repeat(10_000))).toBe(false)
    expect(persistedPath('PARALLEL WORK: 1')).toBeUndefined()
    expect(movedPointer('sessionStartContext1', '\nCode conventions (CONTRIBUTING.md):\nbody')).toContain('"Code conventions (CONTRIBUTING.md):"')
  })

  test('only typed prompts long enough are classified', async () => {
    const long = 'Сделай рефакторинг модуля журнала, чтобы он писал строки пачками'
    expect(shouldClassify(long, 'composer')).toBe(true)
    expect(shouldClassify(long, 'sdk')).toBe(true)
    expect(shouldClassify(long, 'task-notification')).toBe(false)
    expect(shouldClassify('Делай 1+2', 'composer')).toBe(false)
    expect(shouldClassify('/publish ' + long, 'composer')).toBe(false)
  })

  test('every class label has a name before its colon', async () => {
    expect(CLASS_LABELS.map(labelName)).toEqual(['trivial', 'small', 'rename', 'feature', 'refactor', 'bug', 'perf', 'research'])
  })
})
