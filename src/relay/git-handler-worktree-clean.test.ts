import { describe, expect, it, vi } from 'vitest'
import { WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS } from '../shared/worktree-create-timeouts'
import { WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS } from '../shared/worktree-removal-timeouts'
import type { GitExec } from './git-handler-ops'
import { worktreeIsCleanOp } from './git-handler-worktree-ops'

describe('worktreeIsCleanOp', () => {
  it('reports clean SSH worktrees without returning porcelain output', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '\n', stderr: '' }))

    await expect(worktreeIsCleanOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({
      clean: true,
      stdout: undefined
    })

    expect(git).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      '/repo-feature',
      { timeout: WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS }
    )
  })

  it('forwards cancellation and bounds the status subprocess', async () => {
    const controller = new AbortController()
    const abortError = Object.assign(new Error('status aborted'), { name: 'AbortError' })
    const git = vi.fn<GitExec>(
      async (_args, _cwd, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(abortError), { once: true })
        })
    )

    const result = worktreeIsCleanOp(
      git,
      { worktreePath: '/repo-feature', includeUntracked: false },
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(git).toHaveBeenCalledOnce())

    expect(git).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=no'],
      '/repo-feature',
      {
        signal: controller.signal,
        timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
      }
    )
    controller.abort()
    await expect(result).rejects.toBe(abortError)
  })

  it('returns porcelain output for dirty SSH worktrees', async () => {
    const stdout = ' M src/file.ts\n?? scratch.txt\n'
    const git = vi.fn<GitExec>(async () => ({ stdout, stderr: '' }))

    await expect(worktreeIsCleanOp(git, { worktreePath: '/repo-feature' })).resolves.toEqual({
      clean: false,
      stdout
    })
  })
})
