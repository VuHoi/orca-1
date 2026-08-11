const { existsSync, writeFileSync } = require('node:fs')

const enteredPath = process.env.ORCA_E2E_CHECKOUT_BARRIER_ENTERED
const releasePath = process.env.ORCA_E2E_CHECKOUT_BARRIER_RELEASE
const failurePath = process.env.ORCA_E2E_CHECKOUT_BARRIER_FAILURE
const timeoutMs = Number(process.env.ORCA_E2E_CHECKOUT_BARRIER_TIMEOUT_MS ?? 90_000)

if (!enteredPath || !releasePath || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write('worktree checkout barrier is missing its marker configuration\n')
  process.exit(2)
}

const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('error', (error) => {
  process.stderr.write(`worktree checkout barrier stdin failed: ${error.message}\n`)
  process.exit(3)
})
process.stdin.on('end', () => {
  writeFileSync(enteredPath, `${process.pid}\n`)
  const deadline = Date.now() + timeoutMs

  const release = () => {
    if (existsSync(releasePath)) {
      if (failurePath && existsSync(failurePath)) {
        process.stderr.write('worktree checkout barrier forced failure\n')
        process.exit(5)
      }
      process.stdout.write(Buffer.concat(chunks))
      return
    }
    if (Date.now() >= deadline) {
      process.stderr.write('worktree checkout barrier timed out waiting for release\n')
      process.exit(4)
    }
    setTimeout(release, 20)
  }

  release()
})
process.stdin.resume()
