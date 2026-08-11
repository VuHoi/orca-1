import { describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import {
  WORKTREE_ADD_TIMEOUT_MS,
  WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_TIMEOUT_MS
} from '../shared/worktree-create-timeouts'
import type { GitExec } from './git-handler-ops'
import {
  addWorktreeOp,
  materializeWorktreeCheckoutOp,
  removeWorktreeOp
} from './git-handler-worktree-ops'

function removeWorktreeWithCapabilityCache(
  git: GitExec,
  params: Parameters<typeof removeWorktreeOp>[1]
) {
  return removeWorktreeOp(git, params, new GitCapabilityCache())
}

function worktreeList(...entries: { path: string; branch?: string }[]): string {
  return entries
    .map((entry, index) =>
      [
        `worktree ${entry.path}`,
        `HEAD ${index}`,
        ...(entry.branch ? [`branch refs/heads/${entry.branch}`] : [])
      ].join('\n')
    )
    .join('\n\n')
}

function resolvedRepoPath(): string {
  return path.posix.resolve('/repo-feature', '/repo/.git', '..')
}

describe('addWorktreeOp', () => {
  it('writes durable branch base config after creating an SSH new-branch worktree', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: '/repo',
        branchName: 'feature/test',
        targetDir: '/repo-feature',
        base: 'origin/main'
      },
      {},
      'linux'
    )

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
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
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual([
      'config',
      '--local',
      'branch.feature/test.remote',
      'origin'
    ])
    expect(git.mock.calls.map((call) => call[0])).not.toContainEqual([
      'config',
      '--local',
      'branch.feature/test.merge',
      'refs/heads/main'
    ])
  })

  it('does not write branch base config when checking out an existing SSH branch', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: '/repo',
        branchName: 'feature/test',
        targetDir: '/repo-feature',
        base: 'origin/main',
        checkoutExistingBranch: true
      },
      {},
      'linux'
    )

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'add', '/repo-feature', 'feature/test']
    ])
  })

  it('does not write branch base config when SSH creation has no base', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: '/repo',
        branchName: 'feature/no-base',
        targetDir: '/repo-feature'
      },
      {},
      'linux'
    )

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['worktree', 'add', '--no-track', '-b', 'feature/no-base', '/repo-feature'],
      ['config', '--get', 'push.autoSetupRemote']
    ])
  })

  it('enables long paths when the SSH execution host is Windows', async () => {
    // Why: only the host's OS matters — a macOS client can drive a Windows SSH host,
    // which hits the same MAX_PATH ceiling (issue #15785).
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: 'C:\\repo',
        branchName: 'feature/test',
        targetDir: 'C:\\repo-feature',
        checkoutExistingBranch: true
      },
      {},
      'win32'
    )

    expect(git.mock.calls.map((call) => call[0])).toEqual([
      ['-c', 'core.longpaths=true', 'worktree', 'add', 'C:\\repo-feature', 'feature/test']
    ])
  })

  it('keeps --no-checkout ahead of -b once the long-path prefix is present', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: 'C:\\repo',
        branchName: 'feature/test',
        targetDir: 'C:\\repo-feature',
        noCheckout: true
      },
      {},
      'win32'
    )

    expect(git.mock.calls[0][0]).toEqual([
      '-c',
      'core.longpaths=true',
      'worktree',
      'add',
      '--no-track',
      '--no-checkout',
      '-b',
      'feature/test',
      'C:\\repo-feature'
    ])
  })

  it('omits the long-path option on a WSL UNC target on a Windows SSH host', async () => {
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
        branchName: 'feature/test',
        targetDir: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-feature',
        checkoutExistingBranch: true
      },
      {},
      'win32'
    )

    expect(git.mock.calls[0][0]).toEqual([
      'worktree',
      'add',
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-feature',
      'feature/test'
    ])
  })

  it('bounds checkout without overriding workers and forwards cancellation', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await addWorktreeOp(
      git,
      {
        repoPath: '/repo',
        branchName: 'feature/test',
        targetDir: '/repo-feature',
        checkoutExistingBranch: true
      },
      { signal: controller.signal }
    )

    expect(git).toHaveBeenCalledWith(
      ['worktree', 'add', '/repo-feature', 'feature/test'],
      '/repo',
      { signal: controller.signal, timeout: WORKTREE_ADD_TIMEOUT_MS }
    )
  })

  it.each([
    ['an aborted request', Object.assign(new Error('canceled'), { name: 'Error' }), true],
    ['an AbortError', Object.assign(new Error('canceled'), { name: 'AbortError' }), false],
    ['a timed-out probe', Object.assign(new Error('timed out'), { killed: true }), false]
  ])('does not downgrade %s to a missing base ref', async (_label, rejection, abortSignal) => {
    const controller = new AbortController()
    if (abortSignal) {
      controller.abort()
    }
    const git = vi.fn<GitExec>(async () => {
      throw rejection
    })

    await expect(
      addWorktreeOp(
        git,
        {
          repoPath: '/repo',
          branchName: 'feature/test',
          targetDir: '/repo-feature',
          base: 'origin/main'
        },
        { signal: controller.signal }
      )
    ).rejects.toBe(rejection)
    expect(git).toHaveBeenCalledTimes(1)
  })

  it('bounds every prep and config command within the transport budget', async () => {
    const controller = new AbortController()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args[3]?.startsWith('refs/remotes/')) {
        throw new Error('missing remote ref')
      }
      if (args[0] === 'config' && args[2] === '--replace-all') {
        throw new Error('config locked')
      }
      if (args[0] === 'config' && args[1] === '--get') {
        throw Object.assign(new Error('unset'), { code: 1 })
      }
      return { stdout: '', stderr: '' }
    })

    await addWorktreeOp(
      git,
      {
        repoPath: '/repo',
        branchName: 'feature/test',
        targetDir: '/repo-feature',
        base: 'release/main'
      },
      { signal: controller.signal }
    )

    const auxiliaryOptions = {
      signal: controller.signal,
      timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
    }
    expect(git.mock.calls.map((call) => call[2])).toEqual([
      auxiliaryOptions,
      auxiliaryOptions,
      { signal: controller.signal, timeout: WORKTREE_ADD_TIMEOUT_MS },
      auxiliaryOptions,
      auxiliaryOptions,
      auxiliaryOptions,
      auxiliaryOptions
    ])
    warnSpy.mockRestore()
  })

  it('warns and unsets stale branch base config when SSH base persistence fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'config' && args[2] === '--replace-all') {
        throw new Error('config locked')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      addWorktreeOp(
        git,
        {
          repoPath: '/repo',
          branchName: 'feature/test',
          targetDir: '/repo-feature',
          base: 'origin/main'
        },
        {},
        'linux'
      )
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      'relay addWorktree: failed to set branch.feature/test.base for /repo-feature',
      expect.any(Error)
    )
    expect(git.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    warnSpy.mockRestore()
  })
})

