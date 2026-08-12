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
- [x] Read-only CLI graph and outline corpus for ordered outgoing occurrences, grouped backlinks,
      unresolved and ambiguous links, orphans, syntax-level dead ends, and line-aware headings.
- [x] Vault-scoped local raster-image rendering with stable bounded reads, byte-sniffed MIME types,
      containment and stale-vault checks, explicit failure placeholders, and attachment-change
      invalidation without renderer filesystem access.
- [x] Recovery-backed desktop and CLI note creation with nested paths, no-overwrite preflight,
      create-race conflict preservation, interruption recovery, process serialization, stable JSON,
      and tested `path=`, `name=`, and `content=` compatibility spellings.
- [x] Recovery-backed CLI append and prepend with required existing-note targets, frontmatter-aware
      prepend, LF/CRLF separators, inline mode, and full-proposal conflict preservation.
- [x] Recovery-backed CLI move and rename with destination no-clobber behavior, whole-vault
      projected-index proof, exact rewrite preview, and explicit `--update-links` confirmation.
- [x] Recovery-backed CLI delete, trash inspection, and restore with exact-path `.trash/` mapping,
      revision checks, collision refusal, interruption recovery, and normal-corpus exclusion.
- [x] Revision-bound desktop move and rename with exact rewrite preview, plan-bound confirmation,
      blocker evidence, destination and dirty-draft guards, and open-tab remapping.
- [x] Revision-bound desktop recoverable deletion with explicit confirmation, exact `.trash/`
      destination and link impact, collision and dirty-draft guards, operation attribution, and
      deterministic surviving-tab selection.
- [x] Ordered session tabs with path deduplication, dirty-draft guards, neighbor selection on close,
      watcher rename and delete reconciliation, remappable close and cycle shortcuts, and bounded
      horizontal overflow at the minimum desktop viewport.
- [x] Versioned per-vault tab restoration in private application state, including exact order and
      active-note restoration, explicit empty workspaces, stale-path pruning, and visible malformed
      state recovery without vault-owned metadata.
- [x] Headless indexed property listing and reads plus recovery-backed typed property set and remove,
      with conservative lossless frontmatter patching, mutation serialization, and conflict copies.
- [x] Source-offset-preserving internal-link rewrite planning with code and comment exclusion,
      alias and anchor retention, relative Markdown paths, ambiguity refusal, and final-index proof.
- [x] Crash-recoverable compound note moves that apply validated link rewrites and rename under one
      parent journal, with reverse rollback, conflict copies, and desktop and CLI confirmation.
- [x] Headless task listing and exact `path:line` reads plus recovery-backed toggle, done, todo, and
      custom-status mutation, with code and comment exclusion, no-op detection, and conflict copies.
- [x] Headless alias and tag catalogs across the vault or one targeted note, with distinct names,
      occurrence totals, deterministic count sorting, and verbose source-file attribution.
- [x] Shared Obsidian-style `file=` note-name resolution across read, metadata, refactor, recovery,
      property, and task commands, with case-insensitive NFC matching and explicit ambiguity.
- [x] Read-only CLI file and folder inventory across ordinary vault file types plus Unicode-aware
      word and grapheme-character counts, with private-tree and symlink containment.
- [x] Obsidian-style CLI search and graph output controls, including folder, limit, case, total,
      counts, verbose sources, grep-style context, JSON/TSV/CSV, and tree/Markdown/JSON outlines.
- [x] Read-only discovery of standard Obsidian theme and CSS snippet folders, with deterministic
      catalogs, bounded contained reads, explicit diagnostics, and theme-before-snippet ordering.
- [x] Versioned per-vault appearance settings outside the vault, system/light/dark selection,
      settings UI, manual reload, one-command recovery, startup safe mode, and version 1 migration.
- [x] Initial Obsidian-compatible appearance variables and workspace class aliases, verified in
      default and synthetic compatibility themes at minimum desktop size and under moderate
      deuteranomaly.
- [ ] Remaining CLI commands and a broader executable behavior corpus for familiar
      Obsidian-style command names and errors.
- [ ] Split panes, application menus, and broader workspace settings.
- [ ] Inline live preview and fine-grained cursor-to-rendered-position mapping.
- [ ] Rich property views and editing, broader attachment types, and wiki embeds.

