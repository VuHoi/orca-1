import { describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import {
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_TIMEOUT_MS
} from '../shared/worktree-create-timeouts'
import { WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS } from '../shared/worktree-removal-timeouts'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { refreshLocalBaseRefForWorktreeCreateOp } from './git-handler-local-base-ref-refresh'
import type { GitExec } from './git-handler-ops'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

function createHandlerWithGit(git: GitExec): MockDispatcher {
  const dispatcher = createMockDispatcher()
  const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  ;(handler as unknown as { git: GitExec }).git = git
  return dispatcher
}

function createAbortableGit(error: Error): ReturnType<typeof vi.fn<GitExec>> {
  return vi.fn<GitExec>(
    async (_args, _cwd, options) =>
      new Promise((_resolve, reject) => {
        const abort = (): void => reject(error)
        if (options?.signal?.aborted) {
          abort()
          return
        }
        options?.signal?.addEventListener('abort', abort, { once: true })
      })
  )
}

describe('relay worktree advisory cancellation', () => {
  it('forwards request cancellation to bounded worktree creation', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))
    const dispatcher = createHandlerWithGit(git)

    await dispatcher.callRequest(
      'git.addWorktree',
      {
        repoPath: '/repo',
        branchName: 'feature/test',
        targetDir: '/repo-feature',
        checkoutExistingBranch: true
      },
      { isStale: () => false, signal: controller.signal }
    )

    expect(git).toHaveBeenCalledWith(
      ['worktree', 'add', '/repo-feature', 'feature/test'],
      '/repo',
      { signal: controller.signal, timeout: WORKTREE_ADD_TIMEOUT_MS }
    )
  })

  it('dispatches bounded sparse materialization with request cancellation', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))
    const dispatcher = createHandlerWithGit(git)

    await dispatcher.callRequest(
      'git.materializeWorktreeCheckout',
      {
        worktreePath: '/repo-feature',
        branchName: 'feature/test',
        sparseDirectories: ['apps/web']
      },
      { isStale: () => false, signal: controller.signal }
    )

    const options = {
      signal: controller.signal,
      timeout: WORKTREE_MATERIALIZATION_TIMEOUT_MS
    }
    expect(git.mock.calls).toEqual([
      [['sparse-checkout', 'init', '--cone'], '/repo-feature', options],
      [['sparse-checkout', 'set', '--', 'apps/web'], '/repo-feature', options],
      [['checkout', '--force', 'feature/test'], '/repo-feature', options]
    ])
  })

  it('aborts the worktree clean subprocess through its request context', async () => {
    const controller = new AbortController()
    const abortError = Object.assign(new Error('status aborted'), { name: 'AbortError' })
    const git = createAbortableGit(abortError)
    const dispatcher = createHandlerWithGit(git)

    const request = dispatcher.callRequest(
      'git.worktreeIsClean',
      { worktreePath: '/repo-feature', includeUntracked: false },
      { isStale: () => false, signal: controller.signal }
    )
    const rejection = expect(request).rejects.toBe(abortError)
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
    await rejection
  })

  it('retains the removal-preflight bound for full clean checks', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))
    const dispatcher = createHandlerWithGit(git)

    await expect(
      dispatcher.callRequest('git.worktreeIsClean', { worktreePath: '/repo-feature' })
    ).resolves.toEqual({ clean: true, stdout: undefined })
    expect(git).toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      '/repo-feature',
      { timeout: WORKTREE_REMOVAL_PREFLIGHT_TIMEOUT_MS }
    )
  })

  it('aborts the local-base probe through its request context', async () => {
    const controller = new AbortController()
    const abortError = Object.assign(new Error('refresh aborted'), { name: 'AbortError' })
    const git = createAbortableGit(abortError)
    const dispatcher = createHandlerWithGit(git)

    const request = dispatcher.callRequest(
      'git.refreshLocalBaseRefForWorktreeCreate',
      {
        repoPath: '/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main',
        checkOnly: true
      },
      { isStale: () => false, signal: controller.signal }
    )
    const rejection = expect(request).rejects.toBe(abortError)
    await vi.waitFor(() => expect(git).toHaveBeenCalledOnce())

    expect(git).toHaveBeenCalledWith(['check-ref-format', 'refs/heads/main'], '/repo', {
      signal: controller.signal,
      timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
    })
    controller.abort()
    await rejection
  })

  it('bounds every check-only local-base subprocess and forwards one signal', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return {
          stdout: args[2]?.startsWith('refs/remotes/') ? 'remote-oid\n' : 'local-oid\n',
          stderr: ''
        }
      }
      if (args[0] === 'worktree') {
        return {
          stdout: 'worktree /repo\nHEAD local-oid\nbranch refs/heads/main\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await refreshLocalBaseRefForWorktreeCreateOp(
      git,
      {
        repoPath: '/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main',
        ownerWorktreePath: '/repo',
        checkOnly: true
      },
      new GitCapabilityCache(),
      { signal: controller.signal }
    )

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['check-ref-format', 'refs/heads/main'],
      ['check-ref-format', 'refs/remotes/origin/main'],
      ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
      ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
      ['merge-base', '--is-ancestor', 'local-oid', 'remote-oid'],
      ['worktree', 'list', '--porcelain', '-z'],
      ['status', '--porcelain', '--untracked-files=no']
    ])
    expect(git.mock.calls.map((call) => call[2])).toEqual(
      Array.from({ length: 7 }, () => ({
        signal: controller.signal,
        timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
      }))
    )
  })

  it('bounds the non-owner ref update', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return {
          stdout: args[2]?.startsWith('refs/remotes/') ? 'remote-oid\n' : 'local-oid\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await refreshLocalBaseRefForWorktreeCreateOp(
      git,
      {
        repoPath: '/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main'
      },
      new GitCapabilityCache(),
      { signal: controller.signal }
    )

    expect(git).toHaveBeenLastCalledWith(
      ['update-ref', 'refs/heads/main', 'remote-oid', 'local-oid'],
      '/repo',
      {
        signal: controller.signal,
        timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
      }
    )
  })

  it('reserves the long worktree timeout for an owner reset', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return {
          stdout: args[2]?.startsWith('refs/remotes/') ? 'remote-oid\n' : 'local-oid\n',
          stderr: ''
        }
      }
      if (args[0] === 'worktree') {
        return {
          stdout: 'worktree /repo\nHEAD local-oid\nbranch refs/heads/main\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await refreshLocalBaseRefForWorktreeCreateOp(
      git,
      {
        repoPath: '/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main',
        ownerWorktreePath: '/repo'
      },
      new GitCapabilityCache(),
      { signal: controller.signal }
    )

    expect(git.mock.calls.slice(0, -1).map((call) => call[2]?.timeout)).toEqual(
      Array.from({ length: 7 }, () => WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS)
    )
    expect(git).toHaveBeenLastCalledWith(['reset', '--hard', 'remote-oid'], '/repo', {
      signal: controller.signal,
      timeout: WORKTREE_MATERIALIZATION_TIMEOUT_MS
    })
  })
})
