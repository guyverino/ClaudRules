import { describe, expect, test } from 'claude-code/testing'

import { cargoDenial, commitKind, hasPatchOverride, listsLock } from '../hooks/cargo'

const T = '--target x86_64-pc-windows-msvc'

describe('cargo', () => {
  test('a build or test without the MSVC target is refused', async () => {
    expect(cargoDenial('cargo build -p moon-ui-gpui --bin moonterminal')).toContain('--target x86_64-pc-windows-msvc')
    expect(cargoDenial('cargo test --workspace')).toBeDefined()
    expect(cargoDenial('cargo clippy -p moon-core -- -D warnings')).toBeDefined()
    expect(cargoDenial('& "C:\\Users\\Guyver\\.cargo\\bin\\cargo.exe" build -p moon-core')).toBeDefined()
    expect(cargoDenial('cargo +nightly test -p moon-core')).toBeDefined()
    // one segment of a chain without it is enough
    expect(cargoDenial(`cargo build ${T}; cargo test -p moon-core`)).toBeDefined()
  })

  test('the documented commands pass', async () => {
    expect(cargoDenial(`cargo build -p moon-ui-gpui --bin moonterminal ${T}`)).toBeUndefined()
    expect(cargoDenial(`node "{{CLAUDE_HOME}}/pipeline/tested-tree.js" run -- cargo test --workspace ${T}`)).toBeUndefined()
    expect(cargoDenial(`cargo test -p moon-ui-gpui ${T} --profile inspector --features ui-inspector`)).toBeUndefined()
    expect(cargoDenial('cargo zigbuild -p moon-station --target x86_64-unknown-linux-musl')).toBeUndefined()
    expect(cargoDenial('cargo check -p moon-core')).toBeUndefined()
    expect(cargoDenial('cargo fmt --all -- --check')).toBeUndefined()
    expect(cargoDenial('cargo update -p moonproto')).toBeUndefined()
  })

  test('cargo named inside data is not a command', async () => {
    expect(cargoDenial('git commit -m "fix: cargo build was slow"')).toBeUndefined()
    expect(cargoDenial("echo 'run cargo test later'")).toBeUndefined()
    expect(cargoDenial("cat > notes.md <<'EOF'\ncargo build -p x\nEOF")).toBeUndefined()
    expect(cargoDenial("git commit -F - <<'EOF'\nfix(ui): cargo test now green\nEOF")).toBeUndefined()
    expect(cargoDenial("$m = @'\ncargo build\n'@")).toBeUndefined()
    expect(cargoDenial('grep -rn "cargo build" docs')).toBeUndefined()
  })

  test('the vcvars wrapper around cargo is refused', async () => {
    const cmd = `cmd.exe /c "C:\\VS\\vcvars64.bat && cargo build ${T}"`
    expect(cargoDenial(cmd)).toContain('vcvars')
    expect(cargoDenial(`call vcvars64.bat && cargo build ${T}`)).toContain('vcvars')
    expect(cargoDenial(`cmd.exe /c '"C:\\Program Files\\VS\\VC\\Auxiliary\\Build\\vcvars64.bat" && cargo build ${T}'`)).toContain('vcvars')
    expect(cargoDenial('dir vcvars64.bat')).toBeUndefined()
    expect(cargoDenial('cd D:/x && git commit -m "docs: drop the vcvars cargo wrapper"')).toBeUndefined()
    expect(cargoDenial(`cmd /c "\\"C:\\Program Files\\VS\\vcvars64.bat\\" && cargo build ${T}"`)).toContain('vcvars')
    expect(cargoDenial('git commit -m "fix: cargo build now writes moonterminal.exe"')).toBeUndefined()
  })

  test('--target-dir is not --target', async () => {
    expect(cargoDenial('cargo build -p moon-core --target-dir D:/t')).toBeDefined()
    expect(cargoDenial(`cargo build -p moon-core --target-dir D:/t ${T}`)).toBeUndefined()
    expect(cargoDenial('cargo build -p moon-core --target=x86_64-pc-windows-msvc')).toBeUndefined()
  })

  test('a continued line is one command', async () => {
    expect(cargoDenial(`cargo build -p moon-ui-gpui --bin moonterminal --target x86_64-pc-windows-msvc \`\n    --profile inspector --features ui-inspector`)).toBeUndefined()
    expect(cargoDenial(`cargo build -p moon-ui-gpui \`\n    --profile inspector ${T}`)).toBeUndefined()
    expect(cargoDenial('cargo build -p moon-core \\\n  --release')).toBeDefined()
  })

  test('a command handed to an inner shell is read', async () => {
    expect(cargoDenial('cmd /c "cargo test -p moon-core"')).toBeDefined()
    expect(cargoDenial('powershell -NoProfile -Command "cargo build -p moon-core"')).toBeDefined()
    expect(cargoDenial("bash -c 'cargo run -p moon-core'")).toBeDefined()
    expect(cargoDenial(`cmd /c "cargo test -p moon-core ${T}"`)).toBeUndefined()
  })

  test('commit kinds', async () => {
    expect(commitKind('git add Cargo.lock && git commit -m "x"')).toBe('all')
    expect(commitKind('git add -A; git commit -m "x"')).toBe('all')
    expect(commitKind('git add . && git commit -m "x"')).toBe('all')
    expect(commitKind('git add src/a.rs && git commit -m "x"')).toBe('staged')
    expect(commitKind('git commit Cargo.lock -m "x"')).toBe('all')
    expect(commitKind('git commit -m "x"')).toBe('staged')
    expect(commitKind('git add a.rs && git commit -am "x"')).toBe('all')
    expect(commitKind('git commit --all -m "x"')).toBe('all')
    expect(commitKind('git commit --amend --no-edit')).toBe('staged')
    expect(commitKind('git -C D:/x commit -m "y"')).toBe('staged')
    expect(commitKind('git -C "D:\\projects\\moon terminal" commit -m "y"')).toBe('staged')
    expect(commitKind('git -C "D:\\projects\\moon-terminal" commit -am "y"')).toBe('all')
    expect(commitKind('git status')).toBeUndefined()
    expect(commitKind('echo "git commit -a now"')).toBeUndefined()
  })

  test('a [patch] override counts only when live', async () => {
    const commented = '# [patch."https://github.com/Moonbot-Tech/MoonUI"]\n# moon-ui = { path = "D:/projects/MoonUI/crates/moon-ui" }\n[profile.inspector]\ninherits = "dev"\n'
    const live = '[patch."https://github.com/Moonbot-Tech/MoonUI"]\nmoon-ui = { path = "D:/projects/MoonUI/crates/moon-ui" }\n'
    const git = '[patch.crates-io]\nfoo = { git = "https://x/y" }\n'
    expect(hasPatchOverride(commented)).toBe(false)
    expect(hasPatchOverride(live)).toBe(true)
    expect(hasPatchOverride(git)).toBe(false)
    expect(hasPatchOverride('[profile.dev]\ndebug = 1\n[patch.crates-io]\nbar = { path = "../bar" }\n')).toBe(true)
  })

  test('the lock is named only at the root', async () => {
    expect(listsLock('src/a.rs\r\nCargo.lock\r\n')).toBe(true)
    expect(listsLock('crates/x/Cargo.lock\n')).toBe(false)
    expect(listsLock('')).toBe(false)
  })
})
