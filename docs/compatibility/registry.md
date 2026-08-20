# Generated plugin compatibility registry

This document is generated from the versioned receipt-aware source [`compatibility/plugin-evidence.v1.json`](../../compatibility/plugin-evidence.v1.json).
Discovery in the external community package directory is separate from Threadleaf compatibility evidence.
A row applies only to the exact plugin and Threadleaf versions shown.

Registry schema: 2. Threadleaf version: 0.1.0. Generation: 2e2af03ea286e840bedb8b9acbab1c416cbf194a5fdf5c8f2cf7293c764a3688.

| Plugin | Plugin version | Threadleaf | Level | Evidence | Last tested |
| --- | --- | --- | ---: | --- | --- |
| [Data Files Editor](https://github.com/zuktol/obsidian-data-files-editor) | 1.3.0 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Natural Language Dates](https://github.com/argenos/nldates-obsidian) | 0.6.2 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Auto Link Title](https://github.com/zolrath/obsidian-auto-link-title) | 1.5.5 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Auto Link Title](https://github.com/zolrath/obsidian-auto-link-title) | 1.5.5 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | 2.25.3 | 0.1.0 | 0 | composed | 2026-08-16 |
| [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin) | 2.26.4 | 0.1.0 | 2 | direct | 2026-08-16 |
| [Iconize](https://github.com/florianwoelki/obsidian-iconize) | 2.14.7 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Minimal Theme Settings](https://github.com/kepano/obsidian-minimal-settings) | 8.2.3 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Style Settings](https://github.com/mgmeyers/obsidian-style-settings) | 1.0.9 | 0.1.0 | 3 | direct | 2026-08-17 |
| [Omnisearch](https://github.com/scambier/obsidian-omnisearch) | 1.30.1 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Threadleaf Compatibility Fixture](https://github.com/maherr/threadleaf) | 0.1.0 | 0.1.0 | 0 | direct | 2026-08-15 |
| [Paste URL into Selection](https://github.com/denolehov/obsidian-url-into-selection) | 1.11.4 | 0.1.0 | 3 | direct | 2026-08-20 |
| [Paste URL into Selection](https://github.com/denolehov/obsidian-url-into-selection) | 1.11.4 | 0.1.0 | 3 | direct | 2026-08-20 |

## Data Files Editor 1.3.0

The exact Obsidian-installed Data Files Editor 1.3.0 bundle passed reviewed authority, opened its registered JSON file view, accepted real CodeMirror input, autosaved the changed JSON bytes, restored that content after a full application restart, and exposed its settings surface while four installed plugins remained loaded together.

Bundle SHA-256: `1f962a44845adad7ea3de6792bbf536f111ee131b0fcd16fa9cf4d18ff0d0676`. License: MIT.

Required static authority review: `editor-extension`, `workspace-ui`, `network`, `filesystem`, `subprocess`, `host-environment`.

### Supported workflows

- **Open, edit, and autosave JSON through the plugin-owned file view** (passed)
  - `THREADLEAF_INSTALLED_PLUGIN_MATRIX_ROOT=$PLUGIN_ROOT THREADLEAF_INSTALLED_THEME_MATRIX_ROOT=$MINIMAL_THEME pnpm test:excalidraw-roundtrip` via [scripts/check-excalidraw-roundtrip.mjs](../../scripts/check-excalidraw-roundtrip.mjs)

### Platform limits

- **linux-x64-electron**: verified. Verified under Xvfb Electron with the exact installed bundle, isolated plugin renderer, disposable vault, and private state. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- YAML, TXT, XML, non-default settings, rename, and explicit plugin reload remain outside this exact workflow claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Natural Language Dates 0.6.2

The unchanged Natural Language Dates 0.6.2 release, byte-identical to the package installed in the acceptance vault, passed exact-package authority review and direct Linux Electron command-palette and editor-autosuggest workflows. Selected natural-language text and visible @to suggestions both produced the expected date link while eight commands and one editor suggest remained registered.

Bundle SHA-256: `387d36a43412f761c0c69320655a7ec09aa9189ae2267550224cacc861e63fd6`. License: MIT.

Required static authority review: `vault-read`, `workspace-ui`.

### Supported workflows

- **Parse selected natural-language text into a date link from the command palette** (passed)
  - `pnpm test:natural-dates` via [scripts/check-url-selection-paste.mjs](../../scripts/check-url-selection-paste.mjs)
  - `pnpm exec vitest run src/runtime/plugin-host.test.ts` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)
- **Type @to, navigate the visible date suggestions, and insert Tomorrow** (passed)
  - `pnpm test:natural-dates` via [scripts/check-url-selection-paste.mjs](../../scripts/check-url-selection-paste.mjs)
  - `pnpm exec vitest run src/runtime/plugin-host.test.ts src/runtime/isolated-plugin-runtime.test.ts` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Verified in Linux X11 and Xvfb Electron with the exact upstream and acceptance-vault bundle, a disposable vault, private state, and light and dark suggestion surfaces. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- Date Picker, the remaining date and time insertion commands, daily-note creation, Obsidian URI handling, non-default plugin settings, and cross-plugin daily-note settings are outside this claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Auto Link Title 1.5.5

The unchanged official Auto Link Title 1.5.5 release passed exact-package authority review and direct Linux Electron URL paste through the trusted compatibility runtime. Its default legacy hidden-window path fetched a deterministic HTTP page title, replaced the temporary link placeholder, and preserved undo and ordinary paste.

Bundle SHA-256: `eb27498bfd05dc5c3847dd072f555ed4c02aece24451042c2edb25fc961f38be`. License: MIT.

Required static authority review: `network`, `clipboard`, `workspace-ui`.

### Supported workflows

- **Fetch a pasted URL title through the default legacy Electron path and preserve ordinary paste** (passed)
  - `pnpm test:auto-link-title` via [scripts/check-url-selection-paste.mjs](../../scripts/check-url-selection-paste.mjs)
  - `pnpm exec vitest run src/runtime/obsidian-electron-compat.test.ts src/runtime/plugin-host.test.ts` via [src/runtime/obsidian-electron-compat.test.ts](../../src/runtime/obsidian-electron-compat.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Verified in Linux X11 and Xvfb Electron with the exact upstream release, a deterministic loopback HTTP page, and disposable vault and private state. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- The verified legacy title loader accepts HTTP and HTTPS only, follows at most five redirects, reads at most 2 MiB, and times out after 10 seconds.
- The manual clipboard commands, editor-drop, non-default settings, authenticated sites, arbitrary remote scripts, and every unrelated Electron remote API are outside this claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Auto Link Title 1.5.5

The distinct Auto Link Title 1.5.5 bundle installed in the acceptance vault passed its own exact-package authority review and the same default title-fetch, placeholder replacement, undo, and ordinary-paste workflow. Its same version string does not inherit evidence from the upstream release hash.

Bundle SHA-256: `b1da7a8b9b98b4c7daeae1286db2cd7fc5e24bef2903d3e326adcfc7db146f32`. License: MIT.

Required static authority review: `network`, `clipboard`, `workspace-ui`.

### Supported workflows

- **Run the default title-fetch and ordinary-paste workflow against an explicit installed package** (passed)
  - `THREADLEAF_AUTO_LINK_TITLE=1 THREADLEAF_AUTO_LINK_TITLE_PLUGIN_DIR=$PLUGIN_DIR node scripts/check-url-selection-paste.mjs` via [scripts/check-url-selection-paste.mjs](../../scripts/check-url-selection-paste.mjs)

### Platform limits

- **linux-x64-electron**: verified. Verified from the operator-supplied exact package in Linux X11 and Xvfb Electron with a deterministic loopback HTTP page and disposable vault and private state. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- This identity is operator-supplied and is not substituted for the separately reviewed upstream release hash.
- The verified legacy title loader accepts HTTP and HTTPS only, follows at most five redirects, reads at most 2 MiB, and times out after 10 seconds.
- The manual clipboard commands, editor-drop, non-default settings, authenticated sites, arbitrary remote scripts, and every unrelated Electron remote API are outside this claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

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

## Iconize 2.14.7

The exact Obsidian-installed Iconize 2.14.7 bundle passed reviewed authority, opened its ordinary icon picker, persisted the selected star for a note, projected it into Threadleaf's native virtualized Files row, rendered it in light and dark, and reconstructed it after a full application restart while four installed plugins remained loaded together.

Bundle SHA-256: `b68bcfd318d678892f671736e54396fd72414180736e58f164fb17a3f72a22e1`. License: MIT.

Required static authority review: `vault-read`, `network`, `editor-extension`, `workspace-ui`, `dynamic-code`, `filesystem`, `subprocess`, `host-environment`.

### Supported workflows

- **Assign a star from the picker, persist it, and render it in the native Files tree** (passed)
  - `THREADLEAF_INSTALLED_PLUGIN_MATRIX_ROOT=$PLUGIN_ROOT THREADLEAF_INSTALLED_THEME_MATRIX_ROOT=$MINIMAL_THEME pnpm test:excalidraw-roundtrip` via [scripts/check-excalidraw-roundtrip.mjs](../../scripts/check-excalidraw-roundtrip.mjs)
  - `pnpm exec vitest run src/runtime/plugin-host.test.ts src/runtime/isolated-plugin-runtime.test.ts` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Verified under Xvfb Electron with the exact installed bundle, isolated plugin renderer, disposable vault, private state, and visible light and dark navigator screenshots. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- This workflow proves one emoji decoration. SVG icon packs, custom rules, folder and tab icons, color controls, remove, rename, and explicit plugin reload remain outside this claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Minimal Theme Settings 8.2.3

The exact Obsidian-installed Minimal Theme Settings 8.2.3 bundle passed reviewed authority beside the exact Minimal 8.2.0 theme, registered 51 owned commands, increased the native editor font to a measured 16.5px, persisted the value through both plugin and app APIs, rendered in light and dark, and restored the same computed size after a full application restart.

Bundle SHA-256: `70573512ec859fad644e79ca9883d0b6d7dfb5369cde66e366884638317efdf3`. License: MIT.

Required static authority review: `workspace-ui`, `network`, `filesystem`, `subprocess`, `host-environment`.

### Supported workflows

- **Change, project, measure, and persist the Minimal native editor font size** (passed)
  - `THREADLEAF_INSTALLED_PLUGIN_MATRIX_ROOT=$PLUGIN_ROOT THREADLEAF_INSTALLED_THEME_MATRIX_ROOT=$MINIMAL_THEME pnpm test:excalidraw-roundtrip` via [scripts/check-excalidraw-roundtrip.mjs](../../scripts/check-excalidraw-roundtrip.mjs)
  - `pnpm community-theme:check` via [scripts/check-community-theme-matrix.mjs](../../scripts/check-community-theme-matrix.mjs)

### Platform limits

- **linux-x64-electron**: verified. Verified under Xvfb Electron with the exact installed plugin and official-matching Minimal 8.2.0 theme, isolated plugin renderer, disposable vault, private state, computed style, and light and dark screenshots. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- This workflow proves one of 51 commands and the paired theme's existing visual matrix. The remaining commands, settings controls, non-default schemes, and explicit plugin reload remain outside this claim.
- A non-default Threadleaf accessibility editor-font preference takes precedence over the plugin's body-font projection.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Style Settings 1.0.9

The exact reviewed obsidian-style-settings 1.0.9 package passed direct Linux Electron evidence for source-bearing appearance discovery, the immutable isolated activeWindow, the real Community plugins Options route, live class and variable controls, snippet disable and re-enable, computed-style changes, renderer replacement, application restart reconstruction, realm locality, and dark and light visual capture. This is supporting behavior evidence at Level 3 (Integrated), not Level 4.

Bundle SHA-256: `1828abaacdab4c5578b705a625c585b30512f8efad4c7cfc5a18e70cc3557468`. License: Unspecified in manifest.

Required static authority review: `workspace-ui`, `dynamic-code`.

### Supported workflows

- **Discover snippet controls, apply live changes, recover the renderer, and reconstruct after restart** (passed)
  - `pnpm run test:style-settings-snippet-control` via [scripts/check-style-settings-snippet-control.mjs](../../scripts/check-style-settings-snippet-control.mjs)
  - `pnpm exec vitest run src/shared/plugin-runtime-protocol.test.ts src/plugin-renderer/plugin-renderer-service.test.ts src/runtime/isolated-plugin-runtime.test.ts src/runtime/recovering-plugin-runtime.test.ts` via [src/plugin-renderer/plugin-renderer-service.test.ts](../../src/plugin-renderer/plugin-renderer-service.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Verified in an isolated Linux X11 and Xvfb Electron run with the exact package identity and disposable vault and private state. The runtime is a trusted same-user Node renderer, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- The controls style only the isolated plugin surface.
- Threadleaf native editor, file tree, settings shell, and unrelated plugin views are outside the claim.
- The runtime is a trusted same-user Node renderer, not a sandbox.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Omnisearch 1.30.1

The exact Obsidian-installed Omnisearch 1.30.1 bundle passed reviewed authority, built its own index over the disposable vault, opened its own visible search modal, returned the expected Unicode-scene result, handed that result back to Threadleaf's native note navigation, and repeated the query and open workflow after a full application restart while four installed plugins remained loaded together.

Bundle SHA-256: `4ea4d51f5ce283ea0f83ceb1f1db8e8f8c3ae156fab69a5f8f4c4e09d101a314`. License: GPL-3.0.

Required static authority review: `vault-read`, `network`, `workspace-ui`, `filesystem`, `subprocess`, `host-environment`.

### Supported workflows

- **Index the vault, query the plugin modal, and open the selected native note** (passed)
  - `THREADLEAF_INSTALLED_PLUGIN_MATRIX_ROOT=$PLUGIN_ROOT THREADLEAF_INSTALLED_THEME_MATRIX_ROOT=$MINIMAL_THEME pnpm test:excalidraw-roundtrip` via [scripts/check-excalidraw-roundtrip.mjs](../../scripts/check-excalidraw-roundtrip.mjs)
  - `pnpm exec vitest run src/runtime/plugin-host.test.ts` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Verified under Xvfb Electron with the exact installed bundle, isolated plugin renderer, disposable vault, and private state. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- Mutation reindexing, cache reuse, in-file search, PDF and image indexing, HTTP APIs, non-default settings, and explicit plugin reload remain outside this claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

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

## Paste URL into Selection 1.11.4

The unchanged official Paste URL into Selection 1.11.4 release passed exact-package authority review and direct Linux Electron delivery from native editor paste through the trusted compatibility runtime. Selected text became a Markdown link and an unhandled ordinary paste retained its plain text fallback.

Bundle SHA-256: `377883d2fc2a1feeb96be868f7110782874206cb3065635281e89fdfdc6e6d77`. License: MIT.

Required static authority review: `clipboard`, `workspace-ui`.

### Supported workflows

- **Wrap selected text with a pasted URL and preserve ordinary paste fallback** (passed)
  - `pnpm test:url-selection-paste` via [scripts/check-url-selection-paste.mjs](../../scripts/check-url-selection-paste.mjs)
  - `pnpm exec vitest run src/runtime/plugin-host.test.ts src/shared/plugin-runtime-protocol.test.ts` via [src/runtime/plugin-host.test.ts](../../src/runtime/plugin-host.test.ts)

### Platform limits

- **linux-x64-electron**: verified. Verified in Linux X11 and Xvfb Electron with the exact upstream release and disposable vault and private state. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- The clipboard-reading command, all settings combinations, and workspace events other than editor-paste are outside this claim.
- File-backed paste remains in Threadleaf's attachment workbench and is not delivered through this text bridge.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Paste URL into Selection 1.11.4

The distinct Paste URL into Selection 1.11.4 bundle installed in the acceptance vault passed its own exact-package authority review and the same direct Linux Electron selected-URL and ordinary-paste workflows. Its same version string does not inherit evidence from the upstream release hash.

Bundle SHA-256: `8578844689112df74390d7b107a1302b30c8e31a490cadf40bccd73ddeca9aca`. License: MIT.

Required static authority review: `clipboard`, `workspace-ui`.

### Supported workflows

- **Run the selected-URL and ordinary-paste workflow against an explicit installed package** (passed)
  - `THREADLEAF_URL_SELECTION_PLUGIN_DIR=$PLUGIN_DIR node scripts/check-url-selection-paste.mjs` via [scripts/check-url-selection-paste.mjs](../../scripts/check-url-selection-paste.mjs)

### Platform limits

- **linux-x64-electron**: verified. Verified from the operator-supplied exact package in Linux X11 and Xvfb Electron with disposable vault and private state. The runtime is trusted same-user desktop code, not a sandbox.
- **macos-electron**: unverified. This exact package workflow is not verified on macOS.
- **windows-x64-electron**: unverified. This exact package workflow is not verified on Windows.

### Known failures

- No reproducible failure is recorded for the supported workflows above.

### Limitations

- This identity is operator-supplied and is not substituted for the separately reviewed upstream release hash.
- The clipboard-reading command, all settings combinations, and workspace events other than editor-paste are outside this claim.
- This is supporting behavior evidence, not Level 4 evidence.
- No controller-finalized signed production receipt exists for this tuple.

## Regeneration

Run `pnpm compatibility:generate` after updating reviewed evidence. `pnpm compatibility:check` validates schema, referenced gate paths, exact Threadleaf version binding, and generated-file drift without using the network.
