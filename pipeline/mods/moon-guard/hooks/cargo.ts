/**
 * cargo.ts — the pure half of moon-guard's shell rules for MoonTerminal
 * (CLAUDE.md, "Build"): no `$`, so every rule is a plain function a test can call.
 */

/** The one target the app is built and run for on Windows. */
export const TARGET = 'x86_64-pc-windows-msvc'

// Subcommands that produce or run an artifact: without --target they build
// into target\debug, a different binary from the one the person runs.
// `check` is left out on purpose: CLAUDE.md uses it bare as a fast type-check.
const CARGO_RE = /(?:^|[\s"'&(\\/])cargo(?:\.exe)?["']?\s+(?:\+\S+\s+)?(build|test|run|clippy|bench|rustc|doc)\b/
// `--target` itself, not `--target-dir`.
const TARGET_RE = /--target(?:=|\s|$)/
const GIT_COMMIT_RE = /(?:^|[\s"'&(])git(?:\.exe)?["']?\s+(?:-[Cc]\s+\S+\s+)*commit\b/
const GIT_ADD_RE = /(?:^|[\s"'&(])git(?:\.exe)?["']?\s+(?:-[Cc]\s+\S+\s+)*add\b/
// -a, --all, or -a inside a cluster (-am); `--amend` is not one.
const COMMIT_ALL_RE = /\s(?:--all\b|-[A-Za-z]*a[A-Za-z]*\b)/
// A `git add` that can stage the lock: everything, tracked changes, the tree, or the file itself.
const ADD_LOCK_RE = /\s(?:-A\b|--all\b|-u\b|--update\b|\.(?:\s|$)|Cargo\.lock\b)/
// A shell handed its command as one quoted argument: `cmd /c "..."`,
// `powershell -Command "..."`, `bash -c '...'`. Tied to the shell's name, so
// git's own `-C "<path>"` is not taken for one.
const INNER_RE = /(\b(?:cmd|powershell|pwsh|bash|sh)(?:\.exe)?["']?(?:\s+-\w+)*\s+)(-c|-Command|\/c|\/k)\s+(["'])([^\n]*?)\3/gi
// A shell wrapper around vcvars: its escaped inner quotes (`\"...\"`, `""...""`)
// defeat the unwrap above, so this is read on the raw command.
const WRAPPED_VCVARS_RE = /\b(?:cmd|powershell|pwsh)(?:\.exe)?\b[\s\S]*vcvars[\s\S]*\bcargo\b/i
// A quoted span that is a program's path stays a command even with a space in
// it; a message that merely ends in `.exe` does not start like a path.
const PROGRAM_RE = /^(?:[A-Za-z]:[\\/]|[\\/~.])[^\n]*\.(?:bat|cmd|exe)$/i

/**
 * The command with its heredoc bodies and PowerShell here-strings taken out:
 * text written to a file or a program's stdin, never run by this shell.
 */
export function withoutDocs(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<$2$3')
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '@@')
}

/**
 * The command with what is data rather than shell taken out: heredoc bodies,
 * PowerShell here-strings, and quoted spans holding whitespace (a commit
 * message, an echo). Line continuations (a trailing backtick or backslash)
 * are joined first, and a command handed to an inner shell as one quoted
 * argument is unwrapped. A quoted path stays when it has no space in it or
 * names a program: it can be the program itself (`"C:\...\cargo.exe" build`).
 */
export function bare(command: string): string {
  return (
    withoutDocs(command)
      .replace(/[`\\]\r?\n/g, ' ')
      .replace(INNER_RE, '$1$2 ; $4 ;')
      // One pass, left to right, so quotes pair up in order: two passes (or one
      // per quote kind) would take the gap between two quoted spans for a span.
      .replace(/"([^"\n]*)"|'([^'\n]*)'/g, (span: string, dq?: string, sq?: string) => {
        const body = dq ?? sq ?? ''
        return /\s/.test(body) && !PROGRAM_RE.test(body) ? (dq !== undefined ? '""' : "''") : span
      })
  )
}

/** The command's simple commands: split at newlines, `;`, `&&`, `||` and pipes. */
function segments(command: string): string[] {
  return bare(command)
    .split(/\r?\n|;|&&|\|\||\|/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * Why the command must not run as written, or undefined. Two rules:
 * a cargo build/test/run/clippy without `--target`, and the vcvars wrapper
 * (it hangs under the Bash tool; the MSVC linker is already on PATH).
 */
export function cargoDenial(command: string): string | undefined {
  const segs = segments(command)
  const vcvarsSeg = segs.some(s => /vcvars/i.test(s)) && segs.some(s => /(?:^|[\s"'\\/])cargo(?:\.exe)?["']?(?:\s|$)/.test(s))
  // Raw but for heredocs: a script body that merely mentions PowerShell, vcvars and cargo runs none of them.
  if (vcvarsSeg || WRAPPED_VCVARS_RE.test(withoutDocs(command))) {
    return `moon-guard: run cargo directly in the PowerShell tool — the MSVC linker is already on its PATH; the vcvars wrapper hangs or only echoes the cmd banner (CLAUDE.md, Build).`
  }
  for (const seg of segs) {
    const m = seg.match(CARGO_RE)
    if (m && !TARGET_RE.test(seg)) {
      return `moon-guard: \`cargo ${m[1]}\` without \`--target ${TARGET}\` builds target\\debug, a different binary from the one the app runs (target\\${TARGET}\\debug) — add \`--target ${TARGET}\` (CLAUDE.md, Build). \`cargo check\` alone may stay bare.`
    }
  }
  return undefined
}

/**
 * How a git commit in the command takes its files, or undefined when it
 * commits nothing: `staged` reads the index as it is now; `all` also takes
 * the working tree's Cargo.lock — a commit -a, a commit naming the lock, or a
 * `git add` earlier in the same command that stages it before the commit runs
 * (the hook sees the command before any of it ran).
 */
export function commitKind(command: string): 'staged' | 'all' | undefined {
  let kind: 'staged' | 'all' | undefined
  let addsLock = false
  for (const seg of segments(command)) {
    if (GIT_ADD_RE.test(seg) && ADD_LOCK_RE.test(` ${seg.slice(seg.search(/\badd\b/) + 3)}`)) addsLock = true
    if (!GIT_COMMIT_RE.test(seg)) continue
    const rest = ` ${seg.slice(seg.search(/\bcommit\b/))}`
    kind = addsLock || COMMIT_ALL_RE.test(rest) || /\bCargo\.lock\b/.test(rest) ? 'all' : (kind ?? 'staged')
  }
  return kind
}

/**
 * Whether `.cargo/config.toml` carries a live `[patch]` path override: while
 * it does, every build rewrites Cargo.lock without the MoonUI git source pins.
 * Commented lines do not count; the file ships with the block commented out.
 */
export function hasPatchOverride(configText: string): boolean {
  let inPatch = false
  for (const raw of configText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('[')) {
      inPatch = /^\[patch[.\]]/.test(line)
      continue
    }
    if (inPatch && /\bpath\s*=/.test(line)) return true
  }
  return false
}

export const lockDenial = () =>
  `moon-guard: Cargo.lock is about to be committed while .cargo/config.toml carries a [patch] path override — that lock has lost the MoonUI git source pins CI builds from. Run \`git checkout -- Cargo.lock\` (or unstage it) first (CLAUDE.md, Dependency / fork workflow).`

/** Whether a `git diff --name-only` listing names the root Cargo.lock. */
export const listsLock = (names: string) => names.split(/\r?\n/).some(n => n.trim() === 'Cargo.lock')
