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

- [x] One action registry shared by workspace and compatibility-plugin commands.
- [x] Production composition of the vault kernel, watcher, index reactor, action registry, and
      compatibility host.
- [x] File navigation, three-pane source workspace, indexed filtering, headings, tags, links, and
      backlinks.
- [x] Keyboard-first filtering and accessible light and dark theme foundations.
- [x] CodeMirror source editor with dirty state, explicit Revert, revision-aware recoverable save,
      external-change detection, and keep-both conflict UI.
- [x] Arbitrary vault picker, validated runtime swaps, and persistent workspace restoration.
- [x] Accessible command palette with shared core and compatibility-plugin actions, search,
      disabled-state explanations, and keyboard navigation.
- [x] Versioned application settings and remappable hotkeys with collision validation, atomic
      private persistence, reset-to-default behavior, and no vault-owned state.
- [x] Bounded vault-wide full-text search over saved paths, headings, tags, properties, fenced code,
      and body text, with ranked context, line navigation, stale-response identity, watcher
      convergence, and a reproducible 10,000-note microbenchmark.
- [x] Explicit sanitized reading view over the current saved or unsaved editor draft, with
      deterministic source-line navigation, index-resolved internal links, inert external links,
      dirty-navigation protection, and no new filesystem or shell authority in the renderer.
- [x] Headless native CLI foundation over the shared read-only vault kernel and metadata index, with
      explicit vault selection, `vault info`, `files`, `read`, `search`, stable JSON, script-safe
      exit codes, and tested `file=` and `query=` compatibility spellings.
- [ ] Recovery-backed CLI mutation commands and a broader executable behavior corpus for familiar
      Obsidian-style command names and errors.
- [ ] Tabs, split panes, application menus, and broader workspace settings.
- [ ] Inline live preview and fine-grained cursor-to-rendered-position mapping.
- [ ] Rich property views and editing, attachments, and embeds.

Exit gate: a real vault can be used daily without enabling compatibility plugins.

## Phase 3: Compatibility alpha

- Build an executable same-vault behavior corpus for links, aliases, embeds, attachments,
  frontmatter, rename semantics, JSON Canvas, and `.obsidian/` coexistence.
- Broaden the public API based on measured plugin usage.
- Add workspace views, Markdown processors, menus, plugin settings views, and editor extensions.
- Import behavior with an explicit preview: enabled-plugin inventory, compatible plugin settings,
  hotkeys, themes, CSS snippets, and workspace layout. Never require or mutate `.obsidian/`.
- Publish a generated compatibility registry.
- Publish benchmark vaults and regression budgets for cold start, full rebuild, watcher bursts,
  search latency, memory use, and plugin activation.
- Run plugin bundles through automated compatibility and security checks before distribution.
- Verify representative open plugins, including a demanding Excalidraw workflow.

Exit gate: selected high-value plugins complete named workflows against public fixtures.

## Phase 4: Native extension platform

- Stable capability vocabulary.
- Permission declarations and review surface.
- Versioned SDK, conformance suite, signed manifests, marketplace metadata, automated review, and
  a rapid delisting path.
- First-party features moved out of the kernel where practical.

## Later phases

- Reviewable agent operations with cited diffs.
- Mobile clients after desktop data safety and compatibility stabilize.
- Signed, updateable, rollback-tested Linux, macOS, and Windows releases.

## Future lane: encrypted sync service

This lane does not gate the desktop alpha. The local application must remain complete without an
account or network connection.

- [ ] Publish a precise threat model and server-visible metadata disclosure.
- [ ] Define a versioned encrypted object and device protocol around vault revisions and preserved
      conflicts.
- [ ] Implement multi-device enrollment, recovery keys, encrypted history, and attachment sync in
      the desktop client.
- [ ] Publish the protocol and self-hostable server under an open-source license.
- [ ] Offer the same server as a paid, maintained Threadleaf-hosted service.
- [ ] Add a browser reader/editor with a deliberately narrower extension model than the trusted
      desktop compatibility host.
- [ ] Complete independent cryptographic and application-security review before making a
      zero-knowledge claim.

Exit gate: a hostile or compromised sync server cannot read vault content, paths, filenames,
attachments, or protected metadata; documented residual metadata is minimized; two devices
converge without losing concurrent edits; export and self-host migration require no proprietary
conversion.

## Continuous project-health gates

- Reproducible checks and platform packaging run without maintainer-only state.
- Architecture and conformance docs remain short enough for a new contributor to follow.
- Work is split into reviewable feature slices rather than one application-wide state layer.
- Every public API is classified as portable native, desktop compatibility only, or unavailable on
  mobile before third-party code depends on it.
- Any copied open-source code is pinned to a source revision and recorded with its license and
  retained notice.
