import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import {
  closeActiveTerminalPane,
  countVisibleTerminalPanes,
  focusActiveTerminalInput,
  readPaneIdentitySnapshot,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'

const AGENTS_INSTRUCTIONS = 'EARLY_WORKTREE_AGENT_INSTRUCTIONS'
const PAUSED_MESSAGE = 'Preparing workspace. Terminal input is paused until the workspace is ready.'
const PRE_RELEASE_INPUT = 'PRE_RELEASE_INPUT_MUST_BE_IGNORED'
const POST_RELEASE_INPUT = 'POST_RELEASE_INPUT_REACHED_CODEX'
const BARRIER_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'worktree-checkout-smudge-barrier.cjs'
)
const FAKE_CODEX_SCRIPT = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'early-worktree-terminal-codex.cjs'
)

type EarlyWorktreeFixture = {
  rootPath: string
  repoPath: string
  worktreeBasePath: string
  fakeBinPath: string
  fakeCodexScriptPath: string
  gitConfigPath: string
  barrierEnteredPath: string
  barrierReleasePath: string
  barrierFailurePath: string
  codexLedgerPath: string
}

type CodexLedgerEvent =
  | {
      event: 'start'
      pid: number
      cwd: string
      args: string[]
      agentsInstructions: string
    }
  | { event: 'input'; pid: number; value: string }

function isolatedFixtureGitEnvironment(gitConfigPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
}

function configureFixtureGit(rootPath: string): string {
  const gitConfigPath = path.join(rootPath, 'gitconfig')
  const gitHooksPath = path.join(rootPath, 'git-hooks')
  mkdirSync(gitHooksPath)
  const environment = isolatedFixtureGitEnvironment(gitConfigPath)
  for (const [key, value] of [
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['core.hooksPath', gitHooksPath]
  ]) {
    execFileSync('git', ['config', '--file', gitConfigPath, key, value], {
      cwd: rootPath,
      env: environment,
      stdio: 'pipe'
    })
  }
  return gitConfigPath
}

function git(repoPath: string, args: string[], gitConfigPath: string): void {
  execFileSync('git', args, {
    cwd: repoPath,
    env: isolatedFixtureGitEnvironment(gitConfigPath),
    stdio: 'pipe'
  })
}

function quoteGitFilterArg(value: string): string {
  const escaped = value
    .replaceAll('\\', '/')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`')
  return `"${escaped}"`
}

function installFakeCodex(fakeBinPath: string): void {
  const copiedScript = path.join(fakeBinPath, 'early-worktree-terminal-codex.cjs')
  copyFileSync(FAKE_CODEX_SCRIPT, copiedScript)
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(fakeBinPath, 'codex.cmd'),
      '@echo off\r\nnode "%~dp0\\early-worktree-terminal-codex.cjs" %*\r\n'
    )
    return
  }
  const executable = path.join(fakeBinPath, 'codex')
  writeFileSync(executable, '#!/usr/bin/env node\nrequire("./early-worktree-terminal-codex.cjs")\n')
  chmodSync(executable, 0o755)
}

function quoteAgentCommandPath(value: string): string {
  return process.platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'\\''`)}'`
}

function getFakeCodexCommand(scriptPath: string): string {
  const command = `${quoteAgentCommandPath(process.execPath)} ${quoteAgentCommandPath(scriptPath)}`
  return process.platform === 'win32' ? `& ${command}` : command
}

