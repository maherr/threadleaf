# Threadleaf

> Your vault, on an open runtime.

Threadleaf is an early-stage, fully open, local-first knowledge workspace. Its central goal is to
open existing Markdown vaults without conversion and provide meaningful compatibility with the
community plugins people already depend on.

Threadleaf is not affiliated with or endorsed by Obsidian.

## Status

Threadleaf is pre-alpha. Its Phase 0 architecture proof loads an unchanged CommonJS fixture
plugin, provides it with an independently implemented `obsidian` compatibility module, registers a
command, and exercises that command through an isolated Electron renderer. The fixture completes
the documented load, activation, integration, command, reload, and unload lifecycles.

Phase 1 is complete. The vault kernel proves canonical path containment,
durable recovery journals, external-edit conflict preservation, serialized writes, and recoverable
renames against filesystem fixtures. A sequenced live watcher and rebuildable metadata index now
converge across internal writes, external edits, renames, conflicts, event gaps, and backend
fallbacks. Multi-file operations durably retain every proposal and resume safely after interruption.

Phase 2 is in progress. The production runtime now composes that kernel, watcher, index, one shared
action registry, and the compatibility host. The Electron workspace can navigate the bundled
fixture, inspect Markdown source, headings, tags, links, and backlinks, filter notes from the
keyboard, and reflect external changes without giving the renderer filesystem access.

Do not use the current build with an important vault. It still opens only a bundled synthetic
fixture and exposes neither an arbitrary vault picker nor an editing control.

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
- [FOSS alternatives landscape review](docs/research/alternatives-landscape.md)
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
