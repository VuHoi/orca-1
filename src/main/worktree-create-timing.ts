import type {
  WorktreeCreateTiming,
  WorktreeCreateTimingPhase
} from '../shared/worktree/create-types'

type TimingClock = () => number

export type WorktreeCreateTimingRecorder = {
  time<T>(phase: string, operation: () => Promise<T>): Promise<T>
  timeSync<T>(phase: string, operation: () => T): T
  finish(): WorktreeCreateTiming
}

export type WorktreeCreateTimingTarget = 'local' | 'wsl' | 'direct-ssh'

function defaultClock(): number {
  return performance.now()
}

function clampDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function formatDuration(value: number): string {
  return `${Math.round(clampDuration(value))}ms`
}

export function formatWorktreeCreateTiming(
  target: WorktreeCreateTimingTarget,
  timing: WorktreeCreateTiming
): string {
  const phases = [...timing.phases]
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .map(
      (phase) =>
        `${phase.phase}=${formatDuration(phase.durationMs)}@+${formatDuration(phase.startedAtMs)}`
    )
  return [
    '[worktree-create-timing]',
    `target=${target}`,
    `total=${formatDuration(timing.totalDurationMs)}`,
    ...phases
  ].join(' ')
}

export function logWorktreeCreateTiming(
  target: WorktreeCreateTimingTarget,
  timing: WorktreeCreateTiming
): void {
  console.info(formatWorktreeCreateTiming(target, timing))
}

function createPhase(
  phase: string,
  operationStartedAt: number,
  operationEndedAt: number,
  rootStartedAt: number
): WorktreeCreateTimingPhase {
  return {
    phase,
    startedAtMs: clampDuration(operationStartedAt - rootStartedAt),
    durationMs: clampDuration(operationEndedAt - operationStartedAt)
  }
}

export function createWorktreeCreateTimingRecorder(
  clock: TimingClock = defaultClock
): WorktreeCreateTimingRecorder {
  const startedAt = clock()
  const phases: WorktreeCreateTimingPhase[] = []

  const recordPhase = (phase: string, operationStartedAt: number): void => {
    phases.push(createPhase(phase, operationStartedAt, clock(), startedAt))
  }

  return {
    async time<T>(phase: string, operation: () => Promise<T>): Promise<T> {
      const operationStartedAt = clock()
      try {
        return await operation()
      } finally {
        recordPhase(phase, operationStartedAt)
      }
    },
    timeSync<T>(phase: string, operation: () => T): T {
      const operationStartedAt = clock()
      try {
        return operation()
      } finally {
        recordPhase(phase, operationStartedAt)
      }
    },
    finish() {
      return {
        totalDurationMs: clampDuration(clock() - startedAt),
        phases: [...phases]
      }
    }
  }
}