function createEarlyWorktreeFixture(): EarlyWorktreeFixture {
  const rootPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-early-terminal-')))
  try {
    const repoPath = path.join(rootPath, 'source')
    const worktreeBasePath = path.join(rootPath, 'worktrees')
    const fakeBinPath = path.join(rootPath, 'bin')
    const gitConfigPath = configureFixtureGit(rootPath)
    const fixture = {
      rootPath,
      repoPath,
      worktreeBasePath,
      fakeBinPath,
      fakeCodexScriptPath: path.join(fakeBinPath, 'early-worktree-terminal-codex.cjs'),
      gitConfigPath,
      barrierEnteredPath: path.join(rootPath, 'checkout-entered'),
      barrierReleasePath: path.join(rootPath, 'checkout-release'),
      barrierFailurePath: path.join(rootPath, 'checkout-failure'),
      codexLedgerPath: path.join(rootPath, 'codex-ledger.jsonl')
    }
    mkdirSync(repoPath)
    mkdirSync(worktreeBasePath)
    mkdirSync(fakeBinPath)
    installFakeCodex(fakeBinPath)

    git(repoPath, ['init'], gitConfigPath)
    git(repoPath, ['checkout', '-b', 'main'], gitConfigPath)
    git(repoPath, ['config', 'user.email', 'e2e@test.local'], gitConfigPath)
    git(repoPath, ['config', 'user.name', 'Orca E2E'], gitConfigPath)
    writeFileSync(path.join(repoPath, '.gitattributes'), 'AGENTS.md filter=orca-e2e-barrier\n')
    writeFileSync(path.join(repoPath, 'AGENTS.md'), `${AGENTS_INSTRUCTIONS}\n`)
    writeFileSync(path.join(repoPath, 'README.md'), '# Early worktree terminal E2E\n')
    git(repoPath, ['add', '.'], gitConfigPath)
    git(repoPath, ['commit', '-m', 'Seed early terminal fixture'], gitConfigPath)

    const smudgeCommand = `${quoteGitFilterArg(process.execPath)} ${quoteGitFilterArg(BARRIER_SCRIPT)}`
    git(repoPath, ['config', 'filter.orca-e2e-barrier.smudge', smudgeCommand], gitConfigPath)
    git(repoPath, ['config', 'filter.orca-e2e-barrier.required', 'true'], gitConfigPath)
    return fixture
  } catch (error) {
    rmSync(rootPath, { recursive: true, force: true })
    throw error
  }
}

function releaseCheckout(fixture: EarlyWorktreeFixture): void {
  if (existsSync(fixture.rootPath)) {
    writeFileSync(fixture.barrierReleasePath, 'release\n')
  }
}

function failCheckout(fixture: EarlyWorktreeFixture): void {
  writeFileSync(fixture.barrierFailurePath, 'fail\n')
  releaseCheckout(fixture)
}

function readCodexLedger(ledgerPath: string): CodexLedgerEvent[] {
  if (!existsSync(ledgerPath)) {
    return []
  }
  return readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CodexLedgerEvent)
}

async function registerFixtureRepo(page: Page, fixture: EarlyWorktreeFixture): Promise<void> {
  const { worktreeBasePath } = fixture
  const repoId = await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, fixture.repoPath)

  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ repoId, worktreeBasePath, agentCommand, codexLedgerPath, isWindows }) => {
            const store = window.__store
            if (!store) {
              return false
            }
            await store.getState().fetchRepos()
            const repo = store.getState().repos.find((candidate) => candidate.id === repoId)
            if (!repo) {
              return false
            }
            await store.getState().updateRepo(repoId, { worktreeBasePath })
            await store.getState().updateSettings({
              agentCmdOverrides: { codex: agentCommand },
              agentDefaultEnv: {
                codex: { ORCA_E2E_EARLY_CODEX_LEDGER: codexLedgerPath }
              },
              disabledTuiAgents: [],
              experimentalEarlyWorktreeTerminal: true,
              ...(isWindows ? { terminalWindowsShell: 'powershell.exe' } : {})
            })
            await store.getState().fetchWorktrees(repoId)
            const mainWorktree = store
              .getState()
              .worktreesByRepo[repoId]?.find((worktree) => worktree.isMainWorktree)
            if (!mainWorktree) {
              return false
            }
            store.getState().setActiveWorktree(mainWorktree.id)
            return true
          },
          {
            repoId,
            worktreeBasePath,
            agentCommand: getFakeCodexCommand(fixture.fakeCodexScriptPath),
            codexLedgerPath: fixture.codexLedgerPath,
            isWindows: process.platform === 'win32'
          }
        ),
      { timeout: 30_000, message: 'Disposable early-terminal repo did not become active' }
    )
    .toBe(true)
  await waitForProviderBackedActivePane(page)
}