describe('materializeWorktreeCheckoutOp', () => {
  it('preserves checkout workers and uses force, cancellation, and timeouts', async () => {
    const controller = new AbortController()
    const git = vi.fn<GitExec>(async () => ({ stdout: '', stderr: '' }))

    await materializeWorktreeCheckoutOp(
      git,
      {
        worktreePath: '/repo-feature',
        branchName: 'feature/test',
        sparseDirectories: ['apps/web', 'packages/shared']
      },
      { signal: controller.signal }
    )

    const execOptions = {
      signal: controller.signal,
      timeout: WORKTREE_MATERIALIZATION_TIMEOUT_MS
    }
    expect(git.mock.calls).toEqual([
      [['sparse-checkout', 'init', '--cone'], '/repo-feature', execOptions],
      [
        ['sparse-checkout', 'set', '--', 'apps/web', 'packages/shared'],
        '/repo-feature',
        execOptions
      ],
      [['checkout', '--force', 'feature/test'], '/repo-feature', execOptions]
    ])
  })
})

describe('removeWorktreeOp', () => {
  it('rejects a locked SSH worktree before invoking remove', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: `${worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          )}\nlocked remote agent`,
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).rejects.toThrow('Worktree is locked by Git. Lock reason: remote agent.')
    expect(git).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '/repo-feature'],
      expect.any(String)
    )
  })

  it('deletes the now-unused branch after removing an SSH worktree', async () => {
    const calls: string[] = []
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      `${resolvedRepoPath()}$ branch -d -- feature/test`
    ])
  })

  it('force-retries removal when git refuses a clean worktree containing an initialised submodule', async () => {
    const calls: string[] = []
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'remove' && !args.includes('--force')) {
        throw Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: working trees containing submodules cannot be moved or removed'
        })
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`,
      '/repo-feature$ status --porcelain --untracked-files=all',
      `${resolvedRepoPath()}$ worktree remove --force /repo-feature`,
      `${resolvedRepoPath()}$ branch -d -- feature/test`
    ])
  })

  it('surfaces uncommitted changes instead of force-removing a dirty submodule worktree', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: working trees containing submodules cannot be moved or removed'
        })
      }
      if (args[0] === 'status') {
        return { stdout: ' M sub\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).rejects.toThrow('Worktree has uncommitted or untracked changes.')
    expect(git).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', '/repo-feature'],
      expect.any(String)
    )
  })

  it('does not force-retry when the caller already forced SSH removal', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: working trees containing submodules cannot be moved or removed'
        })
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature', force: true })
    ).rejects.toThrow('git worktree remove failed')
    expect(
      git.mock.calls.filter(
        ([args]) => args[0] === 'worktree' && args[1] === 'remove' && args.includes('--force')
      )
    ).toHaveLength(1)
    expect(git).not.toHaveBeenCalledWith(
      ['status', '--porcelain', '--untracked-files=all'],
      expect.any(String)
    )
  })

  it('preserves the branch (does not throw) when `branch -d` refuses an unmerged branch', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error('error: the branch feature/test is not fully merged')
      }
      return { stdout: '', stderr: '' }
    })

    // The unmerged-branch refusal must be surfaced without failing workspace removal.
    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })
    ).resolves.toEqual({
      preservedBranch: { branchName: 'feature/test', head: '1' }
    })

    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
    expect(git).not.toHaveBeenCalledWith(['branch', '-D', '--', 'feature/test'], expect.any(String))
  })

  it('force-deletes the just-created branch during failed sparse setup rollback', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList({ path: '/repo', branch: 'main' }),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, {
      worktreePath: '/repo-feature',
      force: true,
      forceBranchDelete: true
    })

    expect(git).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', '/repo-feature'],
      expect.any(String)
    )
    expect(git).toHaveBeenCalledWith(['branch', '-D', '--', 'feature/test'], expect.any(String))
    expect(git).not.toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
  })

  it('does not let force override a locked SSH worktree', async () => {
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: `${worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          )}\nlocked remote agent`,
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await expect(
      removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature', force: true })
    ).rejects.toThrow('Worktree is locked by Git. Lock reason: remote agent')

    expect(git).not.toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', '/repo-feature'],
      expect.any(String)
    )
  })

  it('skips branch deletion entirely when deleteBranch is false', async () => {
    const calls: string[] = []
    const git = vi.fn<GitExec>(async (args, cwd) => {
      calls.push(`${cwd}$ ${args.join(' ')}`)
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          stdout: worktreeList(
            { path: '/repo', branch: 'main' },
            { path: '/repo-feature', branch: 'feature/test' }
          ),
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, {
      worktreePath: '/repo-feature',
      deleteBranch: false
    })

    expect(calls).toEqual([
      '/repo-feature$ rev-parse --git-common-dir',
      `${resolvedRepoPath()}$ worktree list --porcelain -z`,
      `${resolvedRepoPath()}$ worktree remove /repo-feature`
    ])
  })

  it('keeps the branch when Git reports another SSH worktree still uses it', async () => {
    let listCount = 0
    const git = vi.fn<GitExec>(async (args, _cwd) => {
      if (args[0] === 'rev-parse') {
        return { stdout: '/repo/.git\n', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        listCount += 1
        return {
          stdout:
            listCount === 1
              ? worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-feature', branch: 'feature/test' }
                )
              : worktreeList(
                  { path: '/repo', branch: 'main' },
                  { path: '/repo-other', branch: 'feature/test' }
                ),
          stderr: ''
        }
      }
      if (args[0] === 'branch' && args[1] === '-d') {
        throw new Error(
          "error: cannot delete branch 'feature/test' used by worktree at '/repo-other'"
        )
      }
      return { stdout: '', stderr: '' }
    })

    await removeWorktreeWithCapabilityCache(git, { worktreePath: '/repo-feature' })

    expect(git).toHaveBeenCalledWith(['branch', '-d', '--', 'feature/test'], expect.any(String))
    expect(git).toHaveBeenCalledWith(['worktree', 'prune'], expect.any(String))
    expect(git).not.toHaveBeenCalledWith(['branch', '-D', '--', 'feature/test'], expect.any(String))
  })
})
