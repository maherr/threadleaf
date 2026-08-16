# Generated plugin compatibility registry

This document is generated from [`compatibility/plugin-evidence.v1.json`](../../compatibility/plugin-evidence.v1.json).
Discovery in the external community package directory is separate from Threadleaf compatibility evidence.
A row applies only to the exact plugin and Threadleaf versions shown.

Registry schema: 1. Threadleaf version: 0.1.0-beta.6.

| Plugin | Plugin version | Threadleaf | Level | Evidence | Last tested |
| --- | --- | --- | ---: | --- | --- |
| [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | 2.25.3 | 0.1.0-beta.6 | 4 | composed | 2026-08-15 |
| [Threadleaf Compatibility Fixture](https://github.com/maherr/threadleaf) | 0.1.0 | 0.1.0-beta.6 | 4 | direct | 2026-08-15 |

## Excalidraw 2.25.3

Open, create, embed, SVG and PNG export, unload, reload, and plugin-owned settings workflows passed for this exact plugin release.

Bundle SHA-256: `684cf6da43f6e3b2a7646d5a50d14f7a43eb5d859d073dc6a375c4a1b0990dd6`. License: AGPL-3.0.

Required static authority review: `vault-read`, `vault-write`, `network`, `clipboard`, `external-navigation`, `editor-extension`, `workspace-ui`, `dynamic-code`.

### Supported workflows

- **Exact release discovery and package review** (passed)
  - `pnpm test:plugin-index-live` via [src/main/open-plugin-package-source.live.test.ts](../../src/main/open-plugin-package-source.live.test.ts)
  - `pnpm test:plugin-packages-e2e` via [scripts/check-plugin-packages-e2e.mjs](../../scripts/check-plugin-packages-e2e.mjs)
- **Open, change, save, close, and reopen a drawing** (passed)
  - `pnpm test` via [src/plugin-renderer/plugin-renderer-service.test.ts](../../src/plugin-renderer/plugin-renderer-service.test.ts)
- **Create a drawing, insert an embed, and export SVG and PNG** (passed)
  - `pnpm test` via [src/kernel/excalidraw-byte-compatibility.test.ts](../../src/kernel/excalidraw-byte-compatibility.test.ts)
  - `pnpm test` via [src/plugin-renderer/plugin-renderer-service.test.ts](../../src/plugin-renderer/plugin-renderer-service.test.ts)
- **Unload, reload, and use plugin-owned settings** (passed)
  - `pnpm test` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)
  - `pnpm test` via [src/plugin-renderer/plugin-renderer-service.test.ts](../../src/plugin-renderer/plugin-renderer-service.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Trusted desktop compatibility runtime only. The static capability report is a review aid, not a runtime sandbox.
- **macos-electron**: unverified. Packaged application coverage exists, but this plugin workflow is not verified on macOS.
- **windows-x64-electron**: unverified. Packaged application coverage exists, but this plugin workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- Inline wiki-embed rendering and export formats beyond SVG and PNG are not verified.
- The official Obsidian to Threadleaf to Obsidian byte-roundtrip remains unverified.
- The exact release check and host workflow checks are composed gates, not one monolithic end-to-end command.

## Threadleaf Compatibility Fixture 0.1.0

Activation, command execution, notice delivery, unload, reload, timeout isolation, and restart recovery passed for this exact fixture release.

Bundle SHA-256: `8450949c0c1989d68810b8e4d70c79bfd3e80cbf590785154a80baedd3860788`. License: AGPL-3.0-or-later.

Required static authority review: `workspace-ui`.

### Supported workflows

- **Activate, run a command, deliver a notice, unload, and reload** (passed)
  - `pnpm test` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)
- **Survive a sibling timeout and recover after restart** (passed)
  - `pnpm test:plugin-recovery` via [scripts/check-plugin-recovery.mjs](../../scripts/check-plugin-recovery.mjs)

### Platform limits

- **linux-x64-electron**: verified. Fixture coverage proves the compatibility host boundary, not arbitrary community plugins.
- **macos-electron**: packaged-only. The fixture is packaged but its complete workflow is not run on macOS CI.
- **windows-x64-electron**: packaged-only. The fixture is packaged but its complete workflow is not run on Windows CI.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- This repository-owned fixture intentionally exercises a narrow API surface.
- It is not listed in the external community package directory.

## Regeneration

Run `pnpm compatibility:generate` after updating reviewed evidence. `pnpm compatibility:check` validates schema, referenced gate paths, exact Threadleaf version binding, and generated-file drift without using the network.
