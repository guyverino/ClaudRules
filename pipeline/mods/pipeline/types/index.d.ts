/** What the band above the prompt shows; each part empty when there is nothing to say. */
export type PipelineBand = {
  /** Alarm lines the SessionStart hooks printed (parallel work, leak review, release surface). */
  alarms: string[]
  /** The WARN lines of this session's gate-check report, written by the Stop hook. */
  warns: string[]
  /** Where that report is, for the person to open. */
  report: string
  /** The §0 class the small model read in the last typed prompt. */
  hint: string
}

/** A SessionStart context entry too large for the hook channel, carried to the first message instead. */
export type PipelineMovedContext = { name: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    pipeline: { band: PipelineBand; moved: PipelineMovedContext[] }
  }
}
