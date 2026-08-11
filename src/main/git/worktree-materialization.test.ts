import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addWorktree, materializeWorktreeCheckout } from './worktree'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('worktree checkout materialization', () => {
  it('populates a worktree registered with --no-checkout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-worktree-materialization-'))
    tempRoots.push(root)
    const repoPath = path.join(root, 'repo')
    const worktreePath = path.join(root, 'feature')
    execFileSync('git', ['init', '--quiet', repoPath])
    git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(repoPath, ['config', 'user.email', 'test@example.com'])
    git(repoPath, ['config', 'user.name', 'Test User'])
    await writeFile(path.join(repoPath, 'tracked.txt'), 'ready\n')
    git(repoPath, ['add', 'tracked.txt'])
    git(repoPath, ['commit', '--quiet', '-m', 'initial'])

    await addWorktree(repoPath, worktreePath, 'feature', 'main', false, true)
    await expect(readFile(path.join(worktreePath, 'tracked.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })

    await materializeWorktreeCheckout(worktreePath, 'feature')

    await expect(readFile(path.join(worktreePath, 'tracked.txt'), 'utf8')).resolves.toBe('ready\n')
    expect(git(worktreePath, ['status', '--porcelain'])).toBe('')
  })
})
