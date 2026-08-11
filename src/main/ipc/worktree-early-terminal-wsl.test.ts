import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  REPO_PATH,
  WORKSPACE_PATH,
  createTestWorktree,
  makeRepo,
  makeRuntime,
  makeStore,
  mocks,
  restorePlatform,
  setPlatform
} from './worktree-early-terminal-test-context'

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

describe('early local WSL worktree terminal', () => {
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

  it('uses a POSIX gate and imports only gate variables for configured wsl.exe', async () => {
    setPlatform('win32')
    const runtime = makeRuntime()
    const store = makeStore({ terminalWindowsShell: 'wsl.exe' })
    mocks.resolveSetupRunnerShell.mockReturnValue({ family: 'cmd' })

    await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime, store }
    )

    const terminalOptions = runtime.createTerminal.mock.calls[0]?.[1]
    expect(terminalOptions?.command).toContain('bash --noprofile --norc -c')
    expect(terminalOptions?.envToDelete).toEqual(['BASH_ENV', 'ENV'])
    expect(terminalOptions?.env?.WSLENV).toContain('ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT')
    expect(terminalOptions?.env?.WSLENV).toContain('ORCA_WORKTREE_CHECKOUT_GATE_NONCE')
  })

  it('uses the POSIX gate and WSL git options for a selected WSL runtime', async () => {
    setPlatform('win32')
    const runtime = makeRuntime()
    mocks.resolveSetupRunnerShell.mockReturnValue({ family: 'cmd' })
    mocks.getLocalProjectGitExecOptions.mockReturnValue({
      cwd: REPO_PATH,
      wslDistro: 'Ubuntu'
    })
    mocks.getLocalProjectWorktreeGitOptions.mockReturnValue({ wslDistro: 'Ubuntu' })

    await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { runtime }
    )

    expect(mocks.addWorktree.mock.calls[0]?.[5]).toBe(true)
    expect(mocks.addWorktree.mock.calls[0]?.[6]).toEqual({ wslDistro: 'Ubuntu' })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ command: expect.stringContaining('bash --noprofile --norc -c') })
    )
    expect(mocks.materializeWorktreeCheckout).toHaveBeenCalledWith(
      `${WORKSPACE_PATH}/early-terminal`,
      'early-terminal',
      [],
      { wslDistro: 'Ubuntu' }
    )
  })

  it('uses WSL gate imports and timing for an auto-routed UNC worktree', async () => {
    setPlatform('win32')
    const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`
    const worktreePath = String.raw`\\wsl.localhost\Ubuntu\home\dev\repo-early-terminal`
    const repo = { ...makeRepo(), path: repoPath }
    const store = makeStore({ terminalWindowsShell: 'powershell.exe' })
    mocks.computeWorktreePath.mockReturnValue(worktreePath)

    const { runtime } = await createTestWorktree(
      { startTerminalEarly: true, startup: { command: 'codex' } },
      { repo, store }
    )

    const terminalOptions = runtime!.createTerminal.mock.calls[0]?.[1]
    expect(terminalOptions?.command).toContain('bash --noprofile --norc -c')
    expect(terminalOptions?.env?.WSLENV).toContain('ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT')
    expect(terminalOptions?.env?.WSLENV).toContain('ORCA_WORKTREE_CHECKOUT_GATE_NONCE')
    expect(mocks.logWorktreeCreateTiming).toHaveBeenCalledWith('wsl', expect.any(Object))
  })
})
