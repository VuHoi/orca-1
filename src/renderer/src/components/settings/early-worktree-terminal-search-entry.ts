import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getEarlyWorktreeTerminalSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.earlyWorktreeTerminal.title',
      'Early worktree terminal'
    ),
    description: translate(
      'auto.components.settings.experimental.search.earlyWorktreeTerminal.description',
      'Prepare the first terminal while a supported local Git worktree finishes checkout.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.earlyWorktreeTerminal.worktree',
        'worktree'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.earlyWorktreeTerminal.terminal',
        'terminal'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.earlyWorktreeTerminal.checkout',
        'checkout'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.earlyWorktreeTerminal.early',
        'early'
      )
    ]
  }
}
