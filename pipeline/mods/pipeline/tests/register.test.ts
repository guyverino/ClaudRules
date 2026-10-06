import { describe, expect, mock, test } from 'claude-code/testing'

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

  test('a review agent without a diff never starts, and fix-diff starts once per task', async ($, on) => {
    const started: string[] = []
    on('agent.spawn', ($, e) => {
      started.push(e.subagentType ?? '')
      return { model: 'sonnet' }
    })
    on('model.classify', () => ({ value: undefined }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    mock.clock(on)
    const diff = 'diff --git a/src/x.rs b/src/x.rs\n@@ -1 +1 @@'
    // The engine pins the rest of a spawn (tool_use_id, provider, parentModel...); the hook reads these two.
    const spawn = (subagentType: string, prompt: string) => $.agent.spawn({ subagentType, prompt } as never)

    const blind = await spawn('flow', 'review the timeout change in src/x.rs')
    await spawn('flow', diff)
    await spawn('fix-diff', diff)
    const again = await spawn('fix-diff', diff)
    await spawn('Explore', 'where is the parser')
    await $.prompt.submit({ text: 'next task: fix the parser timeout please', origin: { kind: 'composer' } } as never)
    await spawn('fix-diff', diff)

    expect('deny' in blind && blind.deny).toContain('no diff')
    expect('deny' in again && again.deny).toContain('once')
    expect(started).toEqual(['flow', 'fix-diff', 'Explore', 'fix-diff'])
  })

  test('two fix-diff spawns in one response: exactly one starts', async ($, on) => {
    const started: string[] = []
    on('agent.spawn', ($, e) => {
      started.push(e.subagentType ?? '')
      return { model: 'sonnet' }
    })
    on('model.classify', () => ({ value: undefined }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    mock.clock(on)
    const diff = 'diff --git a/src/x.rs b/src/x.rs\n@@ -1 +1 @@'
    const spawn = (subagentType: string, prompt: string) => $.agent.spawn({ subagentType, prompt } as never)
    await $.prompt.submit({ text: 'a fresh task that reviews its own fixes', origin: { kind: 'composer' } } as never)

    const both = await Promise.all([spawn('fix-diff', diff), spawn('fix-diff', diff)])

    expect(both.filter(r => 'deny' in r).length).toBe(1)
    expect(started).toEqual(['fix-diff'])
  })
})

