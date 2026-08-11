# FOSS Obsidian alternatives: landscape and adoption ceilings

Observed on 2026-08-11. This is a source and repository audit, not a user-count study. Stars,
downloads, commits, and issue activity are weak signals, so they are used only to distinguish a
mature community from a new or single-maintainer project.

## Executive finding

The projects in the
[awesome-obsidian-alternatives directory](https://github.com/slimhk45/awesome-obsidian-alternatives)
do not show that an open alternative cannot win. Most are less than a year old. Foam is the one
mature project in the group, and it built a substantial community by serving developers inside
Visual Studio Code rather than becoming a standalone consumer application.

The repeated ceiling is not a lack of editor features. It is a missing migration bridge:

1. Same-vault storage is claimed more often than it is proven.
2. None of the listed standalone applications runs the existing Obsidian plugin ecosystem.
3. Most depend overwhelmingly on one maintainer.
4. Packaging, signing, mobile support, external edits, rename behavior, and crash-safe writes are
   treated as follow-up work even though they determine whether users trust a daily-driver app.
5. Broad feature lists arrive before a compatibility corpus, data-safety proof, and extension
   community.

This changes Threadleaf's strategy. It should not compete by accumulating a longer checklist. Its
wedge is continuity: open the same vault, preserve exact file behavior, carry important plugin
workflows forward, and make every compatibility and safety claim executable.

## What the directory does and does not prove

The directory defines its top tier around Markdown, eventual JSON Canvas support, arbitrary folder
structure, suffix-based wikilinks, and backlink rewriting. That is a useful storage checklist, but
the phrase "fully Obsidian-compatible" is too broad for those criteria.

Source inspection found two immediate counterexamples:

- [Otterly's current resolver](https://github.com/ajkdrag/otterly/blob/main/src-tauri/src/features/search/link_parser.rs)
  turns a short target into a root-relative Markdown path. It does not search the vault for a
  matching path suffix.
- [Cherit's current application tree](https://github.com/Keshav-writes-code/Cherit/tree/main/apps/app/src)
  contains an editor and file manager, but no wikilink or backlink implementation was found.

The label also excludes the largest switching cost: existing community plugins. A project can
match Markdown storage and still require users to abandon their commands, views, automations,
themes, and drawing workflows.

Threadleaf will therefore treat directories and README tables as discovery inputs only. A feature
or compatibility level exists only after a fixture passes through the production path.

## Project review

| Project | Evidence of maturity | Main ceiling | Extension continuity | License and reuse decision |
| --- | --- | --- | --- | --- |
| [Lokus](https://github.com/lokus-ai/lokus) | 769 stars, 70 commits in the preceding 90 days, and packaged desktop releases. One author accounts for 477 commits while the next contributors have six each. | Ambitious breadth, [account and guest-mode friction](https://github.com/lokus-ai/lokus/issues/409), a large open-issue surface, no mobile release, and a trust mismatch between "open source" positioning and its current fair-source license. A separate [test-coverage issue](https://github.com/lokus-ai/lokus/issues/163) remains open. | Its [v3 plugin contract](https://github.com/lokus-ai/lokus/blob/main/src/core/plugin-v3/contract.js) is a Lokus-specific worker and capability API. It cannot load Obsidian plugins. | The application uses [FCL-1.0-MIT](https://github.com/lokus-ai/lokus/blob/main/LICENSE), which currently prohibits competing commercial use and converts each release to MIT after two years. Study behavior and ideas, but copy no current application code. |
| [Otterly](https://github.com/ajkdrag/otterly) | 159 stars and a serious test suite, but no commits in the preceding 90 days. One author accounts for 390 of 408 recorded contributor commits. | Promising engineering with a paused release line, no extension ecosystem, and incomplete format behavior. Its completed [external-change work](https://github.com/ajkdrag/otterly/issues/7) detects dirty-buffer conflicts, but its write path uses mtime comparison and rename-based temporary files without a durability journal. | No Obsidian plugin host and no native third-party extension platform. | MIT. Adopt the architecture principles from its [ports-and-adapters design](https://github.com/ajkdrag/otterly/blob/main/docs/architecture.md). Do not reuse its vault write implementation as Threadleaf's safety kernel. |
| [Cherit](https://github.com/Keshav-writes-code/Cherit) | 62 stars, no commits in the preceding 90 days, and one substantive test file. Its README says available builds are not recommended. | The current tree is still an early editor shell. [Local sync](https://github.com/Keshav-writes-code/Cherit/issues/41), [tabs](https://github.com/Keshav-writes-code/Cherit/issues/42), [persistent state](https://github.com/Keshav-writes-code/Cherit/issues/53), search, and distribution work remain open, and wikilink support was not found. | None found. | The repository presents GPL-2.0 without an "or later" project grant. Treat it as GPL-2.0-only and do not combine its code with Threadleaf's AGPL-3.0-or-later core without separate permission. |
| [Mdit](https://github.com/hjinco/mdit) | 81 stars, four commits in the preceding 90 days, 119 test files, and macOS releases. One author accounts for 882 commits. | Strong internals but macOS-only distribution, no plugin ecosystem, no sync yet, and extreme maintainer concentration. | None found. | Apache-2.0. Its [vault watcher](https://github.com/hjinco/mdit/tree/main/crates/vault-watch) is the best watcher model in this set. Reuse its observable failure behaviors and test cases, not its Rust subsystem, unless profiling later justifies a native component. |
| [Foam](https://github.com/foambubble/foam) | 17,343 stars, at least 100 commits in the preceding 90 days, a 133-contributor badge, years of issue history, and the only clearly broad community in this set. | It is a developer-focused Visual Studio Code system rather than a cohesive standalone desktop and mobile product. Its host dependency is both its adoption engine and its mainstream ceiling. | Users get Visual Studio Code extensions, not Obsidian plugin compatibility. | MIT. Its platform-neutral [`@foam/core`](https://github.com/foambubble/foam/tree/main/packages/foam-core) contains mature parsing, suffix lookup, graph, and placeholder logic. Reuse narrow code only after semantic fixtures prove a match and attribution is recorded. Adopt its incremental-versus-rebuild test method immediately. |
| [HelixNotes](https://gitlab.com/ArkHost/HelixNotes) | Active after a July 2026 move from an archived [Codeberg repository](https://codeberg.org/ArkHost/HelixNotes). The current GitLab project has 22 stars and at least 100 commits in the preceding 90 days; the archived repository had 157 stars. One author accounts for 299 commits, versus 18 for the next contributor. | Impressive feature breadth, but it imports Obsidian vaults instead of acting as a compatibility runtime. Its macOS build is not notarized, its current tree has little automated test and CI coverage, and core note writes are direct filesystem writes. | None found. | AGPL-3.0. Its [three-way WebDAV model](https://gitlab.com/ArkHost/HelixNotes/-/blob/main/src-tauri/src/sync.rs), empty-remote safety guard, and keep-both conflict naming are useful product references. Reimplement them over Threadleaf's durable kernel rather than transplanting the current write path. |

Repository metrics in this table came from the GitHub, GitLab, and Codeberg repository APIs on the
observation date. A 100-commit result is API-capped and means "at least 100." It must not be read as
an estimate of active users.

## Why they have not overtaken Obsidian

### It is mostly too early to call

Lokus, Otterly, Cherit, Mdit, and the current HelixNotes project all appeared or moved within the
last year. A plugin ecosystem, contributor culture, documentation corpus, and reputation for not
losing data take longer to compound. "Failed to overtake" is premature for them.

### Same Markdown is necessary but not sufficient

Real vault continuity includes link resolution, ambiguous filenames, aliases, headings, block
references, embeds, attachment placement, frontmatter round trips, rename rewrites, hidden folders,
symlinks, external edits, JSON Canvas, and coexistence with `.obsidian/`. The projects cover uneven
subsets of that surface.

The issue history of Foam is especially instructive. Its mature community spent years resolving
[Windows path bugs](https://github.com/foambubble/foam/issues/488),
[subdirectory links](https://github.com/foambubble/foam/issues/806),
[graph CPU use](https://github.com/foambubble/foam/issues/347),
[large-workspace performance](https://github.com/foambubble/foam/issues/1375), and
[rename behavior](https://github.com/foambubble/foam/issues/305). Those are not peripheral bugs.
They are the actual cost of dependable local-file software.

### No project offers the missing bridge

Lokus has its own plugin API. Foam has the Visual Studio Code extension host. The other listed apps
have no general third-party extension platform. None provides an `obsidian` compatibility module,
workspace model, editor surface, and lifecycle capable of running existing Obsidian plugins.

That forces a power user to choose between source openness and the workflows already accumulated in
their vault. Feature parity cannot compensate one-for-one for that loss because each user's plugin
set is different.

### Tauri optimizes the wrong first constraint for plugin continuity

Most standalone projects selected Tauri. It is an excellent route to small native packages, but an
Obsidian plugin commonly assumes Chromium, the DOM, Node.js, CommonJS, and Electron-adjacent
behavior. Recreating that environment across a webview and Rust command boundary expands the
compatibility problem.

Threadleaf accepts a larger desktop runtime in exchange for a much smaller compatibility gap. It
can optimize memory after representative plugins work. The renderer still remains isolated and
sandboxed; trusted compatibility plugins execute outside it.

### Single-maintainer products cannot yet carry ecosystem trust

Every standalone project in this set has one overwhelmingly dominant contributor. That does not
make the code bad, but it limits review capacity, platform coverage, issue response, release
continuity, and plugin-author confidence. Foam is the exception, and it is also the only project
with community scale comparable to a durable ecosystem rather than a promising application.

### Distribution quality is product quality

macOS-only releases, missing notarization, Linux GPU workarounds, stalled release lines, and absent
mobile clients each remove a segment of potential adopters. Cross-platform source code is not the
same as a cross-platform product. Install, update, rollback, signing, accessibility, and recovery
must be release gates rather than post-launch cleanup.

### Breadth can hide weak foundations

HelixNotes and Lokus demonstrate how quickly a modern team can build visible features. Their source
also shows why feature count is a poor readiness measure: watcher overflow, transactional rename,
content revisions, crash recovery, exact link semantics, and packaging polish remain independent
problems. AI-assisted development accelerates implementation, but it does not collapse those
distinct contracts into one.

## What Threadleaf will borrow

### From Otterly: application boundaries

Adopt these principles:

- ports and adapters at filesystem, index, compatibility, and operating-system seams;
- application services that express user intent;
- side-effect-free stores;
- reactors as the only home for automatic side effects;
- one action registry for menus, hotkeys, commands, and UI controls;
- vertical feature slices with an enforced dependency direction;
- one authoritative representation for each concern.

These are architectural ideas, not copied implementation.

### From Mdit: watcher failure behavior

Threadleaf's watcher contract will include:

- debounced batches with stream IDs and monotonic sequence numbers;
- paired and split rename handling;
- explicit path-state transitions;
- bounded channels and batch sizes;
- watcher overflow, ambiguous rename, and backend error signals;
- a scan-subtree fallback and an unconditional full-rescan fallback;
- hidden-path and symlink policy;
- tests for delete, recreate, move, move-in, move-out, overflow, and stop behavior.

The first implementation remains TypeScript and Node so the vault kernel has one language and one
durability boundary. A native watcher component becomes an option only if measured vault sizes show
the need.

### From Foam: rebuild equivalence

Foam's
[incremental graph tests](https://github.com/foambubble/foam/blob/main/packages/foam-core/src/model/graph-incremental.test.ts)
compare each incremental mutation against a graph rebuilt from scratch. Threadleaf will make that a
global index invariant:

> After any accepted watcher event sequence, the incremental metadata state must equal a clean
> rebuild from the current vault bytes.

The corpus will cover additions, modifications, deletions, renames, unresolved links, duplicate
basenames, aliases, case behavior, and crash recovery.

Threadleaf will not add `@foam/core` as a wholesale dependency yet. Foam does not automatically
rewrite incoming links on rename, its semantics are not an Obsidian contract, and its parser stack
would bring policy along with useful machinery. Exact compatibility fixtures come first. Narrow
MIT-licensed code can be adopted later with preserved notices if it wins a measured comparison.

### From HelixNotes: conflict UX concepts

Adopt the three-way sync model, SHA-256 content comparison, empty-remote mass-deletion guard, and
keep-both conflict copies as requirements for a later sync adapter. Implement them through the same
journaled write API as local edits. A sync transport never receives a privileged bypass around the
vault kernel.

### From Lokus: separate extension trust classes

Lokus's worker and capability model reinforces Threadleaf's two-runtime decision:

- existing Obsidian plugins run in a clearly labeled trusted compatibility host;
- native Threadleaf extensions use a versioned, capability-based API.

The concepts are useful. The Lokus API and implementation are not imported.

## Architecture and product decisions from this review

1. Keep Electron for the desktop compatibility host.
2. Put the safe vault kernel before visible feature breadth.
3. Add ports, adapters, services, reactors, vertical slices, and a single action registry now,
   before Phase 2 makes boundaries expensive to change.
4. Treat file-watcher events as hints. Overflow or ambiguity triggers rescan, never guessed state.
5. Prove every incremental index against a full rebuild.
6. Build a live compatibility corpus from real open plugins and synthetic edge fixtures. Do not use
   directory tiers or README claims as evidence.
7. Make same-vault operation and existing-plugin workflows the migration wedge.
8. Add signing, updates, rollback, accessibility, and three-desktop-platform packaging to release
   gates.
9. Design the repository for multiple maintainers: short architecture docs, isolated features,
   conformance suites, issue-sized work, and reproducible builds.
10. Record every copied dependency or source fragment in a third-party notice with its source,
    revision, license, modifications, and retained notice. No project code has been copied during
    this review.

## Reuse ledger

| Source | Candidate | Current decision |
| --- | --- | --- |
| Otterly, MIT | Ports, adapters, action registry, reactors, vertical slices | Adopt as independently implemented architecture. |
| Mdit, Apache-2.0 | Watcher states, overflow fallback, rename matrix, tests | Port the behavioral contract and fixture ideas. Keep the first kernel implementation in TypeScript. |
| Foam, MIT | Parser utilities, suffix lookup, graph, placeholders | Adopt rebuild-equivalence testing now. Re-evaluate narrow code reuse after exact compatibility fixtures exist. |
| HelixNotes, AGPL-3.0 | Three-way WebDAV and keep-both conflicts | Adopt as later sync requirements over Threadleaf's durable writer. |
| Lokus, FCL-1.0-MIT | Plugin worker and capability concepts | Ideas only. Do not copy current application code. |
| Cherit, GPL-2.0-only on its face | None identified | No code reuse. |

## Stop conditions this creates

Threadleaf must stop and fix the foundation before expanding feature scope if any of these occur:

- an interrupted write can lose either the prior or intended bytes;
- an external edit can be silently overwritten;
- an incremental index differs from a clean rebuild;
- a compatibility claim lacks a named workflow fixture;
- a plugin requires editing its published bundle to pass;
- a release cannot be installed, updated, and rolled back on a declared platform;
- one application action has diverging behavior depending on whether it came from a menu, hotkey,
  command palette, or visible control.
