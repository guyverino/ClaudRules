import { describe, expect, test } from 'claude-code/testing'

const SID = '1772a474-d164-41dc-862b-203f1c6bbf6d'

describe('register', () => {
  test('a by-hand gate-check reaches the shell pinned to this session', async ($, on) => {
    const ran: string[] = []
    on('session.id', () => ({ value: SID }))
    on('tool.call', ($, e) => {
      if (e.tool === 'Bash') ran.push(e.command)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    await $.tool.call({ tool: 'Bash', command: 'node ~/.claude/pipeline/gate-check.js digest --hand' })
    await $.tool.call({ tool: 'Bash', command: 'git status' })

    expect(ran).toEqual([`node ~/.claude/pipeline/gate-check.js digest --hand --session ${SID}`, 'git status'])
  })

  test('an oversized SessionStart entry leaves a pointer with its alarms; a resume keeps it', async ($, on) => {
    const big = 'Code conventions (CONTRIBUTING.md):\nPARALLEL WORK: 1 commit(s) by others\n' + 'x'.repeat(12_000)
    on('classic.SessionStart', () => ({ additionalContext: [big, 'short one'] }))

    const fresh = await $.classic.SessionStart({ source: 'startup' })
    const resumed = await $.classic.SessionStart({ source: 'resume' })

    expect(fresh.additionalContext?.[0]).toContain('sessionStartContext1')
    expect(fresh.additionalContext?.[0]).toContain('PARALLEL WORK: 1 commit(s) by others')
    expect(fresh.additionalContext?.[0]?.length).toBeLessThan(1_000)
    expect(fresh.additionalContext?.[1]).toBe('short one')
    expect(resumed.additionalContext).toEqual([big, 'short one'])
  })
})
