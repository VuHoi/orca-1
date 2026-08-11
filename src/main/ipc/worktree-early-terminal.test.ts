import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { CreateWorktreeArgs } from '../../shared/worktree/create-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  AGENT_TELEMETRY,
  REPO_PATH,
  WORKSPACE_PATH,
  createTestWorktree,
  deferred,
  makeRepo,
  makeRuntime,
  makeStore,
  mocks,
  restorePlatform
} from './worktree-early-terminal-test-context'
import { makeMainWindow } from './worktree-early-terminal-main-window-fixture'

function recordCreatedWorktree(args: unknown[]): void {
  const path = args[1] as string
  const branch = args[2] as string
  mocks.listWorktreeGraph.mockResolvedValue([
    {
      path,
      head: 'created-head',
      branch: `refs/heads/${branch}`,
      isBare: false,
      isMainWorktree: false
    }
  ])
}

describe('early local worktree terminal', () => {
  beforeEach(() => {
    restorePlatform()
    vi.clearAllMocks()
    mocks.getBranchConflictKind.mockResolvedValue(null)
    mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('refs/heads/main^{commit}') ? 'base-head\n' : '',
      stderr: ''
    }))
    const recordCreated = async (...args: unknown[]): Promise<Record<string, never>> => {
      recordCreatedWorktree(args)
      return {}
    }
    mocks.addWorktree.mockImplementation(recordCreated)
    mocks.addSparseWorktree.mockImplementation(recordCreated)
    mocks.listWorktrees.mockResolvedValue([])
    mocks.materializeWorktreeCheckout.mockResolvedValue(undefined)
    mocks.rollbackFailedWorktreeCreate.mockImplementation(
      async (_repoPath, _worktreePath, _branch, error) => error
    )
    mocks.validateGitPushTarget.mockResolvedValue(undefined)
    mocks.prepareWorktreePushTargetWithExec.mockImplementation(
      async (_exec: unknown, _repoPath: string, target: GitPushTarget) => target
    )
    mocks.configureCreatedWorktreePushTargetWithExec.mockImplementation(
      async (_exec: unknown, _worktreePath: string, _branch: string, target: GitPushTarget) =>
        target
    )
    mocks.getEffectiveHooks.mockReturnValue(null)
    mocks.getEffectiveHooksFromConfig.mockReturnValue(null)
    mocks.getDefaultTabsLaunch.mockReturnValue(undefined)
    mocks.loadHooks.mockReturnValue(null)
    mocks.resolveSetupRunnerShell.mockReturnValue(undefined)
    mocks.shouldRunSetupForCreate.mockReturnValue(false)
    mocks.resolveWorktreeIncludePaths.mockResolvedValue([])
    mocks.resolveWorktreeSharedDirectories.mockResolvedValue([])
    mocks.createWorktreeLinkedPaths.mockResolvedValue(undefined)
    mocks.computeWorktreePath.mockImplementation((name: string) => `${WORKSPACE_PATH}/${name}`)
    mocks.getLocalProjectGitExecOptions.mockImplementation((_store, repo: Repo) => ({
      cwd: repo.path
    }))
    mocks.getLocalProjectWorktreeGitOptions.mockReturnValue({})
  })
  afterEach(restorePlatform)

  it.each([
    ['default', undefined],
    ['explicitly off', false]
  ] as const)('keeps checkout ahead of startup when the experiment is %s', async (_case, flag) => {
    const add = deferred<Record<string, never>>()
    const runtime = makeRuntime()
    mocks.addWorktree.mockImplementationOnce(async (...args: unknown[]) => {
      recordCreatedWorktree(args)
      return add.promise
    })
    const createPromise = createTestWorktree(
      {
        ...(flag === undefined ? {} : { startTerminalEarly: flag }),
        startup: {
          command: 'codex --resume',
          env: { BASH_ENV: '/normal/bash-env', ENV: '/normal/env' },
          launchToken: 'normal-launch-token'
        }
      },
      { runtime }
    )

    await vi.waitFor(() => expect(mocks.addWorktree).toHaveBeenCalledOnce())
    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(false)
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()

    add.resolve({})
    await createPromise

    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        command: 'codex --resume',
        env: expect.objectContaining({ BASH_ENV: '/normal/bash-env', ENV: '/normal/env' }),
        launchToken: 'normal-launch-token'
      })
    )
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('envToDelete')
  })

  it('falls back to post-checkout startup when explicit shell hook env must be preserved', async () => {
    const runtime = makeRuntime()

    await createTestWorktree(
      {
        startTerminalEarly: true,
        startup: {
          command: 'codex --resume',
          env: { BASH_ENV: '/normal/bash-env', ENV: '/normal/env' }
        }
      },
      { runtime }
    )

    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(false)
    expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        command: 'codex --resume',
        env: { BASH_ENV: '/normal/bash-env', ENV: '/normal/env' }
      })
    )
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('envToDelete')
  })

  it('falls back to post-checkout startup for inherited shell hook env', async () => {
    const previousBashEnv = process.env.BASH_ENV
    const runtime = makeRuntime()
    process.env.BASH_ENV = '/inherited/bash-env'

    try {
      await createTestWorktree(
        { startTerminalEarly: true, startup: { command: 'codex --resume' } },
        { runtime }
      )
    } finally {
      if (previousBashEnv === undefined) {
        delete process.env.BASH_ENV
      } else {
        process.env.BASH_ENV = previousBashEnv
      }
    }

    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(false)
    expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('envToDelete')
  })

  it('aborts and drains speculative readiness discovery when worktree add fails', async () => {
    const shared = deferred<string[]>()
    const include = deferred<string[]>()
    const addError = new Error('worktree add failed')
    let sharedSignal: AbortSignal | undefined
    let includeSignal: AbortSignal | undefined
    mocks.resolveWorktreeSharedDirectories.mockImplementation(
      (_repoPath: string, options: { signal?: AbortSignal }) => {
        sharedSignal = options.signal
        return shared.promise
      }
    )
    mocks.resolveWorktreeIncludePaths.mockImplementation(
      (_repoPath: string, options: { signal?: AbortSignal }) => {
        includeSignal = options.signal
        return include.promise
      }
    )
    mocks.addWorktree.mockRejectedValueOnce(addError)

    let createReturned = false
    const outcome = createTestWorktree().then(
      () => undefined,
      (error: unknown) => error
    )
    void outcome.then(() => {
      createReturned = true
    })

    await vi.waitFor(() => {
      expect(sharedSignal?.aborted).toBe(true)
      expect(includeSignal?.aborted).toBe(true)
    })
    expect(createReturned).toBe(false)

    shared.resolve([])
    await Promise.resolve()
    expect(createReturned).toBe(false)

    include.resolve([])
    await expect(outcome).resolves.toBe(addError)
  })

  it('drains a pending push-target mutation when normal create listing fails', async () => {
    const configuredPushTarget = deferred<GitPushTarget>()
    const listError = new Error('created worktree listing failed')
    const pushTarget = { remoteName: 'origin', branchName: 'early-terminal' }
    mocks.addWorktree.mockResolvedValueOnce({})
    mocks.listWorktreeGraph.mockRejectedValueOnce(listError)
    mocks.configureCreatedWorktreePushTargetWithExec.mockReturnValueOnce(
      configuredPushTarget.promise
    )

    let createReturned = false
    const outcome = createTestWorktree({ pushTarget }).then(
      () => undefined,
      (error: unknown) => error
    )
    void outcome.then(() => {
      createReturned = true
    })

    await vi.waitFor(() => {
      expect(mocks.listWorktreeGraph).toHaveBeenCalledOnce()
      expect(mocks.configureCreatedWorktreePushTargetWithExec).toHaveBeenCalledOnce()
    })
    expect(createReturned).toBe(false)

    configuredPushTarget.resolve(pushTarget)
    await expect(outcome).resolves.toBe(listError)
    expect(mocks.rollbackFailedWorktreeCreate).not.toHaveBeenCalled()
  })

  it('drains readiness discovery before returning a later local failure', async () => {
    const shared = deferred<string[]>()
    const include = deferred<string[]>()
    const linkedPathError = new Error('linked path failed')
    let sharedSignal: AbortSignal | undefined
    let includeSignal: AbortSignal | undefined
    mocks.resolveWorktreeSharedDirectories.mockImplementation(
      (_repoPath: string, options: { signal?: AbortSignal }) => {
        sharedSignal = options.signal
        return shared.promise
      }
    )
    mocks.resolveWorktreeIncludePaths.mockImplementation(
      (_repoPath: string, options: { signal?: AbortSignal }) => {
        includeSignal = options.signal
        return include.promise
      }
    )
    mocks.createWorktreeLinkedPaths.mockRejectedValueOnce(linkedPathError)

    let createReturned = false
    const outcome = createTestWorktree({}, { repo: makeRepo({ symlinkPaths: ['.env'] }) }).then(
      () => undefined,
      (error: unknown) => error
    )
    void outcome.then(() => {
      createReturned = true
    })

    await vi.waitFor(() => {
      expect(sharedSignal?.aborted).toBe(true)
      expect(includeSignal?.aborted).toBe(true)
    })
    expect(createReturned).toBe(false)

    shared.resolve([])
    await Promise.resolve()
    expect(createReturned).toBe(false)

    include.resolve([])
    await expect(outcome).resolves.toBe(linkedPathError)
  })

  it('gates the startup agent before checkout materialization and releases it afterward', async () => {
    const checkout = deferred<void>()
    const commitEarlyStartup = vi.fn(() => true)
    const runtime = makeRuntime()
    mocks.materializeWorktreeCheckout.mockReturnValueOnce(checkout.promise)
    const createPromise = createTestWorktree(
      {
        startTerminalEarly: true,
        createdWithAgent: 'codex',
        startup: {
          command: 'codex --full-auto',
          env: { TASK_ID: '42' },
          launchToken: 'early-launch-token',
          telemetry: AGENT_TELEMETRY
        }
      },
      { commitEarlyStartup, runtime }
    )

    await vi.waitFor(() => expect(mocks.materializeWorktreeCheckout).toHaveBeenCalledOnce())
    const terminalCreationPermit =
      await runtime.beginWorktreeTerminalCreationBarrier.mock.results[0]?.value
    expect(runtime.beginWorktreeTerminalCreationBarrier).toHaveBeenCalledWith(
      `repo-1::${WORKSPACE_PATH}/early-terminal`,
      `${WORKSPACE_PATH}/early-terminal`
    )
    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(true)
    expect(runtime.createTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.materializeWorktreeCheckout.mock.invocationCallOrder[0] ?? 0
    )
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        command: expect.stringContaining('bash --noprofile --norc -c'),
        env: expect.objectContaining({ TASK_ID: '42' }),
        envToDelete: ['BASH_ENV', 'ENV'],
        launchToken: 'early-launch-token',
        launchAgent: 'codex',
        startupHandshake: {
          readyMarker: expect.stringContaining('orca-worktree-gate-ready:'),
          timeoutMs: 10_000
        },
        worktreeTerminalCreationPermit: terminalCreationPermit
      })
    )
    expect(runtime.endWorktreeTerminalCreationBarrier).not.toHaveBeenCalled()
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()
    expect(mocks.markCodexProjectTrusted).not.toHaveBeenCalled()
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('telemetry')
    expect(mocks.track).not.toHaveBeenCalled()

    checkout.resolve()
    const { result } = await createPromise

    expect(commitEarlyStartup.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markCodexProjectTrusted.mock.invocationCallOrder[0]
    )
    expect(mocks.markCodexProjectTrusted.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.sendTerminalHandshake.mock.invocationCallOrder[0]
    )
    expect(runtime.sendTerminalHandshake).toHaveBeenCalledWith('terminal-1', {
      input: expect.stringMatching(/orca-worktree-gate-release:.*codex --full-auto\r$/),
      acknowledgementMarker: expect.stringContaining('orca-worktree-gate-released:'),
      timeoutMs: 5_000
    })
    expect(runtime.sendTerminalHandshake.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.track.mock.invocationCallOrder[0] ?? 0
    )
    expect(mocks.track).toHaveBeenCalledOnce()
    expect(mocks.track).toHaveBeenCalledWith('agent_started', {
      ...AGENT_TELEMETRY,
      nth_repo_added: 3
    })
    expect(result.startupTerminal).toEqual(
      expect.objectContaining({ spawned: true, surface: 'visible' })
    )
    expect(result.earlyStartupCancelled).toBeUndefined()
    expect(runtime.endWorktreeTerminalCreationBarrier).toHaveBeenCalledWith(
      `repo-1::${WORKSPACE_PATH}/early-terminal`,
      terminalCreationPermit
    )
  })

  it('overlaps terminal readiness with checkout materialization', async () => {
    const terminalReady = deferred<{
      handle: string
      ptyId: string
      surface: string
      worktreeId: string
    }>()
    const checkout = deferred<void>()
    const runtime = makeRuntime()
    runtime.createTerminal.mockReturnValueOnce(terminalReady.promise)
    mocks.materializeWorktreeCheckout.mockReturnValueOnce(checkout.promise)

    const createPromise = createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime }
    )

    await vi.waitFor(() => expect(mocks.materializeWorktreeCheckout).toHaveBeenCalledOnce())
    expect(runtime.createTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.materializeWorktreeCheckout.mock.invocationCallOrder[0] ?? 0
    )
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()

    terminalReady.resolve({
      handle: 'terminal-1',
      ptyId: 'pty-1',
      surface: 'visible',
      worktreeId: 'repo-1::worktree'
    })
    checkout.resolve()
    await createPromise
  })

  it('reveals an inactive early terminal without stealing focus and returns its exact tab', async () => {
    const runtime = makeRuntime()
    runtime.createTerminal.mockResolvedValueOnce({
      handle: 'terminal-1',
      tabId: 'tab-early',
      surface: 'visible',
      worktreeId: 'repo-1::worktree'
    })

    const { result } = await createTestWorktree(
      {
        startTerminalEarly: true,
        focusEarlyTerminal: false,
        startup: { command: 'codex', launchToken: 'launch-early' }
      },
      { runtime }
    )

    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ activate: false, launchToken: 'launch-early' })
    )
    expect(result.startupTerminal).toEqual({
      spawned: true,
      tabId: 'tab-early',
      surface: 'visible'
    })
  })

  it('keeps the worktree but closes and suppresses startup when cancelled during checkout', async () => {
    const checkout = deferred<void>()
    const controller = new AbortController()
    const runtime = makeRuntime()
    const store = makeStore()
    mocks.materializeWorktreeCheckout.mockReturnValueOnce(checkout.promise)
    mocks.loadHooks.mockReturnValue({
      defaultTabs: [{ id: 'dev', title: 'Dev', command: 'pnpm dev' }]
    })
    mocks.getDefaultTabsLaunch.mockReturnValue({
      tabs: [{ id: 'dev', title: 'Dev', command: 'pnpm dev' }],
      runCommands: true
    })

    const createPromise = createTestWorktree(
      {
        startTerminalEarly: true,
        startup: { command: 'codex', telemetry: AGENT_TELEMETRY },
        createdWithAgent: 'codex'
      },
      { earlyStartupSignal: controller.signal, runtime, store }
    )

    await vi.waitFor(() => expect(mocks.materializeWorktreeCheckout).toHaveBeenCalledOnce())
    controller.abort()
    await vi.waitFor(() => expect(runtime.closeTerminal).toHaveBeenCalledWith('terminal-1'))
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()

    checkout.resolve()
    const { result } = await createPromise

    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(mocks.rollbackFailedWorktreeCreate).not.toHaveBeenCalled()
    expect(result.worktree.id).toBe(`repo-1::${WORKSPACE_PATH}/early-terminal`)
    expect(result.earlyStartupCancelled).toBe(true)
    expect(result.startupTerminal).toBeUndefined()
    expect(result.setup).toBeUndefined()
    expect(result.defaultTabs).toBeUndefined()
    expect(mocks.markCodexProjectTrusted).not.toHaveBeenCalled()
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('telemetry')
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('waits for parallel post-registration work before rolling back a failed early create', async () => {
    const listing = deferred<
      {
        path: string
        head: string
        branch: string
        isBare: boolean
        isMainWorktree: boolean
      }[]
    >()
    const configureError = new Error('push target configuration failed')
    mocks.addWorktree.mockResolvedValueOnce({})
    mocks.listWorktreeGraph.mockReturnValueOnce(listing.promise)
    mocks.configureCreatedWorktreePushTargetWithExec.mockRejectedValueOnce(configureError)

    const rejection = createTestWorktree({
      startTerminalEarly: true,
      pushTarget: { remoteName: 'origin', branchName: 'early-terminal' }
    }).then(
      () => undefined,
      (error: unknown) => error
    )

    await vi.waitFor(() => {
      expect(mocks.listWorktreeGraph).toHaveBeenCalledOnce()
      expect(mocks.configureCreatedWorktreePushTargetWithExec).toHaveBeenCalledOnce()
    })
    expect(mocks.rollbackFailedWorktreeCreate).not.toHaveBeenCalled()

    listing.resolve([])
    await expect(rejection).resolves.toBe(configureError)
    expect(mocks.rollbackFailedWorktreeCreate).toHaveBeenCalledWith(
      REPO_PATH,
      `${WORKSPACE_PATH}/early-terminal`,
      'early-terminal',
      configureError,
      {}
    )
  })

  it('rolls back an early registration when Git omits its created row', async () => {
    mocks.addWorktree.mockResolvedValueOnce({})
    mocks.listWorktreeGraph.mockResolvedValueOnce([])

    await expect(createTestWorktree({ startTerminalEarly: true })).rejects.toThrow(
      'Worktree created but not found in listing'
    )

    expect(mocks.rollbackFailedWorktreeCreate).toHaveBeenCalledOnce()
    expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
  })

  it.each(['metadata', 'lineage', 'roots'] as const)(
    'removes partial metadata and rolls back when %s registration fails',
    async (phase) => {
      const store = makeStore()
      const failure = new Error(`${phase} registration failed`)
      if (phase === 'metadata') {
        store.setWorktreeMeta.mockImplementationOnce(() => {
          throw failure
        })
      } else if (phase === 'lineage') {
        store.getWorktreeMeta.mockReturnValue({ instanceId: 'parent-instance' })
        store.setWorkspaceLineage.mockImplementationOnce(() => {
          throw failure
        })
      } else {
        mocks.registerWorktreeRootsForRepo.mockImplementationOnce(() => {
          throw failure
        })
      }
      const createArgs: Partial<CreateWorktreeArgs> = {
        startTerminalEarly: true,
        ...(phase === 'lineage' ? { parentWorkspace: 'worktree:repo-1::/parent' as const } : {})
      }

      await expect(createTestWorktree(createArgs, { store })).rejects.toThrow(failure.message)

      expect(store.removeWorktreeMeta).toHaveBeenCalledWith(
        `repo-1::${WORKSPACE_PATH}/early-terminal`
      )
      expect(mocks.rollbackFailedWorktreeCreate).toHaveBeenCalledOnce()
      expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
    }
  )

  it('releases a blank gated terminal into its interactive shell', async () => {
    const runtime = makeRuntime()

    const { result } = await createTestWorktree({ startTerminalEarly: true }, { runtime })

    const terminalOptions = runtime.createTerminal.mock.calls[0]?.[1]
    expect(terminalOptions).toEqual(
      expect.objectContaining({
        command: expect.stringContaining('bash --noprofile --norc -c'),
        activate: true
      })
    )
    expect(runtime.sendTerminalHandshake).toHaveBeenCalledWith('terminal-1', {
      input: expect.stringContaining('orca-worktree-gate-release:'),
      acknowledgementMarker: expect.stringContaining('orca-worktree-gate-released:'),
      timeoutMs: 5_000
    })
    expect(result.startupTerminal).toEqual(
      expect.objectContaining({ spawned: true, surface: 'visible' })
    )
  })

  it('closes the gated terminal and returns a warning when release fails', async () => {
    const runtime = makeRuntime()
    runtime.sendTerminalHandshake.mockRejectedValueOnce(new Error('terminal exited'))

    const { result } = await createTestWorktree(
      {
        startTerminalEarly: true,
        startup: { command: 'codex', telemetry: AGENT_TELEMETRY }
      },
      { runtime }
    )

    expect(runtime.closeTerminal).toHaveBeenCalledWith('terminal-1')
    expect(result.startupTerminal).toBeUndefined()
    expect(result.warning).toContain('Failed to release the early terminal')
    expect(result.warning).toContain('terminal exited')
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('telemetry')
    expect(mocks.track).not.toHaveBeenCalled()
  })

  it('retries an unrevealed gate close after checkout without releasing it', async () => {
    const runtime = makeRuntime()
    runtime.closeTerminal.mockRejectedValue(new Error('terminal close unavailable'))
    runtime.createTerminal
      .mockResolvedValueOnce({
        handle: 'hidden-terminal',
        surface: 'background',
        worktreeId: 'repo-1::worktree',
        warning: 'Terminal hidden-terminal could not be revealed.'
      })
      .mockResolvedValueOnce({
        handle: 'visible-terminal',
        surface: 'visible',
        worktreeId: 'repo-1::worktree'
      })

    const { result } = await createTestWorktree(
      {
        startTerminalEarly: true,
        startup: { command: 'codex', telemetry: AGENT_TELEMETRY }
      },
      { runtime }
    )

    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.closeTerminal).toHaveBeenNthCalledWith(1, 'hidden-terminal')
    expect(runtime.closeTerminal).toHaveBeenNthCalledWith(2, 'hidden-terminal')
    expect(runtime.createTerminal).toHaveBeenCalledTimes(2)
    expect(
      runtime.createTerminal.mock.calls.filter(([, options]) => options.telemetry !== undefined)
    ).toHaveLength(1)
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('telemetry')
    expect(runtime.createTerminal.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ command: 'codex', telemetry: AGENT_TELEMETRY })
    )
    expect(mocks.materializeWorktreeCheckout.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.closeTerminal.mock.invocationCallOrder[1] ?? 0
    )
    expect(mocks.materializeWorktreeCheckout.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.createTerminal.mock.invocationCallOrder[1] ?? 0
    )
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()
    expect(result.startupTerminal).toEqual(
      expect.objectContaining({ spawned: true, surface: 'visible' })
    )
    expect(result.warning).toContain('Terminal hidden-terminal could not be revealed.')
    expect(result.warning).toContain('startup command remains blocked')
  })

  it('uses the normal checkout path when setup must finish before agent startup', async () => {
    const runtime = makeRuntime()
    const repo = makeRepo({
      hookSettings: {
        mode: 'auto',
        scripts: { setup: '', archive: '' },
        setupAgentStartupPolicy: 'wait-for-setup'
      }
    })

    await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'claude' } },
      { repo, runtime }
    )

    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(false)
    expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ command: 'claude' })
    )
  })

  it.each(['in-process', 'native-panes-shim'] as const)(
    'uses the normal checkout path when Claude Agent Teams mode is %s',
    async (claudeAgentTeamsMode) => {
      const runtime = makeRuntime()
      const store = makeStore({ claudeAgentTeamsMode })

      await createTestWorktree(
        {
          startTerminalEarly: true,
          createdWithAgent: 'claude',
          startup: { command: 'claude --resume session-1' }
        },
        { runtime, store }
      )

      expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(false)
      expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
      expect(runtime.createTerminal).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ command: 'claude --resume session-1' })
      )
    }
  )

  it('uses the sparse creation path instead of preparing an early terminal', async () => {
    const runtime = makeRuntime()

    await createTestWorktree(
      {
        startTerminalEarly: true,
        sparseCheckout: { directories: ['src'] },
        startup: { command: 'codex' }
      },
      { runtime }
    )

    expect(mocks.addSparseWorktree).toHaveBeenCalledOnce()
    expect(mocks.materializeWorktreeCheckout).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ command: 'codex' })
    )
  })

  it('uses the normal checkout path when no local runtime owns the terminal', async () => {
    await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime: undefined }
    )

    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(false)
  })

  it('rolls back checkout even when metadata cleanup fails', async () => {
    const controller = new AbortController()
    const runtime = makeRuntime()
    const store = makeStore()
    const checkoutError = new Error('checkout failed')
    runtime.closeTerminal.mockRejectedValueOnce(new Error('terminal close unavailable'))
    store.removeWorktreeMeta.mockImplementationOnce(() => {
      throw new Error('metadata cleanup failed')
    })
    mocks.materializeWorktreeCheckout.mockImplementationOnce(async () => {
      controller.abort()
      throw checkoutError
    })
    mocks.rollbackFailedWorktreeCreate.mockResolvedValueOnce(checkoutError)

    const createPromise = createTestWorktree(
      { startTerminalEarly: true },
      { earlyStartupSignal: controller.signal, runtime, store }
    )
    await expect(createPromise).rejects.toThrow('checkout failed')

    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
    expect(mocks.rollbackFailedWorktreeCreate).toHaveBeenCalledOnce()
    expect(mocks.runWorktreeChangeInvalidators).toHaveBeenCalledWith('repo-1')
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()
  })

  it('waits for every worktree PTY to stop before rolling back a failed checkout', async () => {
    const runtime = makeRuntime()
    const checkoutError = new Error('checkout failed')
    const terminalStop = deferred<void>()
    runtime.stopTerminalsForFailedWorktreeCreate.mockReturnValueOnce(terminalStop.promise)
    mocks.materializeWorktreeCheckout.mockRejectedValueOnce(checkoutError)
    mocks.rollbackFailedWorktreeCreate.mockResolvedValueOnce(checkoutError)

    const createPromise = createTestWorktree({ startTerminalEarly: true }, { runtime })
    const rejectedCreate = expect(createPromise).rejects.toThrow('checkout failed')

    await vi.waitFor(() =>
      expect(runtime.stopTerminalsForFailedWorktreeCreate).toHaveBeenCalledOnce()
    )
    expect(runtime.stopTerminalsForFailedWorktreeCreate).toHaveBeenCalledWith(
      `repo-1::${WORKSPACE_PATH}/early-terminal`
    )
    expect(mocks.rollbackFailedWorktreeCreate).not.toHaveBeenCalled()

    terminalStop.resolve()
    await rejectedCreate
    expect(mocks.rollbackFailedWorktreeCreate).toHaveBeenCalledOnce()
  })

  it('rolls back after authoritative inventory finds no remaining PTYs', async () => {
    const runtime = makeRuntime()
    const checkoutError = new Error('checkout failed')
    mocks.materializeWorktreeCheckout.mockRejectedValueOnce(checkoutError)
    mocks.rollbackFailedWorktreeCreate.mockResolvedValueOnce(checkoutError)

    await expect(createTestWorktree({ startTerminalEarly: true }, { runtime })).rejects.toThrow(
      'checkout failed'
    )

    expect(runtime.stopTerminalsForFailedWorktreeCreate).toHaveBeenCalledOnce()
    expect(mocks.rollbackFailedWorktreeCreate).toHaveBeenCalledOnce()
  })

  it('keeps a completed checkout when its unpublished gate PTY cannot be verified stopped', async () => {
    const runtime = makeRuntime()
    const store = makeStore()
    runtime.createTerminal.mockImplementationOnce((_selector, options) => {
      options.onStartupHandshakeStopUnverified?.('pty-unpublished')
      return Promise.reject(new Error('terminal_startup_handshake_stop_unverified'))
    })
    runtime.stopTerminalsForFailedWorktreeCreate.mockRejectedValue(new Error('daemon unavailable'))

    const error = await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime, store }
    ).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toMatchObject({ cleanupFailed: true })
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining('left in place for manual removal')
    )
    expect(runtime.stopTerminalsForFailedWorktreeCreate).toHaveBeenCalledTimes(2)
    expect(runtime.failWorktreeTerminalCreationBarrier).toHaveBeenCalledWith(
      `repo-1::${WORKSPACE_PATH}/early-terminal`,
      expect.any(Symbol)
    )
    expect(store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(mocks.rollbackFailedWorktreeCreate).not.toHaveBeenCalled()
  })

  it('closes without release and notifies when post-checkout readiness fails', async () => {
    const controller = new AbortController()
    const runtime = makeRuntime()
    const mainWindow = makeMainWindow()
    const repo = makeRepo({ symlinkPaths: ['.env'] })
    const readinessError = new Error('symlink preparation failed')
    runtime.closeTerminal.mockRejectedValueOnce(new Error('terminal close unavailable'))
    mocks.createWorktreeLinkedPaths.mockImplementationOnce(async () => {
      controller.abort()
      throw readinessError
    })

    const createPromise = createTestWorktree(
      { startTerminalEarly: true },
      { earlyStartupSignal: controller.signal, mainWindow, repo, runtime }
    )
    await expect(createPromise).rejects.toThrow('symlink preparation failed')

    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: 'repo-1'
    })
    expect(mocks.rollbackFailedWorktreeCreate).not.toHaveBeenCalled()
  })

  it('cancels the early terminal when target-branch default tabs take ownership', async () => {
    const runtime = makeRuntime()
    const defaultTabs = {
      tabs: [{ id: 'dev', title: 'Dev', command: 'pnpm dev' }],
      runCommands: true
    }
    mocks.loadHooks.mockReturnValue({ defaultTabs: defaultTabs.tabs })
    mocks.getDefaultTabsLaunch.mockReturnValue(defaultTabs)

    const { result } = await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime }
    )

    expect(runtime.closeTerminal).toHaveBeenCalledWith('terminal-1')
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()
    expect(result.defaultTabs).toEqual(defaultTabs)
    expect(result.startupTerminal).toBeUndefined()
  })

  it('retains and retries a default-tab gate when closing it fails', async () => {
    const runtime = makeRuntime()
    runtime.closeTerminal.mockRejectedValue(new Error('terminal close unavailable'))
    const defaultTabs = {
      tabs: [{ id: 'dev', title: 'Dev', command: 'pnpm dev' }],
      runCommands: true
    }
    mocks.loadHooks.mockReturnValue({ defaultTabs: defaultTabs.tabs })
    mocks.getDefaultTabsLaunch.mockReturnValue(defaultTabs)

    const { result } = await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime }
    )

    expect(runtime.closeTerminal).toHaveBeenCalledTimes(2)
    expect(runtime.closeTerminal).toHaveBeenNthCalledWith(1, 'terminal-1')
    expect(runtime.closeTerminal).toHaveBeenNthCalledWith(2, 'terminal-1')
    expect(runtime.sendTerminalHandshake).not.toHaveBeenCalled()
    expect(result.startupTerminal).toBeUndefined()
    expect(result.warning).toContain('Failed to close the gated early terminal')
    expect(result.warning).toContain('terminal close unavailable')
    expect(result.warning).toContain('startup command remains blocked')
  })
})
