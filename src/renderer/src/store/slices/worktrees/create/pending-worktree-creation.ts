import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { AppState } from '../../../types'
import { cleanupFailedEphemeralVmWorkspace } from '@/lib/ephemeral-vm-failed-create-cleanup'
import { isWebClientLocation } from '@/lib/web-client-location'

export function createBeginPendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['beginPendingWorktreeCreation'] {
  return (entry) => {
    set((s) => ({
      pendingWorktreeCreations: { ...s.pendingWorktreeCreations, [entry.creationId]: entry },
      activePendingCreationId: entry.creationId
    }))
  }
}

export function createUpdatePendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['updatePendingWorktreeCreation'] {
  return (creationId, patch) => {
    set((s) => {
      const entry = s.pendingWorktreeCreations[creationId]
      if (!entry) {
        return {}
      }
      // Why: the main process re-emits the same phase; skip no-op writes so the strip and panel don't re-render.
      const hasChange = (Object.keys(patch) as (keyof typeof patch)[]).some(
        (key) => patch[key] !== entry[key]
      )
      if (!hasChange) {
        return {}
      }
      return {
        pendingWorktreeCreations: {
          ...s.pendingWorktreeCreations,
          [creationId]: { ...entry, ...patch }
        }
      }
    })
  }
}

export function createRemovePendingWorktreeCreation(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['removePendingWorktreeCreation'] {
  return async (creationId, options) => {
    const entry = get().pendingWorktreeCreations[creationId]
    if (!entry) {
      return
    }
    const cleanupVm = options?.cleanupVm ?? true
    const needsEarlyCreateCancellation =
      cleanupVm &&
      entry.status === 'creating' &&
      entry.request.startTerminalEarly === true &&
      !isWebClientLocation() &&
      (entry.request.workspaceRunContext?.hostId ?? 'local') === 'local' &&
      entry.request.worktreeCreateProgressMode !== 'indeterminate'
    if (needsEarlyCreateCancellation) {
      if (typeof window === 'undefined' || !window.api?.worktrees?.cancelCreate) {
        return
      }
      try {
        const result = await window.api.worktrees.cancelCreate({ creationId })
        if (!result.cancelled) {
          return
        }
      } catch {
        return
      }
    }
    const currentEntry = get().pendingWorktreeCreations[creationId]
    if (!currentEntry || currentEntry.startedAt !== entry.startedAt) {
      return
    }
    let removedEntry: AppState['pendingWorktreeCreations'][string] | undefined
    set((s) => {
      const latest = s.pendingWorktreeCreations[creationId]
      if (!latest || latest.startedAt !== entry.startedAt) {
        return {}
      }
      removedEntry = latest
      const { [creationId]: _removed, ...rest } = s.pendingWorktreeCreations
      return {
        pendingWorktreeCreations: rest,
        // Why: only clear the active surface if it pointed here, so dismissing a background creation doesn't yank the user away.
        ...(s.activePendingCreationId === creationId ? { activePendingCreationId: null } : {})
      }
    })
    if (!removedEntry || !cleanupVm || typeof window === 'undefined') {
      return
    }
    if (removedEntry.phase === 'provisioning-vm' && window.api?.ephemeralVm?.cancelProvision) {
      void window.api.ephemeralVm
        .cancelProvision({ provisionId: creationId })
        .catch(() => undefined)
    }
    if (!removedEntry.request.ephemeralVmRuntimeId || !window.api?.ephemeralVm?.cleanup) {
      return
    }
    void cleanupFailedEphemeralVmWorkspace(removedEntry.request, {
      deleteProjectHostSetup: (setupId) => get().deleteProjectHostSetup({ setupId }),
      cleanupRuntime: (runtimeId) => window.api.ephemeralVm.cleanup({ runtimeId }),
      reportSetupError: (error) =>
        console.error('Failed to remove cancelled provisioned-root project setup:', error),
      reportRuntimeError: (error) =>
        console.error('Failed to clean up cancelled ephemeral VM runtime:', error)
    })
  }
}

export function createSetActivePendingWorktreeCreation(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['setActivePendingWorktreeCreation'] {
  return (creationId) => {
    set((s) => {
      if (creationId !== null && !s.pendingWorktreeCreations[creationId]) {
        return {}
      }
      return { activePendingCreationId: creationId }
    })
  }
}
