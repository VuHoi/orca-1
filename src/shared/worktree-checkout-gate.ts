import { encodePowerShellCommand } from './powershell-command-encoding'
import type { SetupRunnerShell } from './setup-runner-command'

const GATE_SCRIPT_ENV = 'ORCA_WORKTREE_CHECKOUT_GATE_SCRIPT'
const GATE_NONCE_ENV = 'ORCA_WORKTREE_CHECKOUT_GATE_NONCE'
const GATE_RELEASE_PREFIX = 'orca-worktree-gate-release:'

export const WORKTREE_CHECKOUT_GATE_READY_TIMEOUT_MS = 10_000
export const WORKTREE_CHECKOUT_GATE_RELEASE_TIMEOUT_MS = 5_000

export type WorktreeCheckoutGate = {
  command: string
  env: Record<string, string>
  releaseInput: string
  readyMarker: string
  releasedMarker: string
}

export function createWorktreeCheckoutGate(args: {
  nonce: string
  startupCommand?: string
  platform: 'windows' | 'posix'
  shell?: SetupRunnerShell
}): WorktreeCheckoutGate {
  const releaseToken = `${GATE_RELEASE_PREFIX}${args.nonce}`
  // Why: the parent shell reruns project prompt hooks before reading bytes queued after the token.
  const releaseInput = args.startupCommand
    ? `${releaseToken}${args.startupCommand}\r`
    : releaseToken
  const readyMarker = createGateMarker('ready', args.nonce)
  const releasedMarker = createGateMarker('released', args.nonce)
  if (args.platform === 'windows' && args.shell?.family !== 'posix') {
    return {
      command: createWindowsGateCommand({
        releaseToken,
        readyMarker,
        releasedMarker
      }),
      env: {},
      releaseInput,
      readyMarker,
      releasedMarker
    }
  }

  const script = createPosixGateScript()
  return {
    command: `env BASH_ENV= ENV= bash --noprofile --norc -c 'eval "$${GATE_SCRIPT_ENV}"'`,
    env: {
      [GATE_SCRIPT_ENV]: script,
      [GATE_NONCE_ENV]: args.nonce
    },
    releaseInput,
    readyMarker,
    releasedMarker
  }
}

function createPosixGateScript(): string {
  return [
    `orca_gate_nonce="$${GATE_NONCE_ENV}";`,
    'orca_gate_release=$(printf \'orca-worktree-gate-release:%s\' "$orca_gate_nonce");',
    'orca_gate_stty=$(stty -g 2>/dev/null) || exit 1;',
    'stty -echo -icanon min 1 time 0 2>/dev/null || exit 1;',
    'orca_gate_restore() { stty "$orca_gate_stty" 2>/dev/null || true; };',
    "trap 'orca_gate_restore' EXIT; trap '' INT QUIT TSTP;",
    'echo "Preparing workspace. Terminal input is paused until the workspace is ready." >&2;',
    'printf \'\\033]777;orca-worktree-gate-ready:%s\\007\' "$orca_gate_nonce";',
    "orca_gate_buffer='';",
    'while true; do',
    'IFS= read -r -n 1 orca_gate_input || continue;',
    'orca_gate_buffer="${orca_gate_buffer}${orca_gate_input}";',
    'if [ "${#orca_gate_buffer}" -gt "${#orca_gate_release}" ]; then',
    'orca_gate_buffer="${orca_gate_buffer: -${#orca_gate_release}}";',
    'fi;',
    'if [ "$orca_gate_buffer" = "$orca_gate_release" ]; then',
    `unset ${GATE_SCRIPT_ENV} ${GATE_NONCE_ENV};`,
    'orca_gate_restore; trap - EXIT INT QUIT TSTP;',
    'printf \'\\033]777;orca-worktree-gate-released:%s\\007\' "$orca_gate_nonce";',
    'exit 0;',
    'fi;',
    'done;'
  ].join(' ')
}

function createWindowsGateCommand(args: {
  releaseToken: string
  readyMarker: string
  releasedMarker: string
}): string {
  const script = [
    `$release = ${quotePowerShellString(args.releaseToken)}`,
    `$ready = ${quotePowerShellString(args.readyMarker)}`,
    `$released = ${quotePowerShellString(args.releasedMarker)}`,
    '$previousControlCAsInput = [Console]::TreatControlCAsInput',
    '$didRelease = $false',
    'try {',
    '  [Console]::TreatControlCAsInput = $true',
    '  [Console]::Error.WriteLine("Preparing workspace. Terminal input is paused until the workspace is ready.")',
    '  [Console]::Out.Write($ready)',
    '  $gateBuffer = ""',
    '  while ($true) {',
    '    $gateBuffer += [Console]::ReadKey($true).KeyChar',
    '    if ($gateBuffer.Length -gt $release.Length) {',
    '      $gateBuffer = $gateBuffer.Substring($gateBuffer.Length - $release.Length)',
    '    }',
    '    if ($gateBuffer -cne $release) { continue }',
    '    $didRelease = $true',
    '    break',
    '  }',
    '} finally {',
    '  [Console]::TreatControlCAsInput = $previousControlCAsInput',
    '}',
    'if (-not $didRelease) { exit 1 }',
    '[Console]::Out.Write($released)',
    'exit 0'
  ].join('; ')
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`
}

function createGateMarker(state: 'ready' | 'released', nonce: string): string {
  return `\x1b]777;orca-worktree-gate-${state}:${nonce}\x07`
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
