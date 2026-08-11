import { resolveConfiguredRemoteBranchName } from './repo-base-ref-search'
import { gitExecOptions, type GitExec, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'

export type BranchConflictKind = 'local' | 'remote'

type LocalBranchConflictOptions = LocalGitExecOptions & {
  knownLocalBranchExists?: boolean
}

async function hasGitRefAsync(exec: GitExec, ref: string): Promise<boolean> {
  try {
    const { stdout } = await exec(['rev-parse', '--verify', ref])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function listRemoteNamesViaExec(exec: GitExec): Promise<string[]> {
  try {
    const { stdout } = await exec(['remote'])
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  } catch {
    return []
  }
}

/** Run branch-conflict policy through the host that owns Git execution. */
export async function getBranchConflictKindViaExec(
  exec: GitExec,
  branchName: string,
  allowedBaseRef?: string,
  knownLocalBranchExists?: boolean
): Promise<BranchConflictKind | null> {
  if (knownLocalBranchExists ?? (await hasGitRefAsync(exec, `refs/heads/${branchName}`))) {
    return 'local'
  }

  try {
    const remoteNames = await listRemoteNamesViaExec(exec)
    const { stdout } = await exec(['for-each-ref', '--format=%(refname)', 'refs/remotes'])
    const hasRemoteConflict = stdout.split(/\r?\n/).some((ref) => {
      const trimmed = ref.trim()
      if (isAllowedRemoteBaseRef(trimmed, allowedBaseRef)) {
        return false
      }
      return resolveConfiguredRemoteBranchName(trimmed, remoteNames) === branchName
    })

    return hasRemoteConflict ? 'remote' : null
  } catch {
    return null
  }
}

export function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalBranchConflictOptions = {}
): Promise<BranchConflictKind | null> {
  const { knownLocalBranchExists, ...gitOptions } = options
  const execOptions = gitExecOptions(path, gitOptions)
  return getBranchConflictKindViaExec(
    (argv) => gitExecFileAsync(argv, execOptions),
    branchName,
    allowedBaseRef,
    knownLocalBranchExists
  )
}

function isAllowedRemoteBaseRef(refName: string, allowedBaseRef: string | undefined): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}
