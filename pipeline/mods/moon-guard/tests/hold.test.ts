import { describe, expect, test } from 'claude-code/testing'

import { cleanFlags, gitDir, heldCommand, prNumber, prSummary, updateLines, updatePackages } from '../hooks/hold'

const kind = (command: string) => heldCommand(command)?.kind

describe('hold', () => {
  test('what leaves the machine or cannot be taken back is held', async () => {
    expect(kind('git push -u origin feat/x-report')).toBe('push')
    expect(kind('git add -A && git commit -m "x" && git push')).toBe('push')
    expect(kind('gh pr merge 42 --squash --delete-branch')).toBe('merge')
    expect(kind('git push origin v0.24.1')).toBe('release')
    expect(kind('git push --tags')).toBe('release')
    expect(kind('gh release create v0.24.1 --draft')).toBe('release')
    expect(kind('git reset --hard origin/main')).toBe('discard')
    expect(kind('git checkout -- Cargo.lock')).toBe('discard')
    expect(kind('git checkout .')).toBe('discard')
    expect(kind('git restore crates/moon-core/src/x.rs')).toBe('discard')
    expect(kind('git restore --staged --worktree x.rs')).toBe('discard')
    expect(kind('git stash drop')).toBe('discard')
    expect(kind('git branch -D feat/old')).toBe('discard')
    expect(kind('git clean -fd')).toBe('clean')
    expect(kind('cargo update -p moonproto')).toBe('update')
    expect(kind('make update-all')).toBe('update')
    // global options before the subcommand do not hide it
    expect(kind('git --no-pager push origin feat/x')).toBe('push')
    expect(kind('git -c credential.helper= push')).toBe('push')
    expect(kind('git --git-dir=D:/r/.git --work-tree=D:/r reset --hard')).toBe('discard')
    expect(kind('git --git-dir D:/r/.git clean -fd')).toBe('clean')
  })

  test('what changes nothing, or only the local view, runs unheld', async () => {
    expect(kind('git push --dry-run origin feat/x')).toBeUndefined()
    expect(kind('git push -n')).toBeUndefined()
    expect(kind('git clean -n -d')).toBeUndefined()
    expect(kind('git clean -fdn')).toBeUndefined()
    // without -f git refuses to clean at all
    expect(kind('git clean -d')).toBeUndefined()
    expect(kind('cargo update --dry-run')).toBeUndefined()
    expect(kind('git restore --staged x.rs')).toBeUndefined()
    expect(kind('git reset --soft HEAD~1')).toBeUndefined()
    expect(kind('git checkout -b feat/new')).toBeUndefined()
    expect(kind('git branch -d merged-branch')).toBeUndefined()
    expect(kind('gh pr view 42')).toBeUndefined()
    expect(kind('git status && git log --oneline -5')).toBeUndefined()
    // a folder named like a subcommand is not one
    expect(kind('git -C push-tools status')).toBeUndefined()
    expect(kind('git -C clean-repo log -1')).toBeUndefined()
  })

  test('a command named inside data holds nothing', async () => {
    expect(kind('git commit -m "docs: never git push --force to main"')).toBeUndefined()
    expect(kind("cat > notes.md <<'EOF'\ngit reset --hard\nEOF")).toBeUndefined()
    expect(kind('echo "run cargo update later"')).toBeUndefined()
  })

  test('a push says what the person must not miss', async () => {
    const w = (command: string) => heldCommand(command)?.warnings ?? []
    expect(w('git push --force-with-lease origin feat/x')).toEqual(['FORCE push: rewrites history on the remote'])
    expect(w('git push origin +feat/x')).toEqual(['FORCE push: rewrites history on the remote'])
    expect(w('git push origin HEAD:main')).toEqual(['targets main: the ruleset rejects a direct push there, a PR is the way'])
    expect(w('git push origin --delete feat/old')).toEqual(['deletes a remote ref'])
    expect(w('git push -u origin feat/x')).toEqual([])
    // a branch shaped like a version is a branch; the release tag is vX.Y.Z
    expect(heldCommand('git push origin v2.0-fix')?.kind).toBe('push')
    expect(heldCommand('git push origin HEAD:refs/tags/v0.24.1')?.kind).toBe('release')
    // `push` inside a path is not the subcommand
    expect(w('git -C D:/push-main push origin feat/x')).toEqual([])
    expect(w('cargo update')).toContain('moves EVERY dependency in Cargo.lock, the pinned forks included')
    expect(w('cargo update -p moonproto')).toEqual(['moonproto moves only together with the cores (CLAUDE.md)'])
  })

  test('git -C names the repository the preview reads', async () => {
    expect(gitDir('git -C D:/work/rules push')).toBe('D:/work/rules')
    expect(gitDir('git -C "D:\\projects\\moon terminal" push')).toBe('D:\\projects\\moon terminal')
    expect(gitDir('git push')).toBeUndefined()
    expect(gitDir('git --no-pager -C D:/r push')).toBe('D:/r')
    expect(gitDir('git -c core.pager= -C D:/r push')).toBe('D:/r')
    expect(gitDir('git --work-tree=D:/w --git-dir=D:/w/.git reset --hard')).toBe('D:/w')
    expect(gitDir('git --git-dir D:/g/.git clean -fd')).toBe('D:/g')
    expect(heldCommand('git -C "D:\\a b" push')?.dir).toBe('D:\\a b')
  })

  test('the dry runs get the arguments that decide what they show', async () => {
    expect(updatePackages('cargo update -p moonproto --package=moon-gpui')).toEqual(['-p', 'moonproto', '-p', 'moon-gpui'])
    expect(updatePackages('cargo update')).toEqual([])
    expect(cleanFlags('git clean -fdx')).toEqual(['-d', '-x'])
    expect(cleanFlags('git clean -f')).toEqual([])
    expect(prNumber('gh pr merge 42 --squash')).toBe('42')
    expect(prNumber('gh pr merge --squash')).toBeUndefined()
  })

  test('a PR summary names the red and the pending checks', async () => {
    const json = JSON.stringify({
      number: 42,
      title: 'feat(x): a report',
      state: 'OPEN',
      baseRefName: 'main',
      headRefName: 'feat/x-report',
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [
        { name: 'Fmt', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Clippy (x86_64-msvc)', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'Tests (x86_64-msvc)', status: 'IN_PROGRESS', conclusion: '' },
        { context: 'owner-review', state: 'SUCCESS' },
      ],
    })
    const s = prSummary(json)
    expect(s.lines[1]).toBe('feat/x-report → main · checks: 2 passed, 1 failed, 1 pending')
    expect(s.lines[2]).toBe('pending: Tests (x86_64-msvc)')
    expect(s.warnings).toEqual(['red: Clippy (x86_64-msvc)', 'merge state BLOCKED'])
    expect(prSummary('not json').lines).toEqual(['gh pr view returned no JSON'])
  })

  test('only the lines of a lock dry run that move something', async () => {
    const stderr = '    Updating git repository `https://github.com/example/ui`\n     Locking 2 packages to latest compatible versions\n    Updating ui-core v0.1.0 (…#aaaa1111) -> #bbbb2222\nwarning: aborting update due to dry run\n'
    expect(updateLines(stderr)).toEqual(['Locking 2 packages to latest compatible versions', 'Updating ui-core v0.1.0 (…#aaaa1111) -> #bbbb2222'])
  })
})
