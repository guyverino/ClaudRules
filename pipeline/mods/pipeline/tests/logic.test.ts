import { describe, expect, test } from 'claude-code/testing'

import {
  alarmLines,
  carriesDiff,
  CLASS_LABELS,
  isOversized,
  keptWithGates,
  labelName,
  movedPointer,
  opensTask,
  persistedPath,
  pinSession,
  shouldClassify,
  spawnDenial,
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

  test('a diff counts inline or as a file to Read, a mention of one does not', async () => {
    expect(carriesDiff('Intent: x\n\ndiff --git a/src/x.rs b/src/x.rs\n--- a/src/x.rs\n+++ b/src/x.rs')).toBe(true)
    expect(carriesDiff('changed lines:\n@@ -10,3 +10,4 @@ fn x()')).toBe(true)
    expect(carriesDiff('The diff is saved at C:/tmp/review.diff, Read it.')).toBe(true)
    expect(carriesDiff('see changes.patch')).toBe(true)
    expect(carriesDiff('Review the diff of src/x.rs: I changed the timeout.')).toBe(false)
    expect(carriesDiff('run git diff to see the change')).toBe(false)
    expect(carriesDiff('no .diff saved yet, review from memory')).toBe(false)
    expect(carriesDiff('no `.diff` yet (or a .patch)')).toBe(false)
  })

  test('a review agent without a diff and a second fix-diff are refused; other agents pass', async () => {
    const diff = 'diff --git a/x b/x\n@@ -1 +1 @@'
    expect(spawnDenial('flow', 'review src/x.rs', 0)).toContain('no diff')
    expect(spawnDenial('flow', diff, 0)).toBeUndefined()
    expect(spawnDenial('fix-diff', diff, 0)).toBeUndefined()
    expect(spawnDenial('fix-diff', diff, 1)).toContain('once')
    // a second run of an angle is not §9's business
    expect(spawnDenial('half-fix', diff, 1)).toBeUndefined()
    expect(spawnDenial('Explore', 'find the parser', 0)).toBeUndefined()
    expect(spawnDenial('leak-review', 'read C:/tmp/leak.txt', 0)).toBeUndefined()
  })

  test('a task opens on a typed prompt, as gate-check reads it', async () => {
    expect(opensTask('делай 1 и 2', 'composer')).toBe(true)
    expect(opensTask('/diag', 'composer')).toBe(false)
    expect(opensTask('<task-notification>done</task-notification>', 'task-notification')).toBe(false)
    expect(opensTask('  ', 'composer')).toBe(false)
  })
})
