import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const LIVE_PATCH = '[patch."https://github.com/Moonbot-Tech/MoonUI"]\nmoon-ui = { path = "D:/projects/MoonUI/crates/moon-ui" }\n'
const OK = { result: { stdout: '', stderr: '', interrupted: false } }
// The pane's props the hook reads; the surface's scroll and view state are left to the kit.
const PANE = { title: 'hold: git push', isFocused: true, bodyColumns: 100, placement: 'dock' } as never

/** A MoonTerminal checkout with no [patch] override, git answering the preview, and a surface that places panes (or not). */
function world(on: On, ran: string[], surfaces: string[] = ['vscode'], isPlaced = true) {
  const clock = mock.clock(on)
  on('session.root', () => ({ value: 'D:/r' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '' }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'an older desktop places no panes' } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', async ($, e) => {
    // The hold's nap between looks: a child that lives as long as it was asked to, on the test's clock.
    if (e.argv[0] === 'node') {
      await clock.sleep(Number(e.argv[3]))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const cmd = e.argv.join(' ')
    const stdout = cmd.startsWith('git status') ? '## feat/x...origin/feat/x [ahead 1]' : cmd.startsWith('git log') ? 'abc1234 feat(x): the change' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') ran.push(e.command)
    return OK
  })
  return clock
}