async function selectCodexInComposer(
  page: Page,
  dialog: ReturnType<Page['getByRole']>
): Promise<void> {
  const agentCombobox = dialog.locator('[data-agent-combobox-root="true"][role="combobox"]')
  await agentCombobox.click()
  await page.getByPlaceholder('Search agents...').fill('Codex')
  await page.getByRole('option', { name: /^Codex\b/ }).click()
  await expect(agentCombobox).toContainText('Codex')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type ListedPty = { id: string; cwd: string }

type SpawnProbeWindow = Window & {
  __earlyWorktreeSpawnProbe?: { ids: string[]; unsubscribe: () => void }
}

async function listPtys(page: Page): Promise<ListedPty[]> {
  return page.evaluate(async () => {
    const sessions = await window.api.pty.listSessions()
    return sessions
      .map(({ id, cwd }) => ({ id, cwd }))
      .sort((left, right) => left.id.localeCompare(right.id))
  })
}

async function waitForProviderBackedActivePane(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPaneIdentitySnapshot(page)
        const ptyId = snapshot?.panes[0]?.ptyId
        return Boolean(ptyId && (await listPtys(page)).some(({ id }) => id === ptyId))
      },
      { timeout: 30_000, message: 'Fixture main terminal did not reach the PTY provider' }
    )
    .toBe(true)
}

async function armPtySpawnProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as SpawnProbeWindow
    const previous = target.__earlyWorktreeSpawnProbe
    delete target.__earlyWorktreeSpawnProbe
    previous?.unsubscribe()
    const ids: string[] = []
    target.__earlyWorktreeSpawnProbe = {
      ids,
      unsubscribe: window.api.pty.onSpawned(({ id }) => ids.push(id))
    }
  })
}

async function spawnedPtyIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as SpawnProbeWindow).__earlyWorktreeSpawnProbe?.ids ?? [])
  ])
}

async function disarmPtySpawnProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as SpawnProbeWindow
    const probe = target.__earlyWorktreeSpawnProbe
    delete target.__earlyWorktreeSpawnProbe
    probe?.unsubscribe()
  })
}

async function expectNoSiblingPty(page: Page, baselineSessions: ListedPty[]): Promise<void> {
  const baselineIds = baselineSessions.map(({ id }) => id)
  expect((await listPtys(page)).map(({ id }) => id)).toEqual(baselineIds)
  expect((await spawnedPtyIds(page)).filter((id) => !baselineIds.includes(id))).toEqual([])
}

