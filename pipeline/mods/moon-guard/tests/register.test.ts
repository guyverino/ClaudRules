import { describe, expect, test } from 'claude-code/testing'

const LIVE_PATCH = '[patch."https://github.com/Moonbot-Tech/MoonUI"]\nmoon-ui = { path = "D:/projects/MoonUI/crates/moon-ui" }\n'
const OK = { result: { stdout: '', stderr: '', interrupted: false } }

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
})
