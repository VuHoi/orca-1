import type { GitStatusResult } from '../../shared/git-status-types'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import {
  WORKTREE_ADD_TRANSPORT_TIMEOUT_MS,
  WORKTREE_LOCAL_BASE_REF_CHECK_TRANSPORT_TIMEOUT_MS,
  WORKTREE_LOCAL_BASE_REF_REFRESH_TRANSPORT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_COMMAND_TRANSPORT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_TRANSPORT_TIMEOUT_MS
} from '../../shared/worktree-create-timeouts'
import { requestGitStreamable } from '../ssh/ssh-git-response-stream-reader'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'
import { SshGitReviewHeadProvider } from './ssh-git-review-head-provider'

function isLegacyRelaySparseCheckoutRestricted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /git subcommand not allowed:\s*sparse-checkout/i.test(message)
}

function formatStatusEntriesForCleanCheck(entries: GitStatusResult['entries']): string | undefined {
  if (entries.length === 0) {
    return undefined
  }
  return entries.map((entry) => `${entry.area} ${entry.status}: ${entry.path}`).join('\n')
}

function filterUntrackedPorcelainStatus(stdout: string | undefined): string | undefined {
  const trackedLines = (stdout ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith('?? '))
  return trackedLines.length > 0 ? trackedLines.join('\n') : undefined
}

export class SshGitWorktreeProvider extends SshGitReviewHeadProvider {
  private loggedWorktreeIsCleanFallback = false

  async listWorktrees(
    repoPath: string,
    options?: { signal?: AbortSignal }
  ): Promise<GitWorktreeInfo[]> {
    return (await this.mux.request(
      'git.listWorktrees',
      { repoPath },
      { signal: options?.signal }
    )) as GitWorktreeInfo[]
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: {
      base?: string
      checkoutExistingBranch?: boolean
      noCheckout?: boolean
      signal?: AbortSignal
    }
  ): Promise<void> {
    const { signal, ...relayOptions } = options ?? {}
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request(
        'git.addWorktree',
        {
          repoPath,
          branchName,
          targetDir,
          ...relayOptions
        },
        {
          ...(signal ? { signal } : {}),
          timeoutMs: WORKTREE_ADD_TRANSPORT_TIMEOUT_MS
        }
      )
    })
  }

  async materializeWorktreeCheckout(
    worktreePath: string,
    branchName: string,
    sparseDirectories: readonly string[],
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const requestOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: WORKTREE_MATERIALIZATION_TRANSPORT_TIMEOUT_MS
    }
    try {
      await this.runWithGitReadInvalidation(async () => {
        await this.mux.request(
          'git.materializeWorktreeCheckout',
          { worktreePath, branchName, sparseDirectories: [...sparseDirectories] },
          requestOptions
        )
      })
    } catch (error) {
      if (!isJsonRpcMethodNotFoundError(error)) {
        throw error
      }
      const legacyOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: WORKTREE_MATERIALIZATION_COMMAND_TRANSPORT_TIMEOUT_MS
      }
      try {
        await this.runWithGitReadInvalidation(async () => {
          await requestGitStreamable(
            this.mux,
            'git.exec',
            { args: ['sparse-checkout', 'init', '--cone'], cwd: worktreePath },
            legacyOptions
          )
          await requestGitStreamable(
            this.mux,
            'git.exec',
            {
              args: ['sparse-checkout', 'set', '--', ...sparseDirectories],
              cwd: worktreePath
            },
            legacyOptions
          )
          await requestGitStreamable(
            this.mux,
            'git.exec',
            { args: ['checkout', branchName], cwd: worktreePath },
            legacyOptions
          )
        })
      } catch (fallbackError) {
        if (
          options.signal?.aborted ||
          (fallbackError as { name?: unknown } | null)?.name === 'AbortError'
        ) {
          throw fallbackError
        }
        if (isLegacyRelaySparseCheckoutRestricted(fallbackError)) {
          throw new Error(
            'This SSH host is running an older Orca relay that cannot materialize sparse worktrees. Reconnect to deploy the latest relay, then try again.',
            { cause: fallbackError }
          )
        }
        throw fallbackError
      }
    }
  }

  async removeWorktree(
    worktreePath: string,
    force?: boolean,
    options?: { deleteBranch?: boolean; forceBranchDelete?: boolean }
  ): Promise<RemoveWorktreeResult> {
    return this.runWithGitReadInvalidation(
      async () =>
        ((await this.mux.request('git.removeWorktree', {
          worktreePath,
          force,
          ...options
        })) ?? {}) as RemoveWorktreeResult
    )
  }

  async worktreeIsClean(
    worktreePath: string,
    options: { includeUntracked?: boolean; signal?: AbortSignal } = {}
  ): Promise<{ clean: boolean; stdout?: string }> {
    try {
      const params = {
        worktreePath,
        ...(options.includeUntracked === false ? { includeUntracked: false } : {})
      }
      const result = (await (options.signal
        ? this.mux.request('git.worktreeIsClean', params, { signal: options.signal })
        : this.mux.request('git.worktreeIsClean', params))) as {
        clean: boolean
        stdout?: string
      }
      if (options.includeUntracked === false) {
        if (!result.clean && result.stdout === undefined) {
          return result
        }
        const trackedStdout = filterUntrackedPorcelainStatus(result.stdout)
        return { clean: !trackedStdout, ...(trackedStdout ? { stdout: trackedStdout } : {}) }
      }
      return result
    } catch (error) {
      if (!isJsonRpcMethodNotFoundError(error)) {
        throw error
      }
      if (options.signal?.aborted) {
        throw error
      }
      if (!this.loggedWorktreeIsCleanFallback) {
        this.loggedWorktreeIsCleanFallback = true
        console.warn(
          '[ssh-git] Relay does not implement git.worktreeIsClean; falling back to git.status clean check'
        )
      }
      const status = await this.getStatus(
        worktreePath,
        options.signal ? { signal: options.signal } : undefined
      )
      const entries =
        options.includeUntracked === false
          ? status.entries.filter((entry) => entry.area !== 'untracked')
          : status.entries
      const clean = entries.length === 0
      return { clean, stdout: formatStatusEntriesForCleanCheck(entries) }
    }
  }

  async refreshLocalBaseRefForWorktreeCreate(
    args: {
      repoPath: string
      fullRef: string
      remoteTrackingRef: string
      ownerWorktreePath?: string
      checkOnly?: boolean
    },
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.refreshLocalBaseRefForWorktreeCreate', args, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: args.checkOnly
          ? WORKTREE_LOCAL_BASE_REF_CHECK_TRANSPORT_TIMEOUT_MS
          : WORKTREE_LOCAL_BASE_REF_REFRESH_TRANSPORT_TIMEOUT_MS
      })
    })
  }

  async renameCurrentBranch(worktreePath: string, newBranch: string): Promise<void> {
    await this.runWithGitReadInvalidation(async () => {
      await this.mux.request('git.renameCurrentBranch', { worktreePath, newBranch })
    })
  }

  async forceDeletePreservedBranch(
    repoPath: string,
    branchName: string,
    expectedHead: string
  ): Promise<void> {
    try {
      await this.runWithGitReadInvalidation(async () => {
        await this.mux.request('git.forceDeletePreservedBranch', {
          repoPath,
          branchName,
          expectedHead
        })
      })
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(
          'This SSH host is running an older Orca relay that cannot delete preserved branches. Reconnect to deploy the latest relay, then try again.'
        )
      }
      throw error
    }
  }
}