async function exerciseBlockedTerminalActions(
  page: Page,
  baselineSessions: ListedPty[]
): Promise<void> {
  const bootstrap = await readPaneIdentitySnapshot(page)
  expect(bootstrap?.panes).toHaveLength(1)
  expect(bootstrap?.panes[0]?.ptyId).toBeTruthy()
  expect(baselineSessions.some(({ id }) => id === bootstrap?.panes[0]?.ptyId)).toBe(true)
  await armPtySpawnProbe(page)
  try {
    const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control'
    const splitShortcut =
      process.platform === 'darwin' ? `${primaryModifier}+d` : `${primaryModifier}+Shift+d`
    await focusActiveTerminalInput(page)
    await page.keyboard.press(splitShortcut)
    await waitForPaneCount(page, 2)
    await expect(page.getByText(/This workspace is still being prepared/).last()).toBeVisible()
    await expectNoSiblingPty(page, baselineSessions)

    await closeActiveTerminalPane(page)
    await expect.poll(() => countVisibleTerminalPanes(page)).toBe(1)

    const tabs = page.locator('[data-testid="sortable-tab"]')
    const tabIdsBefore = await tabs.evaluateAll((elements) =>
      elements
        .map((element) => element.getAttribute('data-tab-id'))
        .filter((id): id is string => id !== null)
    )
    const tabCountBefore = await tabs.count()
    await focusActiveTerminalInput(page)
    await page.keyboard.press(`${primaryModifier}+t`)
    await expect.poll(() => tabs.count()).toBe(tabCountBefore + 1)
    await expect(page.getByText(/This workspace is still being prepared/).last()).toBeVisible()
    await expectNoSiblingPty(page, baselineSessions)

    const createdTabIds = (
      await tabs.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-tab-id'))
      )
    ).filter((id): id is string => id !== null && !tabIdsBefore.includes(id))
    expect(createdTabIds).toHaveLength(1)
    await page
      .locator(`[data-testid="sortable-tab"][data-tab-id="${createdTabIds[0]}"]`)
      .locator('[data-tab-close-button="true"]')
      .click({ force: true })
    await expect.poll(() => tabs.count()).toBe(tabCountBefore)
    await expect(
      page.locator(`[data-testid="sortable-tab"][data-tab-id="${bootstrap?.tabId}"]`)
    ).toHaveAttribute('data-active', 'true')
  } finally {
    await disarmPtySpawnProbe(page)
  }
}

const test = base.extend<{ earlyWorktreeFixture: EarlyWorktreeFixture }>({
  earlyWorktreeFixture: async ({ registerPostElectronShutdownCleanup }, provideFixture) => {
    const fixture = createEarlyWorktreeFixture()
    registerPostElectronShutdownCleanup(async () => {
      releaseCheckout(fixture)
      await rm(fixture.rootPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      })
    })
    await provideFixture(fixture)
  },
  launchEnv: async ({ earlyWorktreeFixture }, provideFixture) => {
    const inheritedPath = process.env.PATH ?? process.env.Path ?? ''
    await provideFixture({
      PATH: `${earlyWorktreeFixture.fakeBinPath}${path.delimiter}${inheritedPath}`,
      GIT_CONFIG_GLOBAL: earlyWorktreeFixture.gitConfigPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ORCA_E2E_CHECKOUT_BARRIER_ENTERED: earlyWorktreeFixture.barrierEnteredPath,
      ORCA_E2E_CHECKOUT_BARRIER_RELEASE: earlyWorktreeFixture.barrierReleasePath,
      ORCA_E2E_CHECKOUT_BARRIER_FAILURE: earlyWorktreeFixture.barrierFailurePath,
      ORCA_E2E_CHECKOUT_BARRIER_TIMEOUT_MS: '90000',
      ORCA_E2E_EARLY_CODEX_LEDGER: earlyWorktreeFixture.codexLedgerPath
    })
  }
})

test.use({ seedTestRepo: false })
test.afterEach(async ({ earlyWorktreeFixture }) => releaseCheckout(earlyWorktreeFixture))

