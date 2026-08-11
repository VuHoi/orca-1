export type TerminalOutputMarkerWait = {
  observe: (ptyId: string, data: string) => void
  observeExit: (ptyId: string) => void
  waitFor: (ptyId: string, signal?: AbortSignal) => Promise<void>
  dispose: () => void
}

export function createTerminalOutputMarkerWait(
  marker: string,
  timeoutMs: number
): TerminalOutputMarkerWait {
  if (!marker || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('invalid_terminal_output_marker_wait')
  }

  const tailsByPtyId = new Map<string, string>()
  const matchedPtyIds = new Set<string>()
  const exitedPtyIds = new Set<string>()
  const deadlineMs = Date.now() + Math.floor(timeoutMs)
  let expectedPtyId: string | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let abortSignal: AbortSignal | null = null
  let abortListener: (() => void) | null = null
  let settled = false
  let resolveWait!: () => void
  let rejectWait!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })

  const settle = (error?: Error): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
    if (abortSignal && abortListener) {
      abortSignal.removeEventListener('abort', abortListener)
      abortSignal = null
      abortListener = null
    }
    tailsByPtyId.clear()
    matchedPtyIds.clear()
    exitedPtyIds.clear()
    if (error) {
      rejectWait(error)
    } else {
      resolveWait()
    }
  }

  return {
    observe: (ptyId, data) => {
      if (
        settled ||
        Date.now() >= deadlineMs ||
        (expectedPtyId !== null && ptyId !== expectedPtyId)
      ) {
        return
      }
      const candidate = `${tailsByPtyId.get(ptyId) ?? ''}${data}`
      if (candidate.includes(marker)) {
        matchedPtyIds.add(ptyId)
        if (expectedPtyId === ptyId) {
          settle()
        }
        return
      }
      const tailLength = marker.length - 1
      tailsByPtyId.set(ptyId, tailLength === 0 ? '' : candidate.slice(-tailLength))
    },
    observeExit: (ptyId) => {
      if (settled || (expectedPtyId !== null && ptyId !== expectedPtyId)) {
        return
      }
      exitedPtyIds.add(ptyId)
      if (expectedPtyId === ptyId) {
        settle(new Error('terminal_output_marker_pty_exited'))
      }
    },
    waitFor: (ptyId, signal) => {
      if (expectedPtyId !== null && expectedPtyId !== ptyId) {
        return Promise.reject(new Error('terminal_output_marker_already_bound'))
      }
      expectedPtyId = ptyId
      for (const retainedPtyId of tailsByPtyId.keys()) {
        if (retainedPtyId !== ptyId) {
          tailsByPtyId.delete(retainedPtyId)
        }
      }
      if (!settled && signal && !abortListener) {
        abortSignal = signal
        abortListener = () => settle(new Error('client_disconnected'))
        if (signal.aborted) {
          abortListener()
        } else {
          signal.addEventListener('abort', abortListener, { once: true })
        }
      }
      if (settled) {
        return promise
      }
      if (exitedPtyIds.has(ptyId)) {
        settle(new Error('terminal_output_marker_pty_exited'))
      } else if (matchedPtyIds.has(ptyId)) {
        settle()
      } else if (!settled && !timeout) {
        const remainingMs = deadlineMs - Date.now()
        if (remainingMs <= 0) {
          settle(new Error('terminal_output_marker_timeout'))
        } else {
          timeout = setTimeout(
            () => settle(new Error('terminal_output_marker_timeout')),
            remainingMs
          )
          timeout.unref?.()
        }
      }
      return promise
    },
    // Cancellation belongs to a different failing operation; settle harmlessly to avoid a stray rejection.
    dispose: () => settle()
  }
}