Exit gate: a real vault can be used daily without enabling compatibility plugins.

## Phase 3: Compatibility alpha

- [ ] Build an executable same-vault behavior corpus for links, aliases, embeds, attachments,
      frontmatter, rename semantics, JSON Canvas, and `.obsidian/` coexistence.
- [ ] Broaden the public API from measured open-plugin usage, with one conformance fixture for each
      supported method, event, component, and lifecycle edge.
- [ ] Add workspace views, Markdown processors, menus, ribbons, status items, modal and setting
      components, plugin settings views, and CodeMirror editor extensions.
- [x] Discover `.obsidian/plugins/<id>/manifest.json`, `main.js`, and optional `styles.css` through
      contained bounded reads, with deterministic identity and explicit invalid-package evidence.
- [x] Keep Threadleaf's enabled-plugin set in private per-vault settings without treating existing
      Obsidian configuration as authority.
- [ ] Add capability grants and an explicit migration preview for existing plugin enablement.
- [x] Implement enable, disable, reload, startup safe mode, lifecycle diagnostics, independent
      failure retention, and clean unload for every discovered compatibility plugin.
- [ ] Add activation timeouts, process isolation, crash attribution, and per-plugin resource budgets.
- [ ] Implement reviewable install, update, rollback, and uninstall against an open package index,
      with exact version pins, integrity checks, retained licenses, and no silent bundle execution.
- [ ] Add dependency, minimum-app-version, desktop-only, and compatibility-level reporting before a
      plugin can be enabled.
- [ ] Import behavior with an explicit preview: enabled-plugin inventory, compatible plugin
      settings, hotkeys, themes, CSS snippets, and workspace layout. Never require or mutate
      `.obsidian/`.
- [ ] Publish a generated plugin compatibility registry with supported workflows, failures,
      required permissions, platform limits, and the last tested plugin and Threadleaf versions.
- [ ] Publish benchmark vaults and regression budgets for cold start, full rebuild, watcher bursts,
      search latency, memory use, editor latency, and plugin activation.
- [ ] Run plugin bundles through automated compatibility and security checks before distribution.
- [ ] Verify representative open plugins for queries, tasks, templates, Git, citations, calendars,
      tables, and databases through named end-to-end workflows.
- [x] Run the unchanged open Excalidraw 2.25.3 bundle through discovery and `onload` activation in a
      disposable DOM realm, including view, ribbon, settings-tab, and Markdown-processor
      registration.
- [x] Activate the unchanged Excalidraw 2.25.3 bundle in the production Electron compatibility
      renderer at startup and apply its stylesheet with remote font URLs neutralized under a
      no-network policy.
- [x] Attach Excalidraw's registered drawing view to a visible workspace leaf, retain its commands,
      render its filename header and action icons, propagate Threadleaf chrome themes, and open an
      existing Excalidraw Markdown document through the plugin's real loaded canvas.
- [x] Modify an existing Excalidraw scene, save it through the revision-bound recoverable writer,
      close and fully detach the plugin view, and reopen the exact persisted scene.
- [x] Run Excalidraw's unchanged new-drawing command through nested folder and file creation,
      built-in Markdown leaf handoff, custom-view activation, scene save, full view close, and exact
      persisted-scene reopen.
- [x] Complete Excalidraw native-editor embed insertion plus SVG and PNG vault-export fixtures,
      including create, overwrite, close, reopen, XML parsing, and exact binary-signature checks.
- [x] Complete the Excalidraw active-view full plugin-unload fixture, including plugin-owned modal,
      leaf, command, view, extension, processor, suggester, ribbon, settings, duplicate-reload, and
      captured-error checks across two reload cycles.
- [ ] Preserve Excalidraw Markdown and attachment bytes across Threadleaf, Obsidian, external edits,
      rename, sync-style conflicts, and recovery without a converter-only fork of the format.

Exit gate: selected high-value plugins complete named workflows against public fixtures.

## Phase 4: Native extension platform

- [ ] Stable capability vocabulary for vault access, network access, subprocesses, secrets,
      clipboard, notifications, workspace mutation, and editor extensions.
- [ ] Permission declarations, install-time review, runtime inspection, revocation, and safe
      degradation when a capability is unavailable.
