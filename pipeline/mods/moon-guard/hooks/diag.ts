/**
 * diag.ts — reading `logs/render_diag.log` (crates/moon-core/src/diagnostics):
 * one `[diag <ms>ms] key=value ...` line per second while `channels.render`
 * is on in cfg/diagnostics.toml.
 */

export type DiagLine = { windowMs: number; pairs: [string, string][] }

/**
 * The log the app writes beside its exe: a bare word is a cargo profile
 * (debug, inspector, release, ...), anything with a separator is a path.
 */
export function diagLogPath(root: string, arg: string): string {
  const a = arg.trim() || 'debug'
  if (/^[\w-]+$/.test(a)) return `${root}/target/x86_64-pc-windows-msvc/${a}/logs/render_diag.log`
  return a
}

export function parseDiag(line: string): DiagLine | undefined {
  const m = line.trim().match(/^\[diag (\d+)ms\]\s*(.*)$/)
  if (!m) return undefined
  const pairs: [string, string][] = []
  for (const tok of (m[2] ?? '').split(/\s+/)) {
    const eq = tok.indexOf('=')
    if (eq > 0) pairs.push([tok.slice(0, eq), tok.slice(eq + 1)])
  }
  return { windowMs: Number(m[1]), pairs }
}

/** A counter at zero is drawn dim: the eye goes to what moved. */
export const isZero = (value: string) => /^0+(\.0+)?$/.test(value)

/**
 * The node one-liner that prints the last non-empty line of a file, reading
 * only its tail: the log grows by a line a second and reaches megabytes.
 */
export const TAIL_JS = [
  "const fs=require('fs');const p=process.argv[1];",
  "const fd=fs.openSync(p,'r');const size=fs.fstatSync(fd).size;const n=Math.min(size,8192);",
  "const b=Buffer.alloc(n);fs.readSync(fd,b,0,n,size-n);fs.closeSync(fd);",
  // A last line with no newline yet is still being written: drop it.
  "const t=b.toString('utf8');const lines=t.split(/\\r?\\n/);if(!/\\n$/.test(t))lines.pop();",
  'const whole=lines.filter(l=>l.trim());',
  "process.stdout.write(whole.length?whole[whole.length-1]:'');",
].join('')

/** Seconds without a new line after which the counters are presumed off. */
export const STALE_MS = 3_000
