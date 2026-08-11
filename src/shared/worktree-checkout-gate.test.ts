import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'
import { createWorktreeCheckoutGate } from './worktree-checkout-gate'

function waitForCondition(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = (): void => {
      if (condition()) {
        resolve()
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('Timed out waiting for gate output'))
      } else {
        setTimeout(poll, 10)
      }
    }
    poll()
  })
}

describe('createWorktreeCheckoutGate', () => {
  it('holds a POSIX startup command behind an unguessable release line', () => {
    const gate = createWorktreeCheckoutGate({
      nonce: 'test-nonce',
      startupCommand: 'codex "do work"',
      platform: 'posix'
    })

    expect(gate.releaseInput).toBe('orca-worktree-gate-release:test-noncecodex "do work"\r')
    expect(gate.readyMarker).toBe('\x1b]777;orca-worktree-gate-ready:test-nonce\x07')
    expect(gate.releasedMarker).toBe('\x1b]777;orca-worktree-gate-released:test-nonce\x07')
    expect(gate.command).toContain('env BASH_ENV= ENV= bash --noprofile --norc -c')
    expect(Object.values(gate.env)).not.toContain('codex "do work"')
    expect(gate.env.ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT).toContain(
      'Terminal input is paused until the workspace is ready'
    )
    expect(gate.env.ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT).toContain(
      'IFS= read -r -n 1 orca_gate_input || continue'
    )
    expect(gate.env.ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT).toContain('stty -echo -icanon')
    expect(gate.env.ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT).toContain('orca-worktree-gate-released')
    expect(gate.env.ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT).toContain("trap '' INT QUIT TSTP")
  })

  it('returns to the interactive POSIX shell when no startup command exists', () => {
    const gate = createWorktreeCheckoutGate({
      nonce: 'blank-shell',
      platform: 'posix'
    })

    expect(gate.releaseInput).toBe('orca-worktree-gate-release:blank-shell')
    expect(gate.env.ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT).toContain('exit 0')
  })

  it('uses the POSIX gate for a Git Bash terminal on Windows', () => {
    const gate = createWorktreeCheckoutGate({
      nonce: 'git-bash',
      startupCommand: 'codex',
      platform: 'windows',
      shell: { family: 'posix' }
    })

    expect(gate.command).toContain('env BASH_ENV= ENV= bash --noprofile --norc -c')
  })

  it('encodes the native Windows gate without interpolating the startup command', () => {
    const gate = createWorktreeCheckoutGate({
      nonce: "native'nonce",
      startupCommand: 'codex; Write-Output injected',
      platform: 'windows',
      shell: { family: 'cmd' }
    })

    expect(gate.command).toMatch(/powershell\.exe .* -EncodedCommand /)
    expect(gate.command).not.toContain('injected')
    expect(gate.releaseInput).toBe(
      "orca-worktree-gate-release:native'noncecodex; Write-Output injected\r"
    )
    expect(gate.env).toEqual({})
    const encoded = gate.command.split(' ').at(-1) ?? ''
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(decoded).toContain("$release = 'orca-worktree-gate-release:native''nonce'")
    expect(decoded).toContain(
      'Preparing workspace. Terminal input is paused until the workspace is ready.'
    )
    expect(decoded).toContain('[Console]::ReadKey($true).KeyChar')
    expect(decoded).toContain('[Console]::Out.Write($ready)')
    expect(decoded).toContain('[Console]::Out.Write($released)')
    expect(decoded).not.toContain('injected')
    expect(decoded).not.toContain('$startup')
  })

  it('queues a PowerShell-authored startup for the original shell', () => {
    const gate = createWorktreeCheckoutGate({
      nonce: 'powershell',
      startupCommand: 'codex',
      platform: 'windows',
      shell: { family: 'cmd' }
    })

    const encoded = gate.command.split(' ').at(-1) ?? ''
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(gate.releaseInput).toBe('orca-worktree-gate-release:powershellcodex\r')
    expect(decoded).not.toContain('codex')
  })

  it.runIf(process.platform !== 'win32')(
    'returns startup to the interactive shell after project prompt hooks rerun',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-worktree-gate-shell-'))
      const rcfile = path.join(tempRoot, 'bashrc')
      writeFileSync(
        rcfile,
        [
          "PS1='orca-gate-test$ '",
          'orca_project_prompt() {',
          '  if [ -f AGENTS.md ]; then export ORCA_PROJECT_PROMPT_READY=ready; fi',
          '}',
          'PROMPT_COMMAND=orca_project_prompt'
        ].join('\n')
      )
      const gate = createWorktreeCheckoutGate({
        nonce: 'execution-test',
        startupCommand: 'printf \'startup:%s\\n\' "$ORCA_PROJECT_PROMPT_READY"',
        platform: 'posix'
      })
      const child = pty.spawn('bash', ['--noprofile', '--rcfile', rcfile, '-i'], {
        cols: 80,
        rows: 24,
        cwd: tempRoot,
        env: {
          ...process.env,
          ORCA_PROJECT_PROMPT_READY: '',
          ...gate.env
        } as Record<string, string>
      })
      let output = ''
      child.onData((data) => {
        output += data
      })

      try {
        await waitForCondition(() => output.includes('orca-gate-test$'))
        child.write(`${gate.command}\r`)
        await waitForCondition(() => output.includes(gate.readyMarker))
        child.write("printf 'premature-ran\\n'\r")
        await new Promise((resolve) => setTimeout(resolve, 40))
        expect(output).not.toContain('premature-ran')
        expect(output).not.toContain('startup:ready')

        writeFileSync(path.join(tempRoot, 'AGENTS.md'), '# ready\n')
        child.write(gate.releaseInput)
        await waitForCondition(
          () => output.includes(gate.releasedMarker) && output.includes('startup:ready')
        )
        expect(output).not.toContain('premature-ran')
        expect(output.match(/startup:ready/g)).toHaveLength(1)
      } finally {
        child.kill()
        rmSync(tempRoot, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')('exits a blank POSIX gate after release', async () => {
    const gate = createWorktreeCheckoutGate({ nonce: 'blank-environment', platform: 'posix' })
    const child = pty.spawn('bash', ['-c', gate.command], {
      cols: 80,
      rows: 24,
      env: { ...process.env, ...gate.env } as Record<string, string>
    })
    const exitCodePromise = new Promise<number>((resolve) => {
      child.onExit(({ exitCode }) => resolve(exitCode))
    })
    let output = ''
    child.onData((data) => {
      output += data
    })

    try {
      await waitForCondition(() => output.includes(gate.readyMarker))
      child.write(gate.releaseInput)
      await waitForCondition(() => output.includes(gate.releasedMarker))
      expect(await exitCodePromise).toBe(0)
    } finally {
      child.kill()
    }
  })

  it.runIf(process.platform !== 'win32')(
    'does not source BASH_ENV before gating input',
    async () => {
      const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-worktree-gate-env-'))
      const bashEnv = path.join(tempRoot, 'bash-env')
      writeFileSync(bashEnv, "printf 'bash-env-ran\\n'\n")
      const gate = createWorktreeCheckoutGate({ nonce: 'hostile-bash-env', platform: 'posix' })
      const child = pty.spawn('/bin/sh', ['-c', gate.command], {
        cols: 80,
        rows: 24,
        env: { ...process.env, BASH_ENV: bashEnv, ...gate.env } as Record<string, string>
      })
      const exitCodePromise = new Promise<number>((resolve) => {
        child.onExit(({ exitCode }) => resolve(exitCode))
      })
      let output = ''
      child.onData((data) => {
        output += data
      })

      try {
        await waitForCondition(() => output.includes(gate.readyMarker))
        expect(output).not.toContain('bash-env-ran')
        child.write(gate.releaseInput)
        await waitForCondition(() => output.includes(gate.releasedMarker))
        expect(await exitCodePromise).toBe(0)
      } finally {
        child.kill()
        rmSync(tempRoot, { recursive: true, force: true })
      }
    }
  )
})
