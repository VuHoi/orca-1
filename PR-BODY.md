## ELI5

Plugin panels (the little side-panel UIs plugins can ship) currently can't read any data — they can only send text to terminals and show notifications. This change lets a panel read data that its own plugin's worker process has saved, so panels can finally display dynamic content.

## What Changed

One flag flip in the host API spec table: `storage.get` becomes callable from sandboxed panels (`panel: false` → `panel: true`).

That's the entire diff. Because `PLUGIN_PANEL_ACTIONS` (the panel-bridge allowlist) is derived from the spec table via `.filter(entry => entry.panel)`, no other file changes: the existing zod validation, session-token verification, rate limiting, and capability consent all apply unchanged.

## Why

The panel bridge is deliberately a closed transport — only `workspace.readContext`, `terminal.sendText`, `notifications.show` are panel-callable today. That's the right security posture, but it has a side effect: **a panel can never display dynamic data**, even data produced by its own worker. The only "output" channel a panel has is typing text into a terminal.

Workers, by contrast, have full Node access (they can shell out to CLIs, fetch, etc.) and can already write results to plugin-private storage. Opening *read-only* `storage.get` to the panel closes the loop:

```
worker (Node, no CSP) ──storage.set──► plugin-private KV ──storage.get──► panel iframe (render)
```

Threat-model analysis for why this specific method is safe to expose:

- **Read-only**: `mutation: false`. `storage.set`/`storage.delete` stay worker-only.
- **Plugin-private scope**: the storage binding keys by `pluginId` — a panel can only read values its *own* plugin wrote, never another plugin's.
- **No new capability surface**: still gated behind the existing `storage` capability consent.
- **Same bridge protections as existing actions**: session-token binding (32–128 chars, issued at panel load), 64 KB message cap, 30-msg/10s rate limit, zod-validated params.
- **Size-bounded**: storage values are already capped at 256 KB per key by the store itself.

Concrete use case that motivated this: a plugin whose worker polls `orca linear list-issues` and renders the team's task list in its panel. Today that's impossible without workarounds (external HTTP server, patching the app). There is an existing feature request in this direction (`examples/plugins/*/FEATURE-REQUEST-panel-filesystem.md` bundled with the superpowers-launcher plugin asks for panel file reads — this is a strictly smaller ask that covers a large subset of the need).

## Linked Issue

Fixes # (none open at time of writing — happy to link one if maintainers prefer an issue first)

## Visual Proof

N/A — no UI change in the app itself; host API surface only. Verified via a probe plugin: worker writes a counter via `storage.set`, panel reads it back over the bridge (`storage.get` returns the seeded value; before the patch the same call returns `unknown_method`).

## Testing

- [x] Manually tested locally: probe plugin on `pnpm dev` (macOS) — panel `storage.get` returns the worker-seeded value end-to-end
- [x] Verified `PLUGIN_PANEL_ACTIONS` picks up the change with no other edits (derived from the same spec table)
- [ ] Automated tests: existing panel-bridge tests assert the action allowlist against the spec table (they cover the addition); no new test added since no new behavior branch exists beyond the flag — maintainers' call if a fixture asserting `storage.get ∈ PLUGIN_PANEL_ACTIONS` is wanted

Platforms: tested macOS (dev build). The change is platform-neutral (shared spec table, no platform-specific code paths). SSH/remote unaffected (plugin storage is local to the app host).

## AI Disclosure

Claude (Anthropic) assisted with repo exploration, the security analysis above, and PR drafting; the change itself and verification were reviewed and validated by the contributor.

## Review

- Security: read-only method, plugin-private scope, existing consent + rate-limit + session-token protections apply — analyzed above.
- Cross-platform: no platform-specific code touched.
- Remote SSH: no interaction (plugin storage is host-local).
- Backwards compatibility: purely additive — plugins that don't call `storage.get` from panels are unaffected; existing panel actions unchanged.
- Performance: no hot-path changes; one extra entry in an allowlist filter at module load.

## Checklist

- [x] This PR is small and focused (1 line)
- [x] I explained what changed and why (including ELI5)
- [x] No UI change — N/A visual proof with reason
- [x] Self-reviewed for correctness, security, and performance
- [x] Cross-platform, SSH/remote impact considered (N/A, reasoned above)
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` — not run locally yet; CI will cover (single-flag change in a typed spec table)

## Author

X / Twitter: @VuHoi