- [ ] Versioned SDK, type declarations, API reference, conformance suite, signed manifests,
      marketplace metadata, automated review, compatibility CI, and a rapid delisting path.
- [ ] Sandboxed native extensions for portable workflows and a clearly labeled trusted desktop
      compatibility tier for plugins whose existing contracts require Node or Electron authority.
- [ ] First-party features moved out of the kernel where practical so third-party extensions use
      the same stable surfaces as bundled functionality.

## Phase 5: Themes, workspace parity, and desktop 1.0

- [x] Stable baseline design tokens for light, dark, and system-following appearances.
- [ ] Add high-contrast tokens, user accent controls, text/font controls, reduced-transparency
      behavior, and a versioned public theme contract.
- [x] Discover, enable, disable, reload, diagnose, and select existing vault themes and snippets
      per vault without mutating `.obsidian/`.
- [ ] Add preview-before-commit, package install, update, rollback, uninstall, file watching,
      conflict diagnostics, and portable theme export.
- [x] Expose an initial Obsidian-theme compatibility layer for common variables, workspace classes,
      Markdown views, file navigation, tabs, and status bars.
- [ ] Expand the compatibility layer through measured open-theme usage, icon and component states,
      settings controls, pop-outs, graphs, Canvas, and every major workspace view.
- [x] Verify default and synthetic compatibility themes at minimum desktop size in both schemes,
      with live computed-style contrast, focusable names, non-color state cues, and moderate and
      stress deuteranomaly checks.
- [ ] Add committed visual regression coverage for ordinary laptop size, high DPI, zoom, long
      translations, reduced motion, high contrast, and representative open community themes.
- [ ] Split groups, draggable tabs, pinned tabs, side docks, floating windows, pop-out views,
      history, bookmarks, quick switcher, command discovery, and persistent workspace layouts.
- [ ] Source mode, live preview, reading mode, block and heading references, embeds, callouts,
      footnotes, tables, math, diagrams, and large-document editing with reliable IME and undo.
- [ ] JSON Canvas editing and embedding plus first-class attachment browsing, rename, preview,
      drag-and-drop, paste, and missing-file recovery.
- [ ] Core daily-driver features for templates, daily notes, backlinks, outgoing links, tags,
      properties, tasks, search, graph, outline, bookmarks, file recovery, and publish-ready export.
- [ ] Keyboard navigation, screen-reader semantics, reduced motion, contrast, zoom, localization,
      bidirectional text, and touch-target audits across every reachable control.
- [ ] Signed Windows, macOS, and Linux installers; reproducible release builds; automatic updates;
      rollback; crash recovery; opt-in diagnostics; and tested upgrade and downgrade paths.
- [ ] Public large-vault, attachment-heavy, and plugin-heavy performance budgets with profiling
      artifacts and regression alarms.

Exit gate: a fresh user and an established Obsidian user can each adopt Threadleaf as their daily
desktop workspace without a conversion, missing core workflow, or proprietary service dependency.

## Phase 6: Ecosystem and public launch

- [ ] Publish the vault behavior specification, plugin and theme compatibility specifications,
      fixture corpus, benchmark corpus, and contribution guide under open licenses.
- [ ] Launch an open plugin and theme directory with reproducible metadata, transparent review,
      maintainer succession, mirrors, and exportable indexes.
- [ ] Provide porting tools, API-difference diagnostics, starter templates, compatibility grants,
      and automated pull-request checks for extension authors.
- [ ] Complete independent security, accessibility, data-loss, installer, updater, and plugin-host
      reviews; publish findings and remediation status.
- [ ] Document governance, release authority, trademark policy, security response, API stability,
      deprecation, succession, and fork continuity before calling the project 1.0.
- [ ] Maintain a no-account local path, a complete export path, reproducible source releases, and
      a self-hostable path for every network service that becomes part of the normal workflow.

Exit gate: public releases are safe to recommend without maintainer caveats, and the community can
continue the client, specifications, plugins, themes, and distribution if the original stewards
disappear.

## Later phases

- [ ] Reviewable agent operations with cited diffs and explicit write previews.
- [ ] Mobile clients after desktop data safety and compatibility stabilize, using the same vault
      semantics and a deliberately capability-limited extension tier.
- [ ] Collaboration and publish surfaces that preserve the local, offline, no-account desktop as
      the complete base product.

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
