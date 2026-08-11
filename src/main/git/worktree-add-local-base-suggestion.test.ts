// addWorktree: advisory local-base-ref update suggestions when the refresh setting is off.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS } from '../../shared/worktree-create-timeouts'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Default: the checkout cannot be renamed aside, so removal deletes it in place.
vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { addWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('addWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('suggests updating the local base ref when setting is off and the branch is safely behind', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      behind: 2
    })
    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
      expect.objectContaining({
        cwd: '/repo',
        signal: expect.any(AbortSignal),
        timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
      })
    ])
  })

  it('starts the advisory base probe before checkout settles', async () => {
    let resolveAdvisory!: (value: { stdout: string }) => void
    let resolveCheckout!: (value: { stdout: string }) => void
    const advisory = new Promise<{ stdout: string }>((resolve) => {
      resolveAdvisory = resolve
    })
    const checkout = new Promise<{ stdout: string }>((resolve) => {
      resolveCheckout = resolve
    })
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-list') {
        return advisory
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return checkout
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123\n' })
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return Promise.resolve({ stdout: 'true\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const creation = addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    await vi.waitFor(() => {
      const calls = gitExecFileAsyncMock.mock.calls.map(([args]) => args)
      expect(calls.some((args) => args[0] === 'rev-list')).toBe(true)
      expect(calls.some((args) => args[0] === 'worktree' && args[1] === 'add')).toBe(true)
    })

    resolveCheckout({ stdout: '' })
    resolveAdvisory({ stdout: '0\t0\n' })
    await expect(creation).resolves.toEqual({})
  })

  it('aborts and drains the advisory base probe when checkout fails', async () => {
    const checkoutError = new Error('checkout failed')
    let advisorySignal: AbortSignal | undefined
    let advisorySettled = false
    let rejectAdvisory!: () => void
    gitExecFileAsyncMock.mockImplementation(
      (args: string[], options?: { signal?: AbortSignal }) => {
        if (args[0] === 'rev-list') {
          advisorySignal = options?.signal
          return new Promise<{ stdout: string }>((_resolve, reject) => {
            rejectAdvisory = () =>
              reject(Object.assign(new Error('advisory aborted'), { name: 'AbortError' }))
          }).finally(() => {
            advisorySettled = true
          })
        }
        if (args[0] === 'worktree' && args[1] === 'add') {
          return Promise.reject(checkoutError)
        }
        if (args[0] === 'rev-parse') {
          return Promise.resolve({ stdout: 'abc123\n' })
        }
        return Promise.resolve({ stdout: '' })
      }
    )

    let createReturned = false
    const outcome = addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    ).then(
      () => undefined,
      (error: unknown) => error
    )
    void outcome.then(() => {
      createReturned = true
    })

    await vi.waitFor(() => expect(advisorySignal?.aborted).toBe(true))
    expect(createReturned).toBe(false)
    expect(advisorySettled).toBe(false)

    rejectAdvisory()
    await expect(outcome).resolves.toBe(checkoutError)
    expect(advisorySettled).toBe(true)
  })

  it('bounds and tolerates a stalled advisory after checkout succeeds', async () => {
    let rejectAdvisory!: (error: Error) => void
    const advisory = new Promise<{ stdout: string }>((_resolve, reject) => {
      rejectAdvisory = reject
    })
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-list') {
        return advisory
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123\n' })
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return Promise.resolve({ stdout: 'true\n' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })

    const creation = addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    await vi.waitFor(() => {
      expect(
        gitExecFileAsyncMock.mock.calls.find(([args]) => args[0] === 'rev-list')?.[1]
      ).toMatchObject({ timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS })
    })
    rejectAdvisory(new Error('git timed out'))

    await expect(creation).resolves.toEqual({})
  })

  it('skips advisory owner probes when the local base is already current', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // resolve creation base
      .mockResolvedValueOnce({ stdout: '0\t0\n' }) // local base is current
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // persist branch base
      .mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', false, false, {
        suggestLocalBaseRefUpdate: true
      })
    ).resolves.toEqual({})

    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/test',
        '/repo-feature',
        'refs/remotes/origin/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/test.base',
        'refs/remotes/origin/main'
      ],
      ['config', '--get', 'push.autoSetupRemote']
    ])
  })

  it('uses normalized branch metadata for slash-containing remotes', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/foo/bar/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/foo/bar/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'foo/bar/main',
      false,
      false,
      {
        suggestLocalBaseRefUpdate: true,
        remoteTrackingBase: {
          base: 'foo/bar/main',
          branch: 'main',
          ref: 'refs/remotes/foo/bar/main'
        }
      }
    )

    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'foo/bar/main',
      localBranch: 'main',
      behind: 2
    })
    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/foo/bar/main'],
      expect.objectContaining({
        cwd: '/repo',
        signal: expect.any(AbortSignal),
        timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
      })
    ])
  })

  it('does not suggest updating the local base ref when its owner worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '0\t2\n' })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({
          stdout: args.some((arg) => arg.startsWith('refs/heads/main'))
            ? 'old-main\n'
            : 'remote-main\n'
        })
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Promise.resolve({ stdout: worktreeListOutput })
      }
      if (args[0] === 'status') {
        return Promise.resolve({ stdout: ' M package.json\n' })
      }
      if (args[0] === 'config' && args[1] === '--get') {
        return Promise.resolve({ stdout: 'true\n' })
      }
      return Promise.resolve({ stdout: '' })
    })

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    expect(result).toEqual({})
  })
})
