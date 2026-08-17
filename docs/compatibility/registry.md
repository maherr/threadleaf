# Generated plugin compatibility registry

This document is generated from the versioned receipt-aware source [`compatibility/plugin-evidence.v1.json`](../../compatibility/plugin-evidence.v1.json).
Discovery in the external community package directory is separate from Threadleaf compatibility evidence.
A row applies only to the exact plugin and Threadleaf versions shown.

Registry schema: 2. Threadleaf version: 0.1.0-beta.7. Generation: 1eac9d5437e12847d4464f3983ff5e64b8473e5c3522b79e85d0861d3c7cf2f9.

| Plugin | Plugin version | Threadleaf | Level | Evidence | Last tested |
| --- | --- | --- | ---: | --- | --- |
| [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | 2.25.3 | 0.1.0-beta.7 | 0 | composed | 2026-08-16 |
| [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | 2.26.4 | 0.1.0-beta.7 | 2 | direct | 2026-08-16 |
| [Threadleaf Compatibility Fixture](https://github.com/maherr/threadleaf) | 0.1.0 | 0.1.0-beta.7 | 0 | direct | 2026-08-15 |

## Excalidraw 2.25.3

An exact reviewed authority profile now permits sealed construction for this release, and historical workflow gates passed, but the required production Electron receipt was not regenerated under the current evidence policy, so current compatibility evidence remains Level 0.

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

- The exact reviewed authority profile binds this package, but no current controller-finalized production Electron receipt exists for it.
- Inline wiki-embed rendering and export formats beyond SVG and PNG are not verified.
- The official Obsidian to Threadleaf to Obsidian roundtrip is recorded as external evidence for one pinned Linux Flatpak and exact plugin release; it is not an executable registry gate.
- The exact release check and host workflow checks are composed gates, not one monolithic end-to-end command.

## Excalidraw 2.26.4

The exact 2.26.4 package passed reviewed-profile matching, content-addressed sealed construction, plugin onload, Settings convergence, clean process-restart reconstruction, revocation and unload, plus a current packaged Linux drawing edit, create, embed, SVG and PNG export, pop-out recovery, vault-switch, unload-reload, and restart workflow. The published level remains 2 because no controller-finalized Level 4 receipt exists.

Bundle SHA-256: `b26f3fc8cfa39cfefe8c11c82e43f80afdc642d8ca4d4ece3bdd817f72d4cf5a`. License: AGPL-3.0.

Required static authority review: `vault-read`, `vault-write`, `network`, `clipboard`, `external-navigation`, `editor-extension`, `workspace-ui`, `dynamic-code`.

### Supported workflows

- **Review, seal, construct, restart-reconstruct, revoke, and unload the exact package** (passed)
  - `pnpm test:plugin-packages-e2e:built` via [scripts/check-plugin-packages-e2e.mjs](../../scripts/check-plugin-packages-e2e.mjs)
- **Open and edit scenes, create and embed a drawing, export SVG and PNG, recover a pop-out crash, switch vaults, unload and reload, and restart** (passed)
  - `pnpm test:excalidraw-roundtrip` via [scripts/check-excalidraw-roundtrip.mjs](../../scripts/check-excalidraw-roundtrip.mjs)

### Platform limits

- **linux-x64-electron**: verified. The exact package was constructed by the trusted desktop compatibility runtime, not a sandbox. The static capability report is a review aid, not a runtime sandbox.
- **macos-electron**: unverified. This exact package construction and restart workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package construction and restart workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- The current drawing workflow is supporting behavior evidence, not Level 4 evidence, because no controller-finalized signed production Electron receipt exists.
- Inline wiki-embed rendering and export formats beyond SVG and PNG remain unverified for 2.26.4.
- The optional compatibility-renderer crash probe was not safely inducible by CDP on the tested Electron build; mandatory pop-out crash recovery passed.
- This is trusted same-user desktop construction evidence, not a sandbox or hostile-plugin attestation.

## Threadleaf Compatibility Fixture 0.1.0

Historical fixture workflows passed, but no reviewed authority profile currently permits construction, so current compatibility evidence is Level 0.

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

- No reviewed authority profile currently binds this exact package identity; construction is denied with authority-profile-missing.
- This repository-owned fixture intentionally exercises a narrow API surface.
- It is not listed in the external community package directory.

## Regeneration

Run `pnpm compatibility:generate` after updating reviewed evidence. `pnpm compatibility:check` validates schema, referenced gate paths, exact Threadleaf version binding, and generated-file drift without using the network.
