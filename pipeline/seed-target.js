#!/usr/bin/env node
// Seeds a fresh worktree's cargo `target` from another checkout of the same repository, so its
// first build reuses the compiled third-party crates instead of rebuilding hundreds of them.
//   seed-target.js <source-checkout> <dest-checkout> [--profile <name>]... [--dry-run]
// Profiles default to `debug`; every `target/<profile>` (host artifacts: proc-macros, build
// scripts) and `target/<triple>/<profile>` the source has is copied. Exit 0 = seeded, 1 = refused
// or aborted (a build is running, the destination already has build output, different
// repositories, a copy error), 2 = a malformed call.
//
// Why it is safe — and why it is NOT a shared target dir. Cargo names a workspace member's
// artifacts by its path RELATIVE to the workspace root and decides freshness by comparing file
// mtimes, not contents. So `crates/core` has the same artifact name in every worktree, and a copied
// artifact would be trusted whenever the destination's sources look older than it — silently
// linking the source checkout's code (seen 2026-11-20 with one build dir shared by two
// worktrees). So:
//   - the workspace members' own artifacts are not copied at all;
//   - every file git knows in the destination is stamped with the current time BEFORE anything
//     is copied, so whatever lands afterwards (copies keep their original, older mtimes) is older
//     than the destination's sources, even if the copy is interrupted half-way;
//   - an interrupted or torn copy is deleted again, never left for cargo to trust.
// What stays reusable is exactly what is safe to reuse:
//   - third-party crates: keyed by their absolute source path under CARGO_HOME, the same for
//     every checkout, and by version, features and profile — a different Cargo.lock just rebuilds
//     what differs;
//   - the incremental cache of workspace members: rustc validates it by content hashes, so stale
//     entries are recomputed, never trusted — it turns a from-scratch rebuild into a partial one.
// Only the newest incremental session of each crate is copied, and absolute paths of the source
// `target` in build-script output are rewritten to the destination.
//
// Detecting a running build: on Windows a cargo build holds its lock files open exclusively, so
// they are probed before the copy (both trees). On every platform the source's `.fingerprint`
// entries are compared before and after the copy: one that moved means a build ran meanwhile, and
// the copy is deleted. What it cannot see: inputs outside git (ignored files a build script reads)
// keep their mtimes; old third-party versions the source no longer uses are copied too.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const COPIED_DIRS = [".fingerprint", "build", "deps"];
const LOCK_NAMES = [".cargo-lock", ".cargo-build-lock", ".cargo-artifact-lock"];
// libuv's exclusive-open flag (FILE_SHARE_NONE). Node does not export the constant, libuv honors it.
const UV_FS_O_EXLOCK = fs.constants.UV_FS_O_EXLOCK ?? 0x10000000;
const HASH16 = "????????????????";

/** Prints a message to stderr and exits with the given status. */
function fail(code, msg) {
  process.stderr.write(`seed-target: ${msg}\n`);
  process.exit(code);
}

