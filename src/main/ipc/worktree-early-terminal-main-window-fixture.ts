import { vi, type Mock } from 'vitest'

export type TestMainWindow = { isDestroyed: () => boolean; webContents: { send: Mock } }

export function makeMainWindow(): TestMainWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
}
