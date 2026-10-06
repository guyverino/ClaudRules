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

/**
 * A shell command held for the person to confirm (hooks/hold.ts), with what it
 * would change: what the pane draws. The answer itself lives in the module
 * (register.tsx `waiting`), where the hold's own loop can see it.
 */
export type MoonGuardHold = {
  /** Which hold this is: a press or a /proceed meant for an earlier one is dropped. */
  id: number
  /** What kind of command, as the pane's title reads it (`git push`, `PR merge`, ...). */
  title: string
  /** The command as the model wrote it, cut to one screen line or so. */
  command: string
  /** The repository the preview was read in. */
  dir: string
  /** The read-only preview: commits, files, checks, lock moves. */
  lines: string[]
  /** What the person must not miss: a force push, a red check, a dirty tree. */
  warnings: string[]
  /** When an unanswered hold turns into a refusal, ms since the epoch. */
  deadline: number
  /** Whether a surface drew the pane; when none did, the band carries the buttons. */
  isPlaced: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'moon-guard': {
      diag: MoonGuardDiag
      /** The command held right now, or null. */
      hold: MoonGuardHold | null
    }
  }
}
