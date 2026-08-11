import { afterEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { getBranchConflictKind, getBranchConflictKindViaExec } from './repo-branch-conflict'

afterEach(() => {
  gitExecFileAsyncMock.mockReset()
})

describe('getBranchConflictKindViaExec local probe evidence', () => {
  it('does not repeat a known-missing execution-host probe', async () => {
    const exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: 'refs/remotes/origin/feature/fix\n' }
      }
      throw new Error(`unexpected Git call: ${args.join(' ')}`)
    })

    await expect(
      getBranchConflictKindViaExec(exec, 'feature/fix', 'origin/main', false)
    ).resolves.toBe('remote')

    expect(exec.mock.calls.map(([args]) => args[0])).toEqual(['remote', 'for-each-ref'])
  })

  it('returns known local evidence without an execution-host probe', async () => {
    const exec = vi.fn()

    await expect(
      getBranchConflictKindViaExec(exec, 'feature/fix', 'origin/main', true)
    ).resolves.toBe('local')

    expect(exec).not.toHaveBeenCalled()
  })

  it('retries local classification when earlier evidence was not authoritative', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'branch-sha\n' })

    await expect(
      getBranchConflictKindViaExec(exec, 'feature/fix', 'origin/main', undefined)
    ).resolves.toBe('local')

    expect(exec).toHaveBeenCalledOnce()
    expect(exec).toHaveBeenCalledWith(['rev-parse', '--verify', 'refs/heads/feature/fix'])
  })
})

describe('getBranchConflictKind routed local probe evidence', () => {
  it.each([
    ['native', {}],
    ['WSL', { wslDistro: 'Ubuntu' }]
  ])('does not repeat a known-missing %s branch probe', async (_label, gitOptions) => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected Git call: ${args.join(' ')}`)
    })

    await expect(
      getBranchConflictKind('/repo', 'feature/fix', 'origin/main', {
        ...gitOptions,
        knownLocalBranchExists: false
      })
    ).resolves.toBeNull()

    const execOptions = { cwd: '/repo', ...gitOptions }
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['remote'], execOptions],
      [['for-each-ref', '--format=%(refname)', 'refs/remotes'], execOptions]
    ])
  })

  it('returns a known local conflict without another subprocess', async () => {
    await expect(
      getBranchConflictKind('/repo', 'feature/fix', 'origin/main', {
        knownLocalBranchExists: true
      })
    ).resolves.toBe('local')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
