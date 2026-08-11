# Threadleaf

> Your vault, on an open runtime.

Threadleaf is an early-stage, fully open, local-first knowledge workspace. Its central goal is to
open existing Markdown vaults without conversion and provide meaningful compatibility with the
community plugins people already depend on.

Threadleaf is not affiliated with or endorsed by Obsidian.

## Status

Threadleaf is pre-alpha. Its Phase 0 architecture proof now loads an unchanged CommonJS fixture
plugin, provides it with an independently implemented `obsidian` compatibility module, registers a
command, and exercises that command through an isolated Electron renderer. The fixture completes
the documented load, activation, integration, command, reload, and unload lifecycles.

Do not use the current build with an important vault. Phase 0 uses only a synthetic fixture vault
and implements no user-file writes.

## Product promises

- Open an existing Markdown vault without converting its content.
- Keep application state separate from `.obsidian/`.
- Make compatibility measurable instead of relying on vague claims.
- Treat the filesystem as authoritative and every index as rebuildable.
- Make every future write atomic, recoverable, and visible.
- Support existing trusted plugins while developing a safer capability-based native extension API.
- Remain useful offline without an account, subscription, or hosted service.

## Project map

- [Project charter](docs/charter.md)
- [Architecture](docs/architecture.md)
- [Compatibility contract](docs/compatibility/contract.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Development

Threadleaf currently requires Node.js 22 or newer and pnpm.

```sh
pnpm install
pnpm check
pnpm start
```

The executable build opens the bundled synthetic vault. It does not yet expose a vault picker or
accept an arbitrary filesystem path. `pnpm check` also verifies that the packaged Electron entry
points exist and that renderer assets remain loadable over `file://`.

## License

The application core is licensed under `AGPL-3.0-or-later`. A future standalone extension SDK may
use a permissive license so plugins can target Threadleaf without inheriting the application's
license.