describe('register', () => {
  test('a cargo build without the target never reaches the shell', async ($, on) => {
    const ran: string[] = []
    on('session.root', () => ({ value: 'D:/r' }))
    on('fs.exists', () => ({ value: true }))
    on('tool.call', ($, e) => {
      if (e.tool === 'Bash') ran.push(e.command)
      return OK
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'cargo build -p moon-core' })
    await $.tool.call({ tool: 'Bash', command: 'cargo build -p moon-core --target x86_64-pc-windows-msvc' })

    expect(r.deny).toContain('--target')
    expect(ran).toEqual(['cargo build -p moon-core --target x86_64-pc-windows-msvc'])
  })

  test('outside MoonTerminal the rules stay out of the way', async ($, on) => {
    const ran: string[] = []
    on('session.root', () => ({ value: 'D:/other' }))
    on('fs.exists', () => ({ value: false }))
    on('tool.call', ($, e) => {
      if (e.tool === 'Bash') ran.push(e.command)
      return OK
    })

    await $.tool.call({ tool: 'Bash', command: 'cargo build -p other' })

    expect(ran).toEqual(['cargo build -p other'])
  })

  test('a commit carrying Cargo.lock under a live [patch] is refused, without one it runs', async ($, on) => {
    let config = LIVE_PATCH
    const ran: string[] = []
    on('session.root', () => ({ value: 'D:/r' }))
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: config }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'Cargo.lock\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', ($, e) => {
      if (e.tool === 'Bash') ran.push(e.command)
      return OK
    })

    const refused = await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
    config = '# [patch."https://github.com/Moonbot-Tech/MoonUI"]\n'
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "y"' })

    expect(refused.deny).toContain('Cargo.lock')
    expect(ran).toEqual(['git commit -m "y"'])
  })

  test('a push waits for the person: Proceed in the pane runs it', async ($, on) => {
    const ran: string[] = []
    const clock = world(on, ran)

    const pending = $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
    await clock.settle()
    expect(ran).toEqual([])
    const pane = await $.ui.mount({ plugin: 'moon-guard', surface: 'vscode', component: 'Pane', props: PANE, requestId: 'hold' })
    expect(JSON.stringify(await pane.drawn())).toContain('abc1234 feat(x): the change')
    // the press settles only once the hold, asleep on the clock, moves on
    const pressed = pane.press({ key: 'proceed' })
    await clock.advance(250)
    await pressed
    const r = await pending

    expect('deny' in r).toBe(false)
    expect(ran).toEqual(['git push -u origin feat/x'])
  })

  test('the terminal draws the same pane, and Cancel refuses with the preview', async ($, on) => {
    const ran: string[] = []
    const clock = world(on, ran, ['terminal'])

    const pending = $.tool.call({ tool: 'Bash', command: 'git push --force origin feat/x' })
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'moon-guard', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'hold' })
    expect(JSON.stringify(await pane.drawn())).toContain('FORCE push')
    // the press settles only once the hold, asleep on the clock, moves on
    const pressed = pane.press({ key: 'cancel' })
    await clock.advance(250)
    await pressed
    const r = await pending

    expect('deny' in r && r.deny).toContain('cancelled')
    expect('deny' in r && r.deny).toContain('abc1234 feat(x): the change')
    expect(ran).toEqual([])
  })

  test('unanswered, the hold is refused after two minutes and says how to confirm', async ($, on) => {
    const ran: string[] = []
    const clock = world(on, ran)

    const pending = $.tool.call({ tool: 'Bash', command: 'gh pr merge 42 --squash' })
    await clock.settle()
    await clock.advance(119_000)
    expect(ran).toEqual([])
    await clock.advance(1_500)
    const r = await pending

    expect('deny' in r && r.deny).toContain('not answered within 120 s')
    expect('deny' in r && r.deny).toContain('/proceed')
    expect(ran).toEqual([])
  })

  test('with no surface to confirm on, the hold refuses at once', async ($, on) => {
    const ran: string[] = []
    world(on, ran, [])

    const r = await $.tool.call({ tool: 'Bash', command: 'git reset --hard origin/main' })

    expect('deny' in r && r.deny).toContain('headless')
    expect(ran).toEqual([])
  })

  test('a dry run and a commit message naming a push run without a hold', async ($, on) => {
    const ran: string[] = []
    world(on, ran)

    await $.tool.call({ tool: 'Bash', command: 'git push --dry-run origin feat/x' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "docs: never git push --force"' })

    expect(ran).toEqual(['git push --dry-run origin feat/x', 'git commit -m "docs: never git push --force"'])
  })

  test('a plugin cannot answer a hold or arm /proceed for the person', async ($, on) => {
    const ran: string[] = []
    const clock = world(on, ran)

    const said = await $.command.run({ command: 'proceed' } as never)
    const pending = $.tool.call({ tool: 'Bash', command: 'git push' })
    await clock.settle()
    await $.command.run({ command: 'proceed' } as never)
    await clock.advance(121_000)
    const r = await pending

    expect(JSON.stringify(said)).toContain('only the person')
    expect('deny' in r).toBe(true)
    expect(ran).toEqual([])
  })

  test('where no pane is placed, the band above the prompt carries the buttons', async ($, on) => {
    const ran: string[] = []
    const clock = world(on, ran, ['vscode'], false)

    const pending = $.tool.call({ tool: 'Bash', command: 'git reset --hard origin/main' })
    await clock.settle()
    const band = await $.ui.mount({
      plugin: 'moon-guard',
      surface: 'vscode',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } as never,
    })
    expect(JSON.stringify(await band.drawn())).toContain('discard uncommitted work')
    const pressed = band.press({ key: 'proceed' })
    await clock.advance(250)
    await pressed
    const r = await pending

    expect('deny' in r).toBe(false)
    expect(ran).toEqual(['git reset --hard origin/main'])
  })

  test('a hold closing its own pane does not cancel the next hold', async ($, on) => {
    const ran: string[] = []
    const clock = world(on, ran)

    const first = $.tool.call({ tool: 'Bash', command: 'git push origin feat/a' })
    await clock.settle()
    const pane = await $.ui.mount({ plugin: 'moon-guard', surface: 'vscode', component: 'Pane', props: PANE, requestId: 'hold' })
    const pressed = pane.press({ key: 'proceed' })
    await clock.advance(250)
    await pressed
    await first
    const second = $.tool.call({ tool: 'Bash', command: 'git push origin feat/b' })
    await clock.advance(1_000)
    expect(ran).toEqual(['git push origin feat/a'])
    const again = pane.press({ key: 'proceed' })
    await clock.advance(250)
    await again
    const r = await second

    expect('deny' in r).toBe(false)
    expect(ran).toEqual(['git push origin feat/a', 'git push origin feat/b'])
  })
})

