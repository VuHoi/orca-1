import { describe, expect, it, vi } from 'vitest'
import { createTerminalOutputMarkerWait } from './terminal-output-marker-wait'

describe('createTerminalOutputMarkerWait', () => {
  it('retains a marker split before and after PTY binding', async () => {
    const wait = createTerminalOutputMarkerWait('gate-ready', 1_000)

    wait.observe('pty-1', 'prefix gate-')
    const completion = wait.waitFor('pty-1')
    wait.observe('pty-1', 'ready suffix')

    await expect(completion).resolves.toBeUndefined()
  })

  it('ignores a matching marker from another PTY', async () => {
    vi.useFakeTimers()
    try {
      const wait = createTerminalOutputMarkerWait('gate-ready', 1_000)
      wait.observe('pty-other', 'gate-ready')
      const completion = wait.waitFor('pty-target')
      let completed = false
      void completion.then(() => {
        completed = true
      })

      await vi.advanceTimersByTimeAsync(10)
      expect(completed).toBe(false)
      wait.observe('pty-target', 'gate-ready')
      await expect(completion).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails on PTY exit or a bounded timeout', async () => {
    const exited = createTerminalOutputMarkerWait('gate-ready', 1_000)
    const exitedCompletion = exited.waitFor('pty-exited')
    exited.observeExit('pty-exited')
    await expect(exitedCompletion).rejects.toThrow('terminal_output_marker_pty_exited')

    vi.useFakeTimers()
    try {
      const timedOut = createTerminalOutputMarkerWait('gate-ready', 50)
      const timeoutCompletion = timedOut.waitFor('pty-stuck')
      const assertion = expect(timeoutCompletion).rejects.toThrow('terminal_output_marker_timeout')
      await vi.advanceTimersByTimeAsync(50)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('charges pre-binding time to the marker deadline', async () => {
    vi.useFakeTimers()
    try {
      const wait = createTerminalOutputMarkerWait('gate-ready', 50)
      wait.observe('pty-late', 'gate-')

      await vi.advanceTimersByTimeAsync(50)
      wait.observe('pty-late', 'ready')

      await expect(wait.waitFor('pty-late')).rejects.toThrow('terminal_output_marker_timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails when the target exits after matching before PTY binding', async () => {
    const wait = createTerminalOutputMarkerWait('gate-ready', 1_000)

    wait.observe('pty-exited', 'gate-ready')
    wait.observeExit('pty-exited')

    await expect(wait.waitFor('pty-exited')).rejects.toThrow('terminal_output_marker_pty_exited')
  })

  it('fails immediately when its signal is aborted', async () => {
    const controller = new AbortController()
    const wait = createTerminalOutputMarkerWait('gate-ready', 10_000)
    const completion = wait.waitFor('pty-cancelled', controller.signal)

    controller.abort()

    await expect(completion).rejects.toThrow('client_disconnected')
  })
})
