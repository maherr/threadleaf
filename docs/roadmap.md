# Roadmap

Threadleaf advances through proof gates rather than dates.

## Architecture gate: alternatives audit (complete)

- [x] Inspect the projects listed by `awesome-obsidian-alternatives` at source level.
- [x] Separate project age from structural adoption ceilings.
- [x] Audit plugin continuity, repository concentration, release coverage, and licenses.
- [x] Record reusable architecture, watcher, index, and sync ideas.
- [x] Reject directory tiers and README claims as compatibility evidence.

Exit gate passed: the findings and resulting decisions are recorded in the
[alternatives landscape review](research/alternatives-landscape.md).

## Phase 0: Compatibility architecture proof (complete)

- [x] Load a synthetic vault without writing to it.
- [x] Replace `require("obsidian")` for an unchanged plugin bundle.
- [x] Complete plugin load, command execution, notice, reload, and unload lifecycles.
- [x] Display the observable runtime state in an isolated Electron renderer.
- [x] Cover the host with automated tests and a rendered-surface check.

Exit gate passed: the fixture reaches compatibility level 4 through the production loader without
changing any fixture byte.

## Phase 1: Safe vault kernel (complete)

- [x] Canonical path handling and symlink policy.
- [x] State-root port and fixed-path adapter.
- [x] Read-only vault port with the Node vault kernel as its filesystem adapter.
- [x] Mutation port and Node vault-kernel adapter.
- [x] Sequenced, debounced file watching with inode-based rename pairing.
- [x] Overflow, ambiguity, sequence-gap, stream-restart, and full-rescan behavior.
- [x] Targeted subtree scan and index-rebuild behavior.
- [x] Durable no-clobber writes and crash-recovery journal.
- [x] Content revisions, external-edit detection, conflict copies, and writer serialization.
- [x] Recoverable single-file rename.
- [x] Recoverable multi-file roll-forward transactions.
- [x] Rebuildable metadata and link index foundation.
- [x] Incremental-versus-clean-rebuild equivalence tests across the writer and watcher seam.

Exit gate: interruption, concurrent external-edit, rename, and recovery fixtures lose no bytes.
Every watcher fallback converges, and every incremental index snapshot equals a clean rebuild.

Exit gate passed: 58 automated tests cover the interruption matrix, external races, single and
multi-file recovery, live watcher delivery and fallbacks, operation attribution, and index
equivalence through the real writer-to-watcher seam.

## Phase 2: Knowledge workspace

- One action registry for menus, hotkeys, commands, plugins, and visible controls.
- Vertical feature slices with ports, services, side-effect-free stores, and reactors.
- File navigation, tabs, panes, commands, and settings.
- CodeMirror editor with source mode and live preview.
- Search, links, backlinks, tags, properties, and embeds.
- Keyboard-first desktop behavior and accessible theme foundations.

Exit gate: a real vault can be used daily without enabling compatibility plugins.

## Phase 3: Compatibility alpha

- Build an executable same-vault behavior corpus for links, aliases, embeds, attachments,
  frontmatter, rename semantics, JSON Canvas, and `.obsidian/` coexistence.
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
- Signed, updateable, rollback-tested Linux, macOS, and Windows releases.

## Continuous project-health gates

- Reproducible checks and platform packaging run without maintainer-only state.
- Architecture and conformance docs remain short enough for a new contributor to follow.
- Work is split into reviewable feature slices rather than one application-wide state layer.
- Any copied open-source code is pinned to a source revision and recorded with its license and
  retained notice.
