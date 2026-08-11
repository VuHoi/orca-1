import { describe, expect, it } from 'vitest'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'

function event(senderId: number) {
  return { sender: { id: senderId } } as never
}

describe('createSenderScopedRequestCancellations', () => {
  it('reports and aborts only a matching live sender request', () => {
    const requests = createSenderScopedRequestCancellations()
    const owner = event(1)
    const other = event(2)
    const controller = requests.begin(owner, 'create-1')

    expect(requests.cancel(other, 'create-1')).toBe(false)
    expect(controller?.signal.aborted).toBe(false)
    expect(requests.cancel(owner, 'missing')).toBe(false)
    expect(requests.cancel(owner, 'create-1')).toBe(true)
    expect(controller?.signal.aborted).toBe(true)

    requests.finish(owner, 'create-1', controller)
    expect(requests.cancel(owner, 'create-1')).toBe(false)
  })

  it('linearizes commit against cancellation', () => {
    const requests = createSenderScopedRequestCancellations()
    const owner = event(1)
    const committed = requests.begin(owner, 'committed')
    const cancelled = requests.begin(owner, 'cancelled')

    expect(requests.commit(owner, 'committed', committed)).toBe(true)
    expect(requests.cancel(owner, 'committed')).toBe(false)

    expect(requests.cancel(owner, 'cancelled')).toBe(true)
    expect(requests.commit(owner, 'cancelled', cancelled)).toBe(false)
  })
})
