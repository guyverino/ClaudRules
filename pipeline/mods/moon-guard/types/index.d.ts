/** What the /diag pane draws: the last render_diag.log line and when it was written. */
export type MoonGuardDiag = {
  path: string
  /** The last `[diag ...]` line, raw; empty before one was read. */
  line: string
  /** The log's mtime when that line was read, ms since the epoch; 0 when there is no log. */
  writtenAt: number
  /** When the pane last looked, ms since the epoch: the age shown is now - writtenAt. */
  checkedAt: number
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'moon-guard': {
      diag: MoonGuardDiag
    }
  }
}
