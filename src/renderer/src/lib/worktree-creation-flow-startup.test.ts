import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'

vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'launch-token' }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ settings: {} }) } }))
const { isWebClientLocation } = vi.hoisted(() => ({
  isWebClientLocation: vi.fn(() => false)
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation }))

import {
  buildWorktreeCreationStartupOpt,
  isBackendOwnedWorktreeCreationStartup,
  resolveWorktreeCreationStartups
} from './worktree-creation-flow-startup'

function requestWithPlan(plan: AgentStartupPlan): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'feature',
    setupDecision: 'inherit',
    agent: 'claude',
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: plan,
    quickPrompt: '',
    quickTelemetry: null,
    startTerminalEarly: true,
    worktreeCreateProgressMode: 'stepped'
  }
}

describe('early worktree terminal startup ownership', () => {
  beforeEach(() => isWebClientLocation.mockReturnValue(false))

  it.each([
    ['draft', { draftPrompt: 'draft context', followupPrompt: null }],
    ['follow-up', { followupPrompt: 'send this prompt' }]
  ] as const)('binds %s delivery to the single backend-launched command', (_label, delivery) => {
    const plan: AgentStartupPlan = {
      agent: 'claude',
      launchCommand: 'claude',
      expectedProcess: 'claude',
      launchConfig: { agentArgs: '', agentEnv: {} },
      ...delivery
    }
    const request = requestWithPlan(plan)

    const startups = resolveWorktreeCreationStartups(request)

    expect(startups.backendStartup).toBeUndefined()
    expect(startups.createStartup).toEqual({
      command: 'claude',
      launchConfig: plan.launchConfig,
      launchToken: 'launch-token',
      launchAgent: 'claude'
    })
    expect(plan.launchToken).toBe('launch-token')
    expect(buildWorktreeCreationStartupOpt(request, true)).toBeUndefined()
    expect(isBackendOwnedWorktreeCreationStartup(startups.backendStartup, true)).toBe(false)
  })

  it.each([
    ['paired runtime', { worktreeCreateProgressMode: 'indeterminate' as const }],
    [
      'SSH host',
      {
        workspaceRunContext: {
          kind: 'workspace-run' as const,
          projectId: 'project-1',
          hostId: 'ssh:target' as const,
          projectHostSetupId: 'setup-1',
          repoId: 'repo-1',
          path: '/repo'
        }
      }
    ]
  ])('does not transfer renderer delivery ownership to a %s create', (_label, patch) => {
    const plan: AgentStartupPlan = {
      agent: 'claude',
      launchCommand: 'claude',
      expectedProcess: 'claude',
      followupPrompt: 'send this prompt',
      launchConfig: { agentArgs: '', agentEnv: {} }
    }
    const request = { ...requestWithPlan(plan), ...patch }

    expect(resolveWorktreeCreationStartups(request).createStartup).toBeUndefined()
    expect(plan.launchToken).toBeUndefined()
  })

  it('keeps paired web-client creates on runtime-owned startup', () => {
    isWebClientLocation.mockReturnValue(true)
    const plan: AgentStartupPlan = {
      agent: 'claude',
      launchCommand: 'claude',
      expectedProcess: 'claude',
      followupPrompt: 'send this prompt',
      launchConfig: { agentArgs: '', agentEnv: {} }
    }

    expect(resolveWorktreeCreationStartups(requestWithPlan(plan)).createStartup).toBeUndefined()
    expect(plan.launchToken).toBeUndefined()
  })
})
