import { describe, expect, it, vi } from 'vitest'
import {
  createWorktreeCreateTimingRecorder,
  formatWorktreeCreateTiming,
  logWorktreeCreateTiming
} from './worktree-create-timing'

describe('createWorktreeCreateTimingRecorder', () => {
  it('records ordered phase timings and total duration', async () => {
    const samples = [100, 105, 112, 130, 144, 155]
    const recorder = createWorktreeCreateTimingRecorder(() => samples.shift() ?? 155)

    const syncResult = recorder.timeSync('resolve_branch', () => 'branch')
    const asyncResult = await recorder.time('git_worktree_add', async () => 'created')

    expect(syncResult).toBe('branch')
    expect(asyncResult).toBe('created')
    expect(recorder.finish()).toEqual({
      totalDurationMs: 55,
      phases: [
        { phase: 'resolve_branch', startedAtMs: 5, durationMs: 7 },
        { phase: 'git_worktree_add', startedAtMs: 30, durationMs: 14 }
      ]
    })
  })
})

describe('worktree create timing diagnostics', () => {
  const timing = {
    totalDurationMs: 99.6,
    phases: [
      { phase: 'late', startedAtMs: 50.4, durationMs: 10.6 },
      { phase: 'early', startedAtMs: 4.4, durationMs: 2.6 }
    ]
  }

  it('formats rounded phases in chronological order', () => {
    expect(formatWorktreeCreateTiming('wsl', timing)).toBe(
      '[worktree-create-timing] target=wsl total=100ms early=3ms@+4ms late=11ms@+50ms'
    )
  })

  it('logs the deterministic diagnostic', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    logWorktreeCreateTiming('direct-ssh', timing)

    expect(infoSpy).toHaveBeenCalledOnce()
    expect(infoSpy).toHaveBeenCalledWith(
      '[worktree-create-timing] target=direct-ssh total=100ms early=3ms@+4ms late=11ms@+50ms'
    )
    infoSpy.mockRestore()
  })
})
