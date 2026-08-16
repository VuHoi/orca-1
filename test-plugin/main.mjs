// Probe plugin worker: seeds storage with a value so the panel can read it back
// over the bridge — proving the storage.get panel:true patch end to end.
export default function activate(orca) {
  orca.commands.register('probe.seed', async (args) => {
    const key = typeof args?.key === 'string' ? args.key : 'probe.key'
    const stored = await orca.host.call('storage.get', { key })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await orca.host.call('storage.set', { key, value: count })
    return { seeded: true, key, count }
  })
}
