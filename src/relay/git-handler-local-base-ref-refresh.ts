import type { GitExec } from './git-handler-ops'
import { areRelayWorktreePathsEqual, readRelayWorktreeList } from './git-handler-worktree-ops'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import {
  WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS,
  WORKTREE_MATERIALIZATION_TIMEOUT_MS
} from '../shared/worktree-create-timeouts'

type RefreshGitOptions = { signal?: AbortSignal; timeout: number }

export async function refreshLocalBaseRefForWorktreeCreateOp(
  git: GitExec,
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const repoPath = params.repoPath as string
  const fullRef = params.fullRef as string
  const remoteTrackingRef = params.remoteTrackingRef as string
  const ownerWorktreePath = params.ownerWorktreePath as string | undefined
  const checkOnly = params.checkOnly === true

  if (
    typeof repoPath !== 'string' ||
    typeof fullRef !== 'string' ||
    typeof remoteTrackingRef !== 'string' ||
    (ownerWorktreePath !== undefined && typeof ownerWorktreePath !== 'string')
  ) {
    throw new Error('Invalid local base ref refresh request.')
  }
  if (!fullRef.startsWith('refs/heads/') || !remoteTrackingRef.startsWith('refs/remotes/')) {
    throw new Error('Invalid local base ref refresh refs.')
  }

  const execOptions: RefreshGitOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    timeout: WORKTREE_CREATE_AUXILIARY_GIT_TIMEOUT_MS
  }

  await git(['check-ref-format', fullRef], repoPath, execOptions)
  await git(['check-ref-format', remoteTrackingRef], repoPath, execOptions)

  const localOid = await revParseCommit(
    git,
    repoPath,
    fullRef,
    'Local base ref is missing.',
    execOptions
  )
  const remoteOid = await revParseCommit(
    git,
    repoPath,
    remoteTrackingRef,
    'Remote-tracking base ref is missing.',
    execOptions
  )

  // Why: this RPC mutates refs/worktrees, so the relay repeats main-process
  // safety checks at mutation time to close stale-preflight and direct-call gaps.
  try {
    await git(['merge-base', '--is-ancestor', localOid, remoteOid], repoPath, execOptions)
  } catch (error) {
    if (options.signal?.aborted || isAbortedOrTimedOutGit(error)) {
      throw error
    }
    throw new Error('Local base ref is not a fast-forward update.')
  }

  const worktrees = await readRelayWorktreeList(git, repoPath, capabilities, execOptions)
  const ownerWorktree = worktrees.find((worktree) => worktree.branch === fullRef)
  if (ownerWorktree) {
    if (ownerWorktreePath && !areRelayWorktreePathsEqual(ownerWorktree.path, ownerWorktreePath)) {
      throw new Error('Local base ref is checked out in a different worktree.')
    }
    const { stdout } = await git(
      ['status', '--porcelain', '--untracked-files=no'],
      ownerWorktree.path,
      execOptions
    )
    if (stdout.trim()) {
      throw new Error('Local base ref worktree has tracked changes.')
    }
    if (checkOnly) {
      return
    }
    await git(['reset', '--hard', remoteOid], ownerWorktree.path, {
      ...execOptions,
      timeout: WORKTREE_MATERIALIZATION_TIMEOUT_MS
    })
    return
  }

  // Why: not checked out anywhere — fast-forward the bare ref. The
  // expected-old-OID form is a no-op-safe compare-and-swap if the ref moved
  // since the caller's evaluation snapshot.
  if (checkOnly) {
    return
  }
  await git(['update-ref', fullRef, remoteOid, localOid], repoPath, execOptions)
}

async function revParseCommit(
  git: GitExec,
  repoPath: string,
  ref: string,
  missingMessage: string,
  options: RefreshGitOptions
): Promise<string> {
  const { stdout } = await git(['rev-parse', '--verify', `${ref}^{commit}`], repoPath, options)
  const oid = stdout.trim()
  if (!oid) {
    throw new Error(missingMessage)
  }
  return oid
}

function isAbortedOrTimedOutGit(error: unknown): boolean {
  const details = error as {
    name?: unknown
    code?: unknown
    killed?: unknown
    signal?: unknown
  } | null
  return (
    details?.name === 'AbortError' ||
    details?.code === 'ETIMEDOUT' ||
    details?.killed === true ||
    details?.signal === 'SIGTERM'
  )
}
