import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'

const store = {
  activeView: 'terminal',
  activePendingCreationId: 'creation-1',
  pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
  updatePendingWorktreeCreation: vi.fn(),
  removePendingWorktreeCreation: vi.fn(),
  setActivePendingWorktreeCreation: vi.fn(),
  setActiveView: vi.fn(),
  setSidebarOpen: vi.fn(),
  createWorktree: vi.fn()
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/ephemeral-vm-worktree-creation', () => ({
  prepareRequestForCreate: vi.fn(async (_creationId, request) => request),
  attachEphemeralVmRuntimeToWorkspace: vi.fn(),
  cleanupEphemeralVmRuntimeForFailedCreate: vi.fn()
}))
vi.mock('@/lib/worktree-creation-flow-startup', () => ({
  resolveWorktreeCreationStartups: () => ({
    backendStartup: undefined,
    createStartup: undefined
  }),
  getInitialWorktreeCreationPhase: () => 'fetching',
  getWorktreeCreationIndeterminate: () => false,
  isBackendOwnedWorktreeCreationStartup: () => false,
  buildWorktreeCreationStartupOpt: () => undefined
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: vi.fn() }))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))
vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { ensureWorktreeHasInitialTerminal } from '@/lib/worktree-initial-terminal-seeding'
import { ensureAgentStartupInTerminal } from '@/lib/new-workspace'
import { queueWorkspaceActivationTerminalFocus } from '@/lib/workspace-activation-terminal-focus'
import { seedAgentTabStateAfterWorktreeCreate } from '@/lib/worktree-creation-agent-seeds'
import { continueBackgroundWorktreeCreation } from './worktree-creation-flow'

function makeRequest(): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: 'codex',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: {
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    },
    quickPrompt: '',
    quickTelemetry: null,
    startTerminalEarly: true
  }
}

describe('early worktree terminal cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const request = makeRequest()
    store.pendingWorktreeCreations = {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'fetching',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    }
    store.createWorktree.mockResolvedValue({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo/wt-1' },
      earlyStartupCancelled: true
    })
  })

  it('treats backend cancellation as authoritative before renderer startup', async () => {
    const markTrusted = vi.fn()
    globalThis.window = { api: { agentTrust: { markTrusted } } } as never

    expect(continueBackgroundWorktreeCreation('creation-1', makeRequest())).toBe(true)

    await vi.waitFor(() =>
      expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
        cleanupVm: false
      })
    )
    expect(markTrusted).not.toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
    expect(seedAgentTabStateAfterWorktreeCreate).not.toHaveBeenCalled()
    expect(ensureAgentStartupInTerminal).not.toHaveBeenCalled()
    expect(queueWorkspaceActivationTerminalFocus).not.toHaveBeenCalled()
  })
})
