import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  WORKTREE_ADD_INNER_TIMEOUT_BUDGET_MS,
  WORKTREE_ADD_MAX_AUXILIARY_GIT_COMMANDS,
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_ADD_TRANSPORT_TIMEOUT_MARGIN_MS,
  WORKTREE_ADD_TRANSPORT_TIMEOUT_MS,
  WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS,
  WORKTREE_LOCAL_BASE_REF_CHECK_INNER_TIMEOUT_BUDGET_MS,
  WORKTREE_LOCAL_BASE_REF_CHECK_TRANSPORT_TIMEOUT_MS,
  WORKTREE_LOCAL_BASE_REF_MAX_AUXILIARY_GIT_COMMANDS,
  WORKTREE_LOCAL_BASE_REF_REFRESH_INNER_TIMEOUT_BUDGET_MS,
  WORKTREE_LOCAL_BASE_REF_REFRESH_TRANSPORT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_COMMAND_TRANSPORT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_GIT_COMMANDS,
  WORKTREE_MATERIALIZATION_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_TRANSPORT_TIMEOUT_MS
} from '../../shared/worktree-create-timeouts'
import { SshGitProvider } from './ssh-git-provider'
import {
  createMockMux,
  type MockMultiplexer,
  waitForRequestCount
} from './ssh-git-provider-test-harness'

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('listWorktrees sends git.listWorktrees request', async () => {
    const worktrees = [
      {
        path: '/home/user/repo',
        head: 'abc123',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    ]
    mux.request.mockResolvedValue(worktrees)

    const controller = new AbortController()
    const result = await provider.listWorktrees('/home/user/repo', { signal: controller.signal })
    expect(mux.request).toHaveBeenCalledWith(
      'git.listWorktrees',
      { repoPath: '/home/user/repo' },
      { signal: controller.signal }
    )
    expect(result).toEqual(worktrees)
  })

  it('addWorktree keeps cancellation transport-local and allows checkout time to settle', async () => {
    const controller = new AbortController()
    await provider.addWorktree('/home/user/repo', 'feature', '/home/user/feat', {
      base: 'main',
      noCheckout: true,
      signal: controller.signal
    })
    expect(mux.request).toHaveBeenCalledWith(
      'git.addWorktree',
      {
        repoPath: '/home/user/repo',
        branchName: 'feature',
        targetDir: '/home/user/feat',
        base: 'main',
        noCheckout: true
      },
      {
        signal: controller.signal,
        timeoutMs: WORKTREE_ADD_TRANSPORT_TIMEOUT_MS
      }
    )
    expect(mux.request.mock.calls[0]?.[1]).not.toHaveProperty('signal')
  })

  it('budgets addWorktree transport beyond every bounded relay subprocess', () => {
    expect(WORKTREE_ADD_INNER_TIMEOUT_BUDGET_MS).toBe(
      WORKTREE_ADD_TIMEOUT_MS +
        WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS * WORKTREE_ADD_MAX_AUXILIARY_GIT_COMMANDS
    )
    expect(WORKTREE_ADD_TRANSPORT_TIMEOUT_MS).toBe(
      WORKTREE_ADD_INNER_TIMEOUT_BUDGET_MS + WORKTREE_ADD_TRANSPORT_TIMEOUT_MARGIN_MS
    )
  })

  it('materializes sparse worktrees through the bounded relay RPC', async () => {
    const controller = new AbortController()

    await provider.materializeWorktreeCheckout('/home/user/feat', 'feature', ['apps/web'], {
      signal: controller.signal
    })

    expect(mux.request).toHaveBeenCalledWith(
      'git.materializeWorktreeCheckout',
      {
        worktreePath: '/home/user/feat',
        branchName: 'feature',
        sparseDirectories: ['apps/web']
      },
      {
        signal: controller.signal,
        timeoutMs: WORKTREE_MATERIALIZATION_TRANSPORT_TIMEOUT_MS
      }
    )
    expect(WORKTREE_MATERIALIZATION_TRANSPORT_TIMEOUT_MS).toBe(
      WORKTREE_MATERIALIZATION_TIMEOUT_MS * WORKTREE_MATERIALIZATION_GIT_COMMANDS +
        WORKTREE_ADD_TRANSPORT_TIMEOUT_MARGIN_MS
    )
  })

  it('falls back to the legacy sparse sequence when the relay method is missing', async () => {
    mux.request
      .mockRejectedValueOnce(Object.assign(new Error('method not found'), { code: -32601 }))
      .mockResolvedValue({ stdout: '', stderr: '' })

    await provider.materializeWorktreeCheckout('/home/user/feat', 'feature', ['apps/web'])

    expect(mux.request.mock.calls).toEqual([
      [
        'git.materializeWorktreeCheckout',
        {
          worktreePath: '/home/user/feat',
          branchName: 'feature',
          sparseDirectories: ['apps/web']
        },
        { timeoutMs: WORKTREE_MATERIALIZATION_TRANSPORT_TIMEOUT_MS }
      ],
      [
        'git.exec',
        {
          args: ['sparse-checkout', 'init', '--cone'],
          cwd: '/home/user/feat',
          __streamResponse: true
        },
        { signal: undefined, timeoutMs: WORKTREE_MATERIALIZATION_COMMAND_TRANSPORT_TIMEOUT_MS }
      ],
      [
        'git.exec',
        {
          args: ['sparse-checkout', 'set', '--', 'apps/web'],
          cwd: '/home/user/feat',
          __streamResponse: true
        },
        { signal: undefined, timeoutMs: WORKTREE_MATERIALIZATION_COMMAND_TRANSPORT_TIMEOUT_MS }
      ],
      [
        'git.exec',
        { args: ['checkout', 'feature'], cwd: '/home/user/feat', __streamResponse: true },
        { signal: undefined, timeoutMs: WORKTREE_MATERIALIZATION_COMMAND_TRANSPORT_TIMEOUT_MS }
      ]
    ])
  })

  it('prompts a relay update when the legacy relay rejects sparse checkout', async () => {
    mux.request
      .mockRejectedValueOnce(Object.assign(new Error('method not found'), { code: -32601 }))
      .mockRejectedValueOnce(new Error('git subcommand not allowed: sparse-checkout'))

    await expect(
      provider.materializeWorktreeCheckout('/home/user/feat', 'feature', ['apps/web'])
    ).rejects.toThrow(
      'This SSH host is running an older Orca relay that cannot materialize sparse worktrees. Reconnect to deploy the latest relay, then try again.'
    )
  })

  it('preserves a real failure from the legacy sparse sequence', async () => {
    const checkoutError = new Error('fatal: unable to create file: No space left on device')
    mux.request
      .mockRejectedValueOnce(Object.assign(new Error('method not found'), { code: -32601 }))
      .mockRejectedValueOnce(checkoutError)

    await expect(
      provider.materializeWorktreeCheckout('/home/user/feat', 'feature', ['apps/web'])
    ).rejects.toBe(checkoutError)
  })

  it('removeWorktree sends git.removeWorktree request', async () => {
    await provider.removeWorktree('/home/user/feat', true)
    expect(mux.request).toHaveBeenCalledWith('git.removeWorktree', {
      worktreePath: '/home/user/feat',
      force: true
    })
  })

  it('worktreeIsClean sends git.worktreeIsClean request', async () => {
    const cleanResult = { clean: false, stdout: '?? scratch.txt\n' }
    mux.request.mockResolvedValue(cleanResult)

    const result = await provider.worktreeIsClean('/home/user/feat')

    expect(mux.request).toHaveBeenCalledWith('git.worktreeIsClean', {
      worktreePath: '/home/user/feat'
    })
    expect(result).toEqual(cleanResult)
  })

  it('worktreeIsClean can ignore untracked files', async () => {
    const cleanResult = { clean: true }
    mux.request.mockResolvedValue(cleanResult)
    const controller = new AbortController()

    const result = await provider.worktreeIsClean('/home/user/feat', {
      includeUntracked: false,
      signal: controller.signal
    })

    expect(mux.request).toHaveBeenCalledWith(
      'git.worktreeIsClean',
      {
        worktreePath: '/home/user/feat',
        includeUntracked: false
      },
      { signal: controller.signal }
    )
    expect(mux.request.mock.calls[0]?.[1]).not.toHaveProperty('signal')
    expect(result).toEqual(cleanResult)
  })

  it('worktreeIsClean filters untracked stdout when old relays ignore the option', async () => {
    mux.request.mockResolvedValue({ clean: false, stdout: '?? scratch.txt\n' })

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(result).toEqual({ clean: true })
  })

  it('worktreeIsClean keeps dirty results without stdout dirty for tracked-only checks', async () => {
    mux.request.mockResolvedValue({ clean: false })

    const result = await provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })

    expect(result).toEqual({ clean: false })
  })

  it('refreshLocalBaseRefForWorktreeCreate sends the narrow refresh request', async () => {
    const controller = new AbortController()
    await provider.refreshLocalBaseRefForWorktreeCreate(
      {
        repoPath: '/home/user/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main',
        ownerWorktreePath: '/home/user/repo'
      },
      { signal: controller.signal }
    )

    expect(mux.request).toHaveBeenCalledWith(
      'git.refreshLocalBaseRefForWorktreeCreate',
      {
        repoPath: '/home/user/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main',
        ownerWorktreePath: '/home/user/repo'
      },
      {
        signal: controller.signal,
        timeoutMs: WORKTREE_LOCAL_BASE_REF_REFRESH_TRANSPORT_TIMEOUT_MS
      }
    )
    expect(mux.request.mock.calls[0]?.[1]).not.toHaveProperty('signal')
  })

  it('gives check-only local-base probes their complete bounded transport budget', async () => {
    await provider.refreshLocalBaseRefForWorktreeCreate({
      repoPath: '/home/user/repo',
      fullRef: 'refs/heads/main',
      remoteTrackingRef: 'refs/remotes/origin/main',
      checkOnly: true
    })

    expect(mux.request).toHaveBeenCalledWith(
      'git.refreshLocalBaseRefForWorktreeCreate',
      {
        repoPath: '/home/user/repo',
        fullRef: 'refs/heads/main',
        remoteTrackingRef: 'refs/remotes/origin/main',
        checkOnly: true
      },
      { timeoutMs: WORKTREE_LOCAL_BASE_REF_CHECK_TRANSPORT_TIMEOUT_MS }
    )
  })

  it('budgets local-base transport beyond every bounded relay subprocess', () => {
    expect(WORKTREE_LOCAL_BASE_REF_CHECK_INNER_TIMEOUT_BUDGET_MS).toBe(
      WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS * WORKTREE_LOCAL_BASE_REF_MAX_AUXILIARY_GIT_COMMANDS
    )
    expect(WORKTREE_LOCAL_BASE_REF_CHECK_TRANSPORT_TIMEOUT_MS).toBe(
      WORKTREE_LOCAL_BASE_REF_CHECK_INNER_TIMEOUT_BUDGET_MS +
        WORKTREE_ADD_TRANSPORT_TIMEOUT_MARGIN_MS
    )
    expect(WORKTREE_LOCAL_BASE_REF_REFRESH_INNER_TIMEOUT_BUDGET_MS).toBe(
      WORKTREE_LOCAL_BASE_REF_CHECK_INNER_TIMEOUT_BUDGET_MS + WORKTREE_MATERIALIZATION_TIMEOUT_MS
    )
    expect(WORKTREE_LOCAL_BASE_REF_REFRESH_TRANSPORT_TIMEOUT_MS).toBe(
      WORKTREE_LOCAL_BASE_REF_REFRESH_INNER_TIMEOUT_BUDGET_MS +
        WORKTREE_ADD_TRANSPORT_TIMEOUT_MARGIN_MS
    )
  })

  it('worktreeIsClean preserves cancellation in the old-relay fallback', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    const controller = new AbortController()
    const abortError = new DOMException('This operation was aborted', 'AbortError')
    mux.request.mockRejectedValueOnce(methodNotFound).mockImplementationOnce(
      (_method: string, _params: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true
          })
        })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const cleanPromise = provider.worktreeIsClean('/home/user/feat', {
        signal: controller.signal
      })
      await waitForRequestCount(mux.request, 2)
      controller.abort(abortError)

      await expect(cleanPromise).rejects.toBe(abortError)
      expect(mux.request).toHaveBeenNthCalledWith(
        2,
        'git.status',
        { worktreePath: '/home/user/feat' },
        { signal: expect.any(AbortSignal) }
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('worktreeIsClean falls back to git.status for old relays', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    mux.request.mockRejectedValueOnce(methodNotFound).mockResolvedValueOnce({
      entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await provider.worktreeIsClean('/home/user/feat')

      expect(mux.request).toHaveBeenNthCalledWith(1, 'git.worktreeIsClean', {
        worktreePath: '/home/user/feat'
      })
      expect(mux.request).toHaveBeenNthCalledWith(
        2,
        'git.status',
        { worktreePath: '/home/user/feat' },
        { signal: expect.any(AbortSignal) }
      )
      expect(result).toEqual({ clean: false, stdout: 'untracked untracked: scratch.txt' })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('worktreeIsClean filters untracked entries in old-relay fallback', async () => {
    const methodNotFound = Object.assign(new Error('Method not found: git.worktreeIsClean'), {
      code: -32601
    })
    mux.request.mockRejectedValueOnce(methodNotFound).mockResolvedValueOnce({
      entries: [{ path: 'scratch.txt', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(
        provider.worktreeIsClean('/home/user/feat', { includeUntracked: false })
      ).resolves.toEqual({ clean: true })
      expect(mux.request).toHaveBeenNthCalledWith(
        2,
        'git.status',
        { worktreePath: '/home/user/feat' },
        { signal: expect.any(AbortSignal) }
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('renameCurrentBranch sends the narrow branch-rename request', async () => {
    await provider.renameCurrentBranch('/home/user/feat', 'you/fix-auth')
    expect(mux.request).toHaveBeenCalledWith('git.renameCurrentBranch', {
      worktreePath: '/home/user/feat',
      newBranch: 'you/fix-auth'
    })
  })

  it('forceDeletePreservedBranch sends the preserved-branch delete request', async () => {
    await provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    expect(mux.request).toHaveBeenCalledWith('git.forceDeletePreservedBranch', {
      repoPath: '/home/user/repo',
      branchName: 'you/fix-auth',
      expectedHead: 'abc123'
    })
  })

  it('forceDeletePreservedBranch maps old relays to the reconnect message', async () => {
    const methodNotFound = Object.assign(
      new Error('Method not found: git.forceDeletePreservedBranch'),
      { code: -32601 }
    )
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(
      provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    ).rejects.toThrow(
      'This SSH host is running an older Orca relay that cannot delete preserved branches. Reconnect to deploy the latest relay, then try again.'
    )
  })

  it('forceDeletePreservedBranch rethrows non-method-not-found errors', async () => {
    const error = new Error('remote update-ref failed')
    mux.request.mockRejectedValueOnce(error)

    await expect(
      provider.forceDeletePreservedBranch('/home/user/repo', 'you/fix-auth', 'abc123')
    ).rejects.toBe(error)
  })
})
