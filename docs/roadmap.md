# Roadmap

Threadleaf advances through proof gates rather than dates.

## Phase 0: Compatibility architecture proof (complete)

- [x] Load a synthetic vault without writing to it.
- [x] Replace `require("obsidian")` for an unchanged plugin bundle.
- [x] Complete plugin load, command execution, notice, reload, and unload lifecycles.
- [x] Display the observable runtime state in an isolated Electron renderer.
- [x] Cover the host with automated tests and a rendered-surface check.

Exit gate passed: the fixture reaches compatibility level 4 through the production loader without
changing any fixture byte.

## Phase 1: Safe vault kernel

- Canonical path handling and symlink policy.
- Incremental file watching.
- Atomic write and crash-recovery journal.
- External-edit detection and conflict copies.
- Rebuildable metadata and link index.

Exit gate: interruption, concurrent external-edit, rename, and recovery fixtures lose no bytes.

## Phase 2: Knowledge workspace

- File navigation, tabs, panes, commands, and settings.
- CodeMirror editor with source mode and live preview.
- Search, links, backlinks, tags, properties, and embeds.
- Keyboard-first desktop behavior and accessible theme foundations.

Exit gate: a real vault can be used daily without enabling compatibility plugins.

## Phase 3: Compatibility alpha

- Broaden the public API based on measured plugin usage.
- Add workspace views, Markdown processors, menus, settings, and editor extensions.
- Publish a generated compatibility registry.
- Verify representative open plugins, including a demanding Excalidraw workflow.

Exit gate: selected high-value plugins complete named workflows against public fixtures.

## Phase 4: Native extension platform

- Stable capability vocabulary.
- Permission declarations and review surface.
- Versioned SDK, conformance suite, and marketplace metadata.
- First-party features moved out of the kernel where practical.

## Later phases

- Open synchronization adapters and conflict UI.
- Reviewable agent operations with cited diffs.
- Mobile clients after desktop data safety and compatibility stabilize.
