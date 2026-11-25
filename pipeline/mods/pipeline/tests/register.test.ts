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

  test('orchestrated workers each get their own fix-diff; a second one inside a worker is refused', async ($, on) => {
    const started: string[] = []
    on('agent.spawn', ($, e) => {
      started.push(`${e.parentAgentId ?? 'main'}:${e.subagentType ?? ''}`)
      return { model: 'sonnet' }
    })
    on('model.classify', () => ({ value: undefined }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('classic.SessionStart', () => ({ additionalContext: [] }))
    mock.clock(on)
    const diff = 'diff --git a/src/x.rs b/src/x.rs\n@@ -1 +1 @@'
    // A worker's own spawns happen in its loop: the engine names it as parentAgentId.
    const spawn = (subagentType: string, parentAgentId?: string) =>
      $.agent.spawn({ subagentType, prompt: diff, parentAgentId } as never)
    await $.prompt.submit({ text: 'split the feature into two parts', origin: { kind: 'composer' } } as never)

    await spawn('fix-diff', 'worker-a')
    await spawn('fix-diff', 'worker-b')
    const againA = await spawn('fix-diff', 'worker-a')
    await spawn('fix-diff')
    const againMain = await spawn('fix-diff')
    // A typed prompt opens main's next task; a worker's one run belongs to its own task.
    await $.prompt.submit({ text: 'next task: tidy the release notes', origin: { kind: 'composer' } } as never)
    const afterPromptA = await spawn('fix-diff', 'worker-a')
    await spawn('fix-diff')
    // Main's compaction starts its conversation over; a background worker's task goes on.
    await $.classic.SessionStart({ source: 'compact' } as never)
    const afterCompactB = await spawn('fix-diff', 'worker-b')

    expect('deny' in againA && againA.deny).toContain('once')
    expect('deny' in againMain && againMain.deny).toContain('once')
    expect('deny' in afterPromptA && afterPromptA.deny).toContain('once')
    expect('deny' in afterCompactB && afterCompactB.deny).toContain('once')
    expect(started).toEqual(['worker-a:fix-diff', 'worker-b:fix-diff', 'main:fix-diff', 'main:fix-diff'])
  })

  test('a worker session opens its task on the brief; a WARN sent back keeps its one fix-diff', async ($, on) => {
    const started: string[] = []
    on('agent.spawn', ($, e) => {
      started.push(e.subagentType ?? '')
      return { model: 'sonnet' }
    })
    on('model.classify', () => ({ value: undefined }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    mock.clock(on)
    const diff = 'diff --git a/src/x.rs b/src/x.rs\n@@ -1 +1 @@'
    const spawn = () => $.agent.spawn({ subagentType: 'fix-diff', prompt: diff } as never)
    const deliver = (text: string) => $.prompt.submit({ text, origin: { kind: 'peer' } } as never)

    await deliver('[orchestrator-brief] topic / part-a\ndeveloper said: "split it"')
    await spawn()
    await deliver('WARN s9 in your part: the build ran before the edit landed')
    const afterWarn = await spawn()
    await deliver('[orchestrator-brief] topic / part-c\ndeveloper said: "split it"')
    await spawn()

    expect('deny' in afterWarn && afterWarn.deny).toContain('once')
    expect(started).toEqual(['fix-diff', 'fix-diff'])
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

