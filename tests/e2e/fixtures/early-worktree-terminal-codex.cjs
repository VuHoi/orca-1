const { appendFileSync, readFileSync } = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
if (args.includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\n")
  process.exit(2)
}
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
  process.stdout.write('codex-cli 0.0.0-e2e\n')
  process.exit(0)
}

const ledgerPath = process.env.ORCA_E2E_EARLY_CODEX_LEDGER
if (!ledgerPath) {
  process.stderr.write('fake Codex is missing ORCA_E2E_EARLY_CODEX_LEDGER\n')
  process.exit(3)
}

const cwd = process.cwd()
let agentsInstructions
try {
  agentsInstructions = readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8').trim()
} catch (error) {
  process.stderr.write(`fake Codex could not read tracked AGENTS.md: ${error.message}\n`)
  process.exit(4)
}

const appendEvent = (event) => appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`)
appendEvent({ event: 'start', pid: process.pid, cwd, args, agentsInstructions })
process.stdout.write(`EARLY_CODEX_AGENTS:${agentsInstructions.replace(/\s+/g, ' ')}\n`)

let inputBuffer = ''
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString()
  const lines = inputBuffer.split(/[\r\n]+/)
  inputBuffer = lines.pop() ?? ''
  for (const value of lines) {
    if (!value) {
      continue
    }
    appendEvent({ event: 'input', pid: process.pid, value })
    process.stdout.write(`EARLY_CODEX_INPUT:${value}\n`)
  }
})
process.stdin.resume()
setInterval(() => {}, 60_000)