/** Parses argv into { source, dest, profiles, dryRun }; exits 2 on a malformed call. */
function parseArgs(argv) {
  const pos = [];
  const profiles = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--profile") {
      if (!argv[i + 1]) fail(2, "--profile needs a name");
      profiles.push(argv[++i]);
    } else if (a.startsWith("--")) fail(2, `unknown flag ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) fail(2, "usage: seed-target.js <source-checkout> <dest-checkout> [--profile <name>]... [--dry-run]");
  return { source: path.resolve(pos[0]), dest: path.resolve(pos[1]), profiles: profiles.length ? profiles : ["debug"], dryRun };
}

/** The repository's common git dir for a checkout, resolved to an absolute path; null if not a repo. */
function commonGitDir(dir) {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.resolve(out).toLowerCase();
  } catch {
    return null;
  }
}

/** Profile directories of `targetDir` for the given profiles: host `<p>` and every `<triple>/<p>`. */
function profileDirs(targetDir, profiles) {
  const rels = [];
  if (!fs.existsSync(targetDir)) return rels;
  for (const p of profiles) {
    if (fs.existsSync(path.join(targetDir, p))) rels.push(p);
    for (const e of fs.readdirSync(targetDir, { withFileTypes: true })) {
      // A target triple directory holds per-profile subdirectories; a profile dir itself does not.
      if (e.isDirectory() && e.name.split("-").length >= 3 && fs.existsSync(path.join(targetDir, e.name, p))) rels.push(path.join(e.name, p));
    }
  }
  return rels;
}

/**
 * Lock files under the given profile dirs that another process holds open. A cargo build on
 * Windows keeps them open exclusively for the whole build, so an exclusive open failing means
 * "busy". Elsewhere this probe is not possible and returns an empty list (the fingerprint
 * comparison after the copy still applies).
 */
function heldLocks(dirs) {
  if (process.platform !== "win32") return [];
  const held = [];
  for (const d of dirs) {
    for (const n of LOCK_NAMES) {
      const f = path.join(d, n);
      if (!fs.existsSync(f)) continue;
      try {
        fs.closeSync(fs.openSync(f, fs.constants.O_RDWR | UV_FS_O_EXLOCK));
      } catch {
        held.push(f);
      }
    }
  }
  return held;
}

/** Snapshot `name -> mtimeMs` of the `.fingerprint` entries under the given profile dirs. */
function fingerprintSnapshot(dirs) {
  const snap = new Map();
  for (const d of dirs) {
    const fp = path.join(d, ".fingerprint");
    if (!fs.existsSync(fp)) continue;
    for (const name of fs.readdirSync(fp)) {
      try {
        snap.set(path.join(fp, name), fs.statSync(path.join(fp, name)).mtimeMs);
      } catch {
        snap.set(path.join(fp, name), -1);
      }
    }
  }
  return snap;
}

/** Entries that appeared, vanished or changed mtime between two fingerprint snapshots. */
function snapshotDiff(before, after) {
  const moved = [];
  for (const [k, v] of after) if (before.get(k) !== v) moved.push(k);
  for (const k of before.keys()) if (!after.has(k)) moved.push(k);
  return moved;
}

/** True when `dir` exists and has at least one entry. */
function nonEmpty(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * `cargo metadata --no-deps` of a checkout: needs no build and takes no build lock. Its
 * `target_directory` is the real one — a checkout may redirect it (`build.target-dir` in its own
 * `.cargo/config.toml`, CARGO_TARGET_DIR), so `<checkout>/target` is never assumed.
 */
function cargoMetadata(checkout) {
  try {
    return JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps", "--offline"], { cwd: checkout, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }));
  } catch (e) {
    fail(1, `cargo metadata failed in ${checkout}: ${e.message}`);
  }
}

/** Names (package names and normalized target names) of the workspace members in `meta`. */
function workspaceMemberNames(meta) {
  const pkgs = new Set();
  const crates = new Set();
  for (const p of meta.packages) {
    pkgs.add(p.name);
    crates.add(p.name.replace(/-/g, "_"));
    // A build script's target is called `build-script-build` in EVERY package, so its name must
    // not become a file pattern — it would drop every third-party build script too. Members'
    // build scripts already go with their package's `build/<pkg>-<hash>` dir.
    for (const t of p.targets) if (!t.kind.includes("custom-build")) crates.add(t.name.replace(/-/g, "_"));
  }
  return { pkgs: [...pkgs], crates: [...crates] };
}

/**
 * Copies a directory tree preserving mtimes (cargo's freshness check reads them), leaving out
 * the workspace members' artifacts. Returns the bytes copied (Windows only; 0 elsewhere). Throws
 * on failure so the caller can delete the partial copy.
 */
function copyTree(from, to, members) {
  fs.mkdirSync(to, { recursive: true });
  const crateFile = (n) => [`lib${n}-${HASH16}.*`, `${n}-${HASH16}.*`, `${n}-${HASH16}`];
  const pkgDir = (n) => `${n}-${HASH16}`;
  if (process.platform === "win32") {
    const args = [from, to, "/E", "/MT:16", "/R:0", "/W:0", "/NFL", "/NDL", "/NJH", "/NP", "/BYTES"];
    if (members) args.push("/XF", ...members.crates.flatMap(crateFile), "/XD", ...members.pkgs.map(pkgDir));
    const r = spawnSync("robocopy", args, { encoding: "utf8", maxBuffer: 1 << 26 });
    // robocopy: 0-7 are success variants, 8 and up mean at least one failure.
    if (r.status === null || r.status >= 8) throw new Error(`robocopy ${from} -> ${to} failed (exit ${r.status}): ${(r.stdout || "").slice(-400)}`);
    const m = /Bytes\s*:\s*(\d+)/.exec(r.stdout || "");
    return m ? Number(m[1]) : 0;
  }
  const hash = /-[0-9a-f]{16}(\.|$)/;
  const skip = new Set(members ? [...members.crates, ...members.pkgs] : []);
  fs.cpSync(from, to, {
    recursive: true,
    preserveTimestamps: true,
    filter: (src) => {
      const base = path.basename(src).replace(/^lib/, "");
      const m = hash.exec(base);
      return !(m && skip.has(base.slice(0, m.index)));
    },
  });
  return 0;
}

/** Copies only the newest finished session (and its lock file) of every crate in `incremental`. */
function copyIncremental(from, to) {
  let bytes = 0;
  let sessions = 0;
  if (!fs.existsSync(from)) return { bytes, sessions };
  for (const crate of fs.readdirSync(from, { withFileTypes: true })) {
    if (!crate.isDirectory()) continue;
    const cdir = path.join(from, crate.name);
    const newest = fs
      .readdirSync(cdir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("s-") && !e.name.endsWith("-working"))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(cdir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) continue;
    bytes += copyTree(path.join(cdir, newest.name), path.join(to, crate.name, newest.name), null);
    const lock = path.join(cdir, `${newest.name}.lock`);
    if (fs.existsSync(lock)) {
      const dst = path.join(to, crate.name, `${newest.name}.lock`);
      fs.copyFileSync(lock, dst);
      const st = fs.statSync(lock);
      fs.utimesSync(dst, st.atime, st.mtime);
    }
    sessions++;
  }
  return { bytes, sessions };
}

/**
 * The target-dir prefix the source's build scripts actually ran under, read from a `root-output`
 * (`<target>/<profile rel>/build/<unit>/out`). It can differ from the path the copy came from (a
 * junction, a redirected target dir), so it is taken from the files, not assumed. Null if none.
 */
function recordedTargetPrefix(buildDir, rel) {
  if (!fs.existsSync(buildDir)) return null;
  for (const e of fs.readdirSync(buildDir, { withFileTypes: true })) {
    const f = path.join(buildDir, e.name, "root-output");
    if (!e.isDirectory() || !fs.existsSync(f)) continue;
    const recorded = fs.readFileSync(f, "utf8").trim();
    const tail = path.join(rel, "build", e.name, "out").replace(/\\/g, "/").toLowerCase();
    const norm = recorded.replace(/\\/g, "/");
    if (norm.toLowerCase().endsWith(`/${tail}`)) return recorded.slice(0, norm.length - tail.length - 1);
  }
  return null;
}

/**
 * Rewrites absolute paths of the source target dir inside build-script `output` / `root-output`
 * files to the destination, keeping each file's mtime. Returns the number of files changed.
 */
function rewriteBuildOutputs(buildDir, srcTargets, dstTarget) {
  if (!fs.existsSync(buildDir)) return 0;
  const pairs = [];
  for (const src of new Set(srcTargets.filter(Boolean))) {
    pairs.push([src.replace(/\//g, "\\"), dstTarget.replace(/\//g, "\\")], [src.replace(/\\/g, "/"), dstTarget.replace(/\\/g, "/")]);
  }
  let changed = 0;
  for (const e of fs.readdirSync(buildDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    for (const name of ["output", "root-output"]) {
      const f = path.join(buildDir, e.name, name);
      if (!fs.existsSync(f)) continue;
      const before = fs.readFileSync(f, "utf8");
      let after = before;
      for (const [from, to] of pairs) {
        // Case-insensitive: Windows paths reach these files in whatever case cargo was given.
        // A function replacement, so a `$` in the destination path is taken literally.
        after = after.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), () => to);
      }
      if (after !== before) {
        const st = fs.statSync(f);
        fs.writeFileSync(f, after);
        fs.utimesSync(f, st.atime, st.mtime);
        changed++;
      }
    }
  }
  return changed;
}

/**
 * Stamps every tracked and untracked-not-ignored file of the checkout with now; skips links.
 * Returns the count; exits 1 if any file could not be stamped — an unstamped source file is
 * exactly the one a copied artifact could look newer than.
 */
function touchSources(checkout) {
  const out = execFileSync("git", ["-C", checkout, "ls-files", "-z", "-c", "-o", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const now = new Date();
  let n = 0;
  const failed = [];
  for (const rel of new Set(out.split("\0").filter(Boolean))) {
    const f = path.join(checkout, rel);
    let st;
    try {
      st = fs.lstatSync(f);
    } catch (e) {
      // Deleted in the working tree but still in the index: nothing to stamp.
      if (e.code === "ENOENT") continue;
      failed.push(`${rel} (${e.code})`);
      continue;
    }
    if (!st.isFile()) continue;
    try {
      fs.utimesSync(f, now, now);
      n++;
    } catch (e) {
      failed.push(`${rel} (${e.code})`);
    }
  }
  if (failed.length) fail(1, `could not stamp ${failed.length} file(s), nothing copied: ${failed.slice(0, 10).join(", ")}`);
  return n;
}

/** Deletes what this run copied into the destination's profile dirs. */
function removeCopies(dstTarget, rels) {
  for (const r of rels) {
    for (const d of [...COPIED_DIRS, "incremental"]) fs.rmSync(path.join(dstTarget, r, d), { recursive: true, force: true });
  }
}

function main() {
  const { source, dest, profiles, dryRun } = parseArgs(process.argv.slice(2));
  const gs = commonGitDir(source);
  const gd = commonGitDir(dest);
  if (!gs || !gd) fail(1, `not a git checkout: ${!gs ? source : dest}`);
  if (gs !== gd) fail(1, `different repositories (${gs} vs ${gd}); seeding only makes sense between worktrees of one repo`);
  if (source.toLowerCase() === dest.toLowerCase()) fail(1, "source and destination are the same checkout");

  const srcMeta = cargoMetadata(source);
  const dstMeta = cargoMetadata(dest);
  const srcTarget = path.resolve(srcMeta.target_directory);
  const dstTarget = path.resolve(dstMeta.target_directory);
  if (srcTarget.toLowerCase() === dstTarget.toLowerCase()) fail(1, `both checkouts build into ${srcTarget}; nothing to seed (and sharing it is unsafe)`);
  const rels = profileDirs(srcTarget, profiles);
  if (!rels.length) fail(1, `nothing to copy: no ${profiles.join("/")} profile under ${srcTarget}`);

  const built = rels.filter((r) => nonEmpty(path.join(dstTarget, r, "deps")));
  if (built.length) fail(1, `destination already has build output (${built.map((r) => path.join(dstTarget, r)).join(", ")}); seeding is for a fresh worktree`);

  const srcDirs = rels.map((r) => path.join(srcTarget, r));
  const dstDirs = rels.map((r) => path.join(dstTarget, r));
  const busy = heldLocks([...srcDirs, ...dstDirs]);
  if (busy.length) fail(1, `a cargo build is running (lock held): ${busy.join(", ")}`);

  const members = workspaceMemberNames(dstMeta);
  if (dryRun) {
    process.stdout.write(`would copy ${rels.length} profile dir(s): ${rels.join(", ")}\nfrom ${srcTarget}\nto   ${dstTarget}\nleaving out ${members.pkgs.length} workspace member(s): ${members.pkgs.join(", ")}\n`);
    return;
  }

  const t0 = Date.now();
  // Stamp first: everything copied below keeps an older mtime than these sources.
  const touched = touchSources(dest);
  const before = fingerprintSnapshot(srcDirs);
  let bytes = 0;
  let sessions = 0;
  let rewritten = 0;
  try {
    for (const r of rels) {
      for (const d of COPIED_DIRS) {
        const from = path.join(srcTarget, r, d);
        if (fs.existsSync(from)) bytes += copyTree(from, path.join(dstTarget, r, d), members);
      }
      const inc = copyIncremental(path.join(srcTarget, r, "incremental"), path.join(dstTarget, r, "incremental"));
      bytes += inc.bytes;
      sessions += inc.sessions;
      const recorded = recordedTargetPrefix(path.join(srcTarget, r, "build"), r);
      rewritten += rewriteBuildOutputs(path.join(dstTarget, r, "build"), [srcTarget, recorded], dstTarget);
    }
  } catch (e) {
    removeCopies(dstTarget, rels);
    fail(1, `copy failed, partial copy removed: ${e.message}`);
  }

  const moved = snapshotDiff(before, fingerprintSnapshot(srcDirs));
  const busyAfter = heldLocks([...srcDirs, ...dstDirs]);
  if (moved.length || busyAfter.length) {
    removeCopies(dstTarget, rels);
    fail(1, `a build ran during the copy (${[...busyAfter, ...moved.slice(0, 5)].join(", ")}); the copy was removed — seed again when no build is running`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const size = process.platform === "win32" ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "size n/a";
  process.stdout.write(
    `seeded ${dstTarget} from ${srcTarget}: ${rels.join(", ")} · ${size} · ${sessions} incremental session(s) · ` +
      `${rewritten} build-script output(s) repointed · ${touched} source file(s) stamped · ${members.pkgs.length} workspace member(s) left out · ${secs} s\n` +
      "next build rebuilds every workspace member from this checkout's sources and reuses matching third-party crates\n",
  );
}

main();
