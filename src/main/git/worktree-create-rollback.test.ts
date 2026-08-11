import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletionMock,
  translateWslOutputPathsMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  moveWorktreeDirectoryToTrashMock: vi.fn(),
  restoreWorktreeDirectoryFromTrashMock: vi.fn(),
  scheduleWorktreeTrashDeletionMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output)
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock,
  restoreWorktreeDirectoryFromTrash: restoreWorktreeDirectoryFromTrashMock,
  scheduleWorktreeTrashDeletion: scheduleWorktreeTrashDeletionMock
}))

import { WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS } from '../../shared/worktree-create-timeouts'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { _resetWorktreeScanCacheForTests, rollbackFailedWorktreeCreate } from './worktree'

beforeEach(() => {
  clearGitCapabilityStateForTests()
  _resetWorktreeScanCacheForTests()
  gitExecFileAsyncMock.mockReset()
  gitExecFileSyncMock.mockReset()
  moveWorktreeDirectoryToTrashMock.mockReset()
  moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined)
  restoreWorktreeDirectoryFromTrashMock.mockReset()
  restoreWorktreeDirectoryFromTrashMock.mockResolvedValue(true)
  scheduleWorktreeTrashDeletionMock.mockReset()
  translateWslOutputPathsMock.mockReset()
  translateWslOutputPathsMock.mockImplementation((output: string) => output)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('rollbackFailedWorktreeCreate', () => {
  it('uses a fresh finite cleanup deadline after a local checkout failure', async () => {
    const checkoutAbort = new AbortController()
    checkoutAbort.abort()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    moveWorktreeDirectoryToTrashMock.mockRejectedValueOnce(
      new Error('failed-create rollback must not enter filesystem trash cleanup')
    )
    const checkoutError = new Error('checkout failed')

    const result = await rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      checkoutError,
      { signal: checkoutAbort.signal }
    )

    expect(result).toBe(checkoutError)
    expect(result.cleanupFailed).toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['config', '--local', '--unset-all', 'branch.feature/test.base'],
      ['worktree', 'remove', '--force', '/repo-feature'],
      ['branch', '-D', '--', 'feature/test']
    ])
    const cleanupSignals = gitExecFileAsyncMock.mock.calls.map(([, options]) => options.signal)
    expect(new Set(cleanupSignals).size).toBe(1)
    expect(cleanupSignals[0]).toBeInstanceOf(AbortSignal)
    expect(cleanupSignals[0]?.aborted).toBe(false)
    expect(gitExecFileAsyncMock.mock.calls.map(([, options]) => options.timeout)).toEqual([
      WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS,
      WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS,
      WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS
    ])
    expect(moveWorktreeDirectoryToTrashMock).not.toHaveBeenCalled()
    expect(restoreWorktreeDirectoryFromTrashMock).not.toHaveBeenCalled()
    expect(scheduleWorktreeTrashDeletionMock).not.toHaveBeenCalled()
  })

  it('bounds direct WSL rollback when deferred directory deletion is disabled', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Promise.resolve({
          stdout:
            'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
            'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n',
          stderr: ''
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      new Error('checkout failed'),
      { wslDistro: 'Ubuntu' }
    )

    expect(result.cleanupFailed).toBeUndefined()
    expect(moveWorktreeDirectoryToTrashMock).not.toHaveBeenCalled()
    const directRemove = gitExecFileAsyncMock.mock.calls.find(
      ([args]) => args[0] === 'worktree' && args[1] === 'remove'
    )
    expect(directRemove).toEqual([
      ['worktree', 'remove', '--force', '/repo-feature'],
      {
        cwd: '/repo',
        signal: expect.any(AbortSignal),
        timeout: WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS,
        wslDistro: 'Ubuntu'
      }
    ])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-D', '--', 'feature/test'],
      expect.objectContaining({
        signal: directRemove?.[1].signal,
        timeout: WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS,
        wslDistro: 'Ubuntu'
      })
    )
  })

  it('aborts and reports a stalled rollback cleanup deterministically', async () => {
    vi.useFakeTimers()
    let removeSignal: AbortSignal | undefined
    let markRemoveStarted!: () => void
    const removeStarted = new Promise<void>((resolve) => {
      markRemoveStarted = resolve
    })
    gitExecFileAsyncMock.mockImplementation((args: string[], options: { signal?: AbortSignal }) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removeSignal = options.signal
        markRemoveStarted()
        return new Promise((_resolve, reject) => {
          const rejectAbort = (): void => reject(new Error('cleanup aborted'))
          if (removeSignal?.aborted) {
            rejectAbort()
          } else {
            removeSignal?.addEventListener('abort', rejectAbort, { once: true })
          }
        })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const checkoutError = new Error('checkout failed')

    const rollback = rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      checkoutError
    )
    await removeStarted
    expect(removeSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_ROLLBACK_TIMEOUT_MS)
    const result = await rollback
    expect(result).toBe(checkoutError)
    expect(removeSignal?.aborted).toBe(true)
    expect(result.cleanupFailed).toBe(true)
    expect(result.message).toContain('cleanup also failed')
  })

  it('reports cleanup failure when the fresh branch cannot be deleted', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        return Promise.reject(new Error('branch lock held'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const checkoutError = new Error('checkout failed')

    const result = await rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      checkoutError
    )

    expect(result).toBe(checkoutError)
    expect(result.cleanupFailed).toBe(true)
    expect(result.message).toContain('cleanup also failed')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-D', '--', 'feature/test'],
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reports cleanup failure when a stale worktree still owns the fresh branch', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch' && args[1] === '-D') {
        return Promise.reject(
          new Error("cannot delete branch 'feature/test' used by worktree at '/stale'")
        )
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      new Error('checkout failed')
    )

    expect(result.cleanupFailed).toBe(true)
    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'branch' && args[1] === '-D')
    ).toHaveLength(2)
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'worktree',
      'prune'
    ])
  })

  it('continues removal but reports a branch-base config cleanup failure', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'config' && args[2] === '--unset-all') {
        return Promise.reject(Object.assign(new Error('config lock held'), { code: 4 }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const checkoutError = new Error('checkout failed')

    const result = await rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      checkoutError
    )

    expect(result.cleanupFailed).toBe(true)
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'worktree',
      'remove',
      '--force',
      '/repo-feature'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'branch',
      '-D',
      '--',
      'feature/test'
    ])
  })

  it('treats an absent branch-base config as already cleaned', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'config' && args[2] === '--unset-all') {
        return Promise.reject(Object.assign(new Error('key absent'), { code: 5 }))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const result = await rollbackFailedWorktreeCreate(
      '/repo',
      '/repo-feature',
      'feature/test',
      new Error('checkout failed')
    )

    expect(result.cleanupFailed).toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'worktree',
      'remove',
      '--force',
      '/repo-feature'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'branch',
      '-D',
      '--',
      'feature/test'
    ])
  })
})
