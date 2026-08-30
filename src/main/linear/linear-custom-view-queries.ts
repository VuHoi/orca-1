import type { LinearIssue } from '../../shared/linear/issue-types'
import type {
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../shared/linear/project-types'
import type {
  LinearCollectionResult,
  LinearConcreteWorkspaceId,
  LinearWorkspaceSelection
} from '../../shared/linear/workspace-types'
import { clampLinearIssueListLimit } from '../../shared/linear/issue-read-limits'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError } from './client'
import {
  CUSTOM_VIEW_ISSUES_QUERY,
  CUSTOM_VIEW_PROJECTS_QUERY,
  CUSTOM_VIEW_QUERY,
  CUSTOM_VIEWS_QUERY
} from './linear-custom-view-graphql'
import type { CustomViewConnectionResponse, LinearRawVariables } from './linear-project-nodes'
import {
  clampLimit,
  coalesce,
  mapCustomViewForWorkspace,
  mapCustomViewModel,
  mapProjectForWorkspace,
  normalizeConcreteWorkspaceId
} from './linear-project-models'
import { readCollection, readConcreteCollection } from './linear-project-collection-read'
import { readIssueConnectionPages } from './linear-project-issue-queries'

export async function listCustomViews(
  model: LinearCustomViewModel,
  limit = 20,
  workspaceId?: LinearWorkspaceSelection | null,
  force = false
): Promise<LinearCollectionResult<LinearCustomViewSummary>> {
  const first = clampLimit(limit)
  const key = `listCustomViews:${workspaceId ?? 'default'}:${model}:${first}`
  const filter = { modelName: { eq: model === 'project' ? 'Project' : 'Issue' } }
  return readCollection(
    key,
    workspaceId,
    async (entry) => {
      const result = await entry.client.client.rawRequest<
        CustomViewConnectionResponse,
        LinearRawVariables
      >(CUSTOM_VIEWS_QUERY, { first, filter, orderBy: 'updatedAt' })
      const connection = result.data?.customViews
      return {
        items: (connection?.nodes ?? [])
          .map((view) => mapCustomViewForWorkspace(entry, view))
          .filter((view): view is LinearCustomViewSummary => !!view && view.model === model),
        hasMore: !!connection?.pageInfo?.hasNextPage
      }
    },
    force
  )
}

export async function getCustomView(
  viewId: string,
  model: LinearCustomViewModel,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<LinearCustomViewSummary | null> {
  const id = viewId.trim()
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  if (!id) {
    throw new Error('Custom view ID is required')
  }
  const key = `getCustomView:${concreteWorkspaceId}:${model}:${id}`
  return coalesce(
    key,
    async () => {
      const entries = getClients(concreteWorkspaceId)
      const entry = entries[0]
      if (!entry) {
        return null
      }
      await acquire()
      try {
        const result = await entry.client.client.rawRequest<
          CustomViewConnectionResponse,
          LinearRawVariables
        >(CUSTOM_VIEW_QUERY, { id })
        const view = result.data?.customView
        const mapped = view ? mapCustomViewForWorkspace(entry, view) : null
        return mapped?.model === model ? mapped : null
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
        }
        throw error
      } finally {
        release()
      }
    },
    force
  )
}

export async function listCustomViewIssues(
  viewId: string,
  limit = 20,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<LinearCollectionResult<LinearIssue>> {
  const id = viewId.trim()
  if (!id) {
    throw new Error('Custom view ID is required')
  }
  const first = clampLinearIssueListLimit(limit)
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readConcreteCollection(
    `listCustomViewIssues:${concreteWorkspaceId}:${id}:${first}`,
    concreteWorkspaceId,
    async (entry) => {
      return readIssueConnectionPages(entry, first, async (page) => {
        const result = await entry.client.client.rawRequest<
          CustomViewConnectionResponse,
          LinearRawVariables
        >(CUSTOM_VIEW_ISSUES_QUERY, { id, ...page, orderBy: 'updatedAt' })
        const view = result.data?.customView
        if (mapCustomViewModel(view?.modelName) !== 'issue') {
          throw new Error('Custom view does not contain issues')
        }
        return view?.issues
      })
    },
    force
  )
}

export async function listCustomViewProjects(
  viewId: string,
  limit = 20,
  workspaceId: LinearConcreteWorkspaceId,
  force = false
): Promise<LinearCollectionResult<LinearProjectSummary>> {
  const id = viewId.trim()
  if (!id) {
    throw new Error('Custom view ID is required')
  }
  const first = clampLimit(limit)
  const concreteWorkspaceId = normalizeConcreteWorkspaceId(workspaceId)
  return readConcreteCollection(
    `listCustomViewProjects:${concreteWorkspaceId}:${id}:${first}`,
    concreteWorkspaceId,
    async (entry) => {
      const result = await entry.client.client.rawRequest<
        CustomViewConnectionResponse,
        LinearRawVariables
      >(CUSTOM_VIEW_PROJECTS_QUERY, { id, first, orderBy: 'updatedAt' })
      const view = result.data?.customView
      if (mapCustomViewModel(view?.modelName) !== 'project') {
        throw new Error('Custom view does not contain projects')
      }
      const connection = view?.projects
      return {
        items: (connection?.nodes ?? []).map((project) => mapProjectForWorkspace(entry, project)),
        hasMore: !!connection?.pageInfo?.hasNextPage
      }
    },
    force
  )
}

const CREATE_CUSTOM_VIEW_MUTATION = `
  mutation WakiiLinearCustomViewCreate($input: CustomViewCreateInput!) {
    customViewCreate(input: $input) {
      success
      customView {
        id
        name
        description
        modelName
        color
        icon
        shared
        slugId
        createdAt
        updatedAt
        team { id name key }
      }
    }
  }
`

export type LinearCustomViewCreateInput = {
  name: string
  modelName?: 'issue' | 'project'
  description?: string
  color?: string
  icon?: string
  shared?: boolean
  filters?: unknown
  filterData?: unknown
  teamId?: string
  organizationId?: string
  subType?: string
  presentableCards?: unknown
}

export async function createCustomView(
  input: LinearCustomViewCreateInput,
  workspaceId?: string | null
): Promise<{ ok: true; customView: Record<string, unknown> } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }
  await acquire()
  try {
    const result = await entry.client.client.rawRequest<
      { customViewCreate?: { success?: boolean; customView?: Record<string, unknown> } },
      { input: LinearCustomViewCreateInput }
    >(CREATE_CUSTOM_VIEW_MUTATION, { input })
    const payload = result.data?.customViewCreate
    if (!payload?.success || !payload?.customView) {
      return { ok: false, error: 'Linear custom view create failed' }
    }
    return { ok: true, customView: payload.customView as Record<string, unknown> }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    release()
  }
}
