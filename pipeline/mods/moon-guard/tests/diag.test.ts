import { describe, expect, test } from 'claude-code/testing'

import { diagLogPath, isZero, parseDiag } from '../hooks/diag'

describe('diag', () => {
  test('a counter line parses into its pairs, in order', async () => {
    const d = parseDiag('[diag 1043ms] cpu=3.7 sys=14.8 gpu=3.3 mem=9038 orders_render=10 chart_hover_notify=0')
    expect(d?.windowMs).toBe(1043)
    expect(d?.pairs[0]).toEqual(['cpu', '3.7'])
    expect(d?.pairs.length).toBe(6)
    expect(parseDiag('some other log line')).toBeUndefined()
    expect(parseDiag('')).toBeUndefined()
  })

  test('the log path follows the profile', async () => {
    expect(diagLogPath('D:/r', '')).toBe('D:/r/target/x86_64-pc-windows-msvc/debug/logs/render_diag.log')
    expect(diagLogPath('D:/r', 'inspector')).toBe('D:/r/target/x86_64-pc-windows-msvc/inspector/logs/render_diag.log')
    expect(diagLogPath('D:/r', 'release')).toBe('D:/r/target/x86_64-pc-windows-msvc/release/logs/render_diag.log')
    expect(diagLogPath('D:/r', 'C:/x/render_diag.log')).toBe('C:/x/render_diag.log')
  })

  test('zero is told from a value', async () => {
    expect(isZero('0')).toBe(true)
    expect(isZero('0.0')).toBe(true)
    expect(isZero('10')).toBe(false)
    expect(isZero('0.4')).toBe(false)
  })
})