test('starts one real xterm before checkout and gates Codex input until release', async ({
  orcaPage,
  earlyWorktreeFixture
}) => {
  await registerFixtureRepo(orcaPage, earlyWorktreeFixture)
  const workspaceName = `early-terminal-${Date.now()}`
  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(workspaceName)
  await selectCodexInComposer(orcaPage, dialog)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  const pendingRow = orcaPage
    .getByRole('button', {
      name: new RegExp(`${escapeRegExp(workspaceName)}\\s+Creating worktree`)
    })
    .first()

  try {
    await expect
      .poll(() => existsSync(earlyWorktreeFixture.barrierEnteredPath), {
        timeout: 30_000,
        message: 'Git checkout never entered the tracked-file smudge barrier'
      })
      .toBe(true)
    await expect(pendingRow).toBeVisible()
    await expect(pendingRow).toContainText('Creating worktree…')
    await waitForTerminalOutput(orcaPage, PAUSED_MESSAGE, 20_000)
    expect(readCodexLedger(earlyWorktreeFixture.codexLedgerPath)).toEqual([])

    const baselineSessions = await listPtys(orcaPage)
    await exerciseBlockedTerminalActions(orcaPage, baselineSessions)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type(PRE_RELEASE_INPUT)
    await orcaPage.keyboard.press('Enter')
    await expect(pendingRow).toContainText('Creating worktree…')
    expect(readCodexLedger(earlyWorktreeFixture.codexLedgerPath)).toEqual([])
  } finally {
    releaseCheckout(earlyWorktreeFixture)
  }

  await waitForTerminalOutput(orcaPage, `EARLY_CODEX_AGENTS:${AGENTS_INSTRUCTIONS}`, 30_000)
  await expect(pendingRow).toHaveCount(0, { timeout: 30_000 })
  await expect
    .poll(
      () =>
        readCodexLedger(earlyWorktreeFixture.codexLedgerPath).filter(
          (event) => event.event === 'start'
        ).length,
      { timeout: 10_000, message: 'Fake Codex did not start exactly once after checkout' }
    )
    .toBe(1)

  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type(POST_RELEASE_INPUT)
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, `EARLY_CODEX_INPUT:${POST_RELEASE_INPUT}`, 10_000)

  const events = readCodexLedger(earlyWorktreeFixture.codexLedgerPath)
  const starts = events.filter((event) => event.event === 'start')
  const inputs = events.filter((event) => event.event === 'input').map((event) => event.value)
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ agentsInstructions: AGENTS_INSTRUCTIONS })
  expect(inputs).not.toContain(PRE_RELEASE_INPUT)
  expect(inputs).toContain(POST_RELEASE_INPUT)
})

test('tears down the bootstrap PTY before rolling back a failed checkout', async ({
  orcaPage,
  earlyWorktreeFixture
}) => {
  await registerFixtureRepo(orcaPage, earlyWorktreeFixture)
  const sessionsBeforeCreate = await listPtys(orcaPage)
  const baselineIds = sessionsBeforeCreate.map(({ id }) => id)
  const workspaceName = `early-terminal-rollback-${Date.now()}`
  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await dialog.getByPlaceholder(/Type a name/i).fill(workspaceName)
  await selectCodexInComposer(orcaPage, dialog)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })
  const pendingRow = orcaPage
    .getByRole('button', { name: new RegExp(escapeRegExp(workspaceName)) })
    .first()

  try {
    await expect
      .poll(() => existsSync(earlyWorktreeFixture.barrierEnteredPath), { timeout: 30_000 })
      .toBe(true)
    await waitForTerminalOutput(orcaPage, PAUSED_MESSAGE, 20_000)
    const sessionsDuringCreate = await listPtys(orcaPage)
    const bootstrapSessions = sessionsDuringCreate.filter(({ id }) => !baselineIds.includes(id))
    expect(bootstrapSessions).toHaveLength(1)
    const bootstrapCwd = bootstrapSessions[0]!.cwd
    expect(path.resolve(bootstrapCwd)).toBe(
      path.resolve(
        earlyWorktreeFixture.worktreeBasePath,
        path.basename(earlyWorktreeFixture.repoPath),
        workspaceName
      )
    )
    expect(existsSync(bootstrapCwd)).toBe(true)
    await exerciseBlockedTerminalActions(orcaPage, sessionsDuringCreate)

    failCheckout(earlyWorktreeFixture)
    await expect(pendingRow).toContainText(/fail|error/i, { timeout: 30_000 })
    await expect
      .poll(async () => (await listPtys(orcaPage)).map(({ id }) => id), { timeout: 30_000 })
      .toEqual(baselineIds)
    await expect.poll(() => existsSync(bootstrapCwd), { timeout: 30_000 }).toBe(false)
    expect(readCodexLedger(earlyWorktreeFixture.codexLedgerPath)).toEqual([])
    await expect(pendingRow).toBeVisible()
  } finally {
    releaseCheckout(earlyWorktreeFixture)
  }
})
