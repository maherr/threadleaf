# Obsidian upstream evidence corpus

Pass 1 observed on 2026-08-14. This document is the saturation corpus for Threadleaf's compatibility
claims against Obsidian's own public sources. It complements
[alternatives-landscape.md](alternatives-landscape.md), which audits competing FOSS applications, not
Obsidian itself. Nothing here grants a compatibility level; [contract.md](../compatibility/contract.md)
remains the normative evidence policy, and a level still requires an executable fixture.

## Scope: the six declared seams

1. Vault, link, and frontmatter semantics.
2. Plugin API surface.
3. Theme and CSS contract.
4. JSON Canvas.
5. Sync and conflict behavior, as publicly documented.
6. Packaging and installer surface.

## Authority map

| Seam | Primary authority | Domain note |
| --- | --- | --- |
| Vault/link/frontmatter | [`docs.obsidian.md/Reference/TypeScript+API`](https://docs.obsidian.md/Reference/TypeScript+API/Vault) (developer contract) plus [`obsidian.md/help`](https://obsidian.md/help/properties) (user-facing behavior) | `docs.obsidian.md` is the plugin/theme developer site; general vault behavior for end users is published on a separate `obsidian.md/help/*` tree (source repository `obsidianmd/obsidian-help`). Both are first-party. `help.obsidian.md` redirects (301) to `obsidian.md/help/*`. |
| Plugin API surface | `docs.obsidian.md/Reference/TypeScript+API/*`, [`docs.obsidian.md/Reference/Manifest`](https://docs.obsidian.md/Reference/Manifest), [`github.com/obsidianmd/obsidian-api`](https://github.com/obsidianmd/obsidian-api) | Same developer site already cited once in `plugins.md`. |
| Theme/CSS contract | [`docs.obsidian.md/Reference/CSS+variables`](https://docs.obsidian.md/Reference/CSS+variables/CSS+variables), `docs.obsidian.md/Themes/App+themes/Build+a+theme` | Developer site. |
| JSON Canvas | [`jsoncanvas.org/spec/1.0/`](https://jsoncanvas.org/spec/1.0/), [`github.com/obsidianmd/jsoncanvas`](https://github.com/obsidianmd/jsoncanvas) | Independent open-format site, MIT-licensed, still under the `obsidianmd` GitHub org. Not part of `docs.obsidian.md`. |
| Sync/conflict (publicly documented) | `obsidian.md/help/obsidian-sync` and `.../troubleshoot-obsidian-sync`, [`obsidian.md/changelog`](https://obsidian.md/changelog/), [`github.com/obsidianmd/obsidian-headless`](https://github.com/obsidianmd/obsidian-headless) | Obsidian Sync itself is a proprietary paid service; only its publicly documented *behavior* is in-scope evidence, never its server protocol. |
| Packaging/installer | [`obsidian.md/download`](https://obsidian.md/download), `obsidian.md/changelog`, `github.com/obsidianmd/obsidian-releases` | Public download/release surface. |

Forum threads (`forum.obsidian.md`) surfaced during research are cited only where explicitly marked as
prioritization evidence, never as a technical contract, per the rules of evidence for this pass.

## Material findings folded in from this build's local evidence

These come from sibling work already landed in this repository as of the base commit; they are
reconciled into the per-seam sections below rather than re-derived.

- **Obsidian behavior lab**: a real Obsidian 1.13.7 binary now runs in a sandbox and has produced a
  byte-equal vault round trip, plus an observed *bounded* `.obsidian/` normalization subset: opening
  and using a vault causes Obsidian itself to rewrite `app.json`, `appearance.json`,
  `core-plugins.json`, and `workspace.json`. This is a new evidence class distinct from documentation:
  direct behavioral observation of the unmodified upstream application, which `contract.md` and
  `plugins.md` already treat as the missing piece for several "unverified until a person runs it"
  claims (for example `plugins.md`'s Excalidraw official-observation caveat and the roadmap's Phase 3
  disposable-vault round-trip item). It is folded into the vault/link/frontmatter seam below.
- **Real target vault scale**: the representative target vault is approximately 229,000 files, of
  which only approximately 21,000 are notes. Roughly 91% of vault entries are therefore non-note
  attachments, dotfiles, or other content. This reframes which upstream authority governs the
  perf-adjacent portion of the vault/link/frontmatter seam (ignored-file and attachment-location
  behavior), folded in below. It does not change the plugin, theme, canvas, sync, or packaging seams.
- **Community theme fixtures**: `minimal`, `sanctum`, and `wikipedia` are now SHA-256-pinned fixtures.
  This is provenance hygiene for the theme/CSS seam's existing claims; it does not by itself change
  authority, disposition, or the CSS-variable stability finding below.

## Seam 1: Vault, link, and frontmatter semantics

**Current corpus claims**: [`same-vault.md`](../compatibility/same-vault.md) and
[`contract.md`](../compatibility/contract.md) (Same-vault behavior corpus, Complex properties sections)
describe a corpus covering links, aliases, heading/block anchors, embeds, attachments, typed and
malformed frontmatter, rename rewrites, Unicode/ambiguity, external atomic saves, JSON Canvas byte
preservation, and `.obsidian/` coexistence. `roadmap.md`'s dot-prefixed-tree exclusion and the
migration preview's five-file source boundary (`community-plugins.json`, `appearance.json`,
`hotkeys.json`, `workspace.json`, `workspace-mobile.json`, per [`migration.md`](../compatibility/migration.md))
are the concrete file-level claims.

**Checked against live sources**:

- Property types: [`obsidian.md/help/properties`](https://obsidian.md/help/properties) documents
  exactly six types: Text, List, Number, Checkbox, Date, Date & time. Date is `YYYY-MM-DD` and
  Date & time is `YYYY-MM-DDTHH:MM:SS`. This matches `contract.md`'s claim of "text, list, number,
  checkbox, date, and datetime values" exactly. **Confirmed, no drift.**
- `tags`, `aliases`, and `cssclasses` are documented as special-cased default properties. Threadleaf's
  own test suite (`src/runtime/obsidian-vault-write.test.ts`) already exercises `cssclasses` through
  `parseFrontMatterEntry`. **Confirmed, no drift.**
- Hidden-file handling: Obsidian's default behavior does not index dot-prefixed hidden files, and a
  separate Settings → Options → Excluded files glob list (patterns like `desktop.ini`, `*.ini`) exists
  for additional exclusions. Threadleaf's own bootstrap already "excludes dot-prefixed trees"
  (`roadmap.md`, Phase 2). **Confirmed, no drift on the dot-prefix rule.** The glob-pattern Excluded
  Files setting is not currently modeled anywhere in Threadleaf's compatibility docs; recorded as an
  open item below, not a correction, since no existing claim asserts otherwise.
- Attachment location: the default-attachment-location setting (Settings → Files & Links) is
  documented; Threadleaf's own attachment-handling claims in `contract.md` do not depend on this
  setting's exact value (they classify by magic bytes, not by folder), so no correction is needed.
- `docs.obsidian.md/Reference/TypeScript+API/getFrontMatterInfo` confirms the signature
  `getFrontMatterInfo(content: string): FrontMatterInfo` returning frontmatter presence, offsets, and
  raw text; the fetched page excerpt did not surface the full `FrontMatterInfo` field list (see Pass 2
  residual gap below).
- A direct fetch of a "Files and folders" concept page at the guessed slug
  (`obsidian.md/help/files-and-folders`) 404'd. The correct slug was not resolved within this pass's
  budget. **Recorded as an evidence gap, not a claim either way**; see Pass 2.

**New finding: Bases (not previously in the corpus)**. Obsidian shipped **Bases** as a core
(built-in, not community) plugin. `.base` files are YAML, are first-class vault entities that can be
opened directly in tabs, and can be embedded in Markdown via `[[filename.base]]` or
`[[filename.base#ViewName]]` syntax or as a code block. Per `obsidian.md/help/bases`: "All the data in
Obsidian Bases is stored in your local Markdown files and their properties": a Base is a *view/query*
definition over existing frontmatter, not a separate data store. Shipped view types are Table, List,
Cards, and Map; Kanban and Calendar views are listed as "Active (in progress)" on
[`obsidian.md/roadmap`](https://obsidian.md/roadmap/), i.e. not yet shipped. The real Obsidian CLI
(see Seam 6 and the packaging section) already exposes `bases`, `base:views`, `base:create`, and
`base:query` verbs. **Threadleaf's same-vault corpus, `same-vault.md`, and `contract.md` do not
mention Bases at all.** This is not a claim error: nothing in the existing corpus asserts Bases is
covered or excluded, but it is a real gap. `.base` is a new vault-native file format that the
same-vault corpus's manifest/cases schema could represent (at minimum as an opaque byte-preserved
file, matching the existing JSON Canvas treatment) but currently does not.

**Fold-in: behavior lab normalization subset**. The lab's observed set (`app.json`, `appearance.json`,
`core-plugins.json`, `workspace.json`) partially overlaps Threadleaf's own migration-preview source
list (`appearance.json`, `workspace.json` appear in both; `app.json` and `core-plugins.json` do not
appear in Threadleaf's five-file list). This is not a contradiction: the migration-preview list is a
deliberate, bounded scope for what Threadleaf's *preview* reads, not a claim about what Obsidian
itself touches. But it is now evidence, backed by direct observation of the real application rather
than inference, that a migration-preview snapshot of `appearance.json`/`workspace.json` can go stale
simply from the user relaunching real Obsidian, a staleness path the existing SHA-256 source-receipt
and "stale source receipts... refused without a write" mechanism in `migration.md` already defends
against structurally. No correction is needed to `migration.md`'s claims; this strengthens the existing
staleness-defense rationale with a concrete, cited trigger. Whether `app.json` and `core-plugins.json`
belong in a future expansion of the five-file list is a product/roadmap decision outside this lane's
scope (no product code, no roadmap edits here); recorded as an open item.

**Fold-in: real target vault scale (~229k files / ~21k notes)**. At this ratio, the vast majority of
vault entries are the non-note files governed by the ignored-file/hidden-file/attachment-location
behavior above, not by note-level link/frontmatter semantics. No official Obsidian source reached in
this pass states an explicit vault-size or file-count ceiling; absence of a stated limit is reported
honestly as **inconclusive**, not as either a safety guarantee or a risk. This matters because
Threadleaf's own perf corpus (`docs/performance.md`, out of this lane's edit scope) is therefore
testing beyond any officially declared upstream bound in either direction.

**Disposition**: **Depend** on the documented property-type and hidden-file semantics (already
matched, keep as-is). **Extract** the Bases view/query concept and its YAML `.base` shape as a future
same-vault case category (byte-preservation first, matching the existing JSON Canvas treatment).
This is a corpus-scope recommendation, not a code change made here. **Benchmark** is not applicable;
there is no vault-size ceiling to benchmark against in upstream's own documentation.

**Open risks**:
- Bases is unaddressed in the same-vault corpus; a vault containing `.base` files has undefined
  Threadleaf behavior today (untested, not necessarily unsafe, since generic attachment handling
  should still apply byte-for-byte, but this is not proven by an executable case).
- The exact `obsidian.md/help/files-and-folders`-equivalent page was not located in Pass 1.
- The Excluded Files glob-pattern setting is not modeled in any Threadleaf compatibility claim.

## Seam 2: Plugin API surface

**Current corpus claims**: [`plugins.md`](../compatibility/plugins.md) and
[`open-plugin-api.md`](../compatibility/open-plugin-api.md) describe the manifest field set, the
Markdown post-processor family (`registerMarkdownPostProcessor`, `registerMarkdownCodeBlockProcessor`,
`MarkdownPostProcessorContext`, `MarkdownRenderChild`), `FileSystemAdapter` methods, and utility
bridges (`prepareFuzzySearch`, `htmlToMarkdown`, `Menu`, `debounce`, `Platform`).

**Checked against live sources**:

- `docs.obsidian.md/Reference/Manifest` confirms the exact field set `plugins.md` and
  `package-inspection.md` already claim: `id`, `name`, `version`, `minAppVersion`, `description`,
  `author`, `authorUrl`, `isDesktopOnly` (required for plugins), `fundingUrl` (optional). No
  cross-plugin dependency field exists. **Confirmed, matches `plugins.md` lines 124-127 exactly, no
  drift.**
- `docs.obsidian.md/Plugins/Editor/Markdown+post+processing` confirms
  `registerMarkdownPostProcessor` "runs after the Markdown has been processed into HTML" and lets a
  plugin "add, remove, or replace HTML elements," and confirms `registerMarkdownCodeBlockProcessor`
  for fenced code blocks, consistent with `open-plugin-api.md`'s framing. The fetched excerpt of this
  guide page did not itself surface `sortOrder` ordering, `docId`, `getSectionInfo`, or `addChild`
  semantics; those are more precisely specified in the generated
  `Reference/TypeScript+API/MarkdownPostProcessorContext` and `MarkdownRenderChild` pages, which exist
  in the site's structure but were not independently re-fetched line-by-line in this pass. **Partial
  confirmation**: broad contract intact, fine-grained signatures not independently re-derived this
  pass (see Pass 2).

**New finding: Bases API**. `obsidian.md/roadmap` records "Bases API" as already shipped (November
2025, per the roadmap's launched timeline). This is a plugin-facing API surface (for third-party Bases
formulas/views) that neither `plugins.md` nor `open-plugin-api.md` currently mention. Same category of
gap as Seam 1's Bases finding: not a claim error, but unaddressed surface.

**Context, not a contract claim**: the real Obsidian desktop CLI (Seam 6) now exposes
`plugins`/`plugin:enable`/`plugin:install`/`plugin:uninstall`/`plugin:reload` verbs. This validates,
as prioritization signal only, the direction of `roadmap.md`'s own unchecked item ("Keep GUI-active
commands... plugin/theme mutations... out until a headless authority and behavior corpus exist").
Upstream has already gone further in this direction. This is not a compatibility requirement (CLI
verb parity is not part of the plugin API surface), and `docs/cli.md` is outside this lane's edit
scope; recorded here only as landscape context for whoever owns that roadmap item.

**Disposition**: **Depend** on the confirmed manifest and Markdown-post-processor contract (already
implemented, matches). **Reject** copying the guide page's prose; the generated TypeScript Reference
pages remain the correct normative source for exact signatures. **N/A** for Bases API: no Threadleaf
plugin-facing surface exists yet to compare against.

**Open risks**:
- The fine-grained `MarkdownPostProcessorContext`/`MarkdownRenderChild` claims in `open-plugin-api.md`
  were not independently re-derived from the TypeDoc reference pages this pass; they are unchanged
  from before this pass, not newly falsified.
- Bases API is unaddressed.

## Seam 3: Theme and CSS contract

**Current corpus claims**: [`themes.md`](../compatibility/themes.md) describes a cascade (Threadleaf
baseline → community `theme.css` → snippets), compatibility aliases for app container, title bar,
workspace splits, tabs, file navigation, Markdown views, inline title, and status bar, and baseline
variables for background/text/accent/icon/font/radius/file-margin.

**Checked against live sources**:

- `docs.obsidian.md/Reference/CSS+variables/CSS+variables` confirms the reference is organized into
  six categories: **Foundations** (colors, spacing, typography, borders, cursor, icons, layers,
  radiuses), **Components** (buttons, checkboxes, dialogs, modals, popovers, sliders, tabs, text
  inputs), **Editor** (blocks, code, headings, links, lists, tables), **Plugins** (Canvas, File
  explorer, Graph, Search; core-plugin-specific variables), **Window** (ribbon, scrollbar, status
  bar, workspace chrome), and **Obsidian Publish**. Threadleaf's baseline categories (background,
  text, accent, icon, font, radius, file-margin) map onto the Foundations tier. **Broadly confirmed,
  no drift in the category taxonomy.**
- **No stated stability or versioning policy for CSS variables was found on the reference page.**
  Obsidian publishes no deprecation policy, no "stable vs. internal" distinction, and no semantic-
  versioning guarantee for these variables.

**Disposition**: **Extract** the six-category taxonomy as a structural checklist for future
compatibility-alias coverage (Components and Window remain thin today). **Adapt**, not **Depend**: because
there is no stability contract, each Threadleaf alias must be treated as re-verifiable per Obsidian
version bump rather than a one-time capture, which is a materially different maintenance posture than
if a stability guarantee existed.

**Open risks**:
- **Elevated, newly-explicit risk**: any CSS variable Threadleaf aliases against could be renamed or
  removed in a future Obsidian point release with no deprecation notice, because none is promised.
  This was previously an implicit assumption; it is now a cited fact. It changes risk framing, not
  disposition or authority (the authority was already known to be the live app's CSS, not a frozen
  spec); recorded per the saturation gate's own criteria for what counts as material.
  Community-theme fixture pinning (`minimal`/`sanctum`/`wikipedia` SHA-256, folded in above) is the
  correct mitigation already in place: pinned fixtures make drift detectable rather than assumed away.
  This is unaffected by the variable-stability gap and remains sufficient.
- The "Plugins" CSS category includes Canvas-view variables, which Threadleaf cannot yet target
  because JSON Canvas (Seam 4) is unimplemented. Sequencing note, not a new risk.

## Seam 4: JSON Canvas

**Current corpus claims**: `contract.md` lists "JSON Canvas byte preservation" as part of the
same-vault corpus's coverage (i.e., an existing `.canvas` file is treated as an opaque, byte-preserved
attachment during operations Threadleaf already supports). `roadmap.md` Phase 5 lists "JSON Canvas
editing and embedding plus first-class attachment browsing, rename, preview, drag-and-drop, paste, and
missing-file recovery" as unshipped. These two claims are consistent, not contradictory: byte
preservation of an opaque file is a strictly weaker claim than semantic editing support, the same
distinction pattern already used for the Excalidraw round-trip corpus (byte vs. semantic comparisons).

**Checked against live sources**:

- `jsoncanvas.org/spec/1.0/` confirms: extension `.canvas`; top level is `{ nodes: [...], edges: [...] }`,
  both optional arrays. Every node has required `id`, `type`, `x`, `y`, `width`, `height` and optional
  `color`. Text nodes add required `text` (Markdown-flavored plain text). File nodes add required
  `file` and optional `subpath`. Link nodes add required `url`. Group nodes add optional `label`,
  `background`, `backgroundStyle`. Edges require `id`, `fromNode`, `toNode`, with optional `fromSide`,
  `fromEnd`, `toSide`, `toEnd`, `color`, `label`.
- License: **MIT**, confirmed via `jsoncanvas.org`. Maintainer: still the `obsidianmd` GitHub org.
  Version: still 1.0, dated 2024-03-11, over two years stable across many Obsidian app releases,
  including the jump to 1.13.7. The format has not drifted even though the host application has.
- The spec page's content is schema-only; it contains no interaction/UI section. Obsidian's own Canvas
  *view* (drag/drop, grouping gestures, edit affordances) is therefore necessarily outside the open
  spec's scope by construction, not by an explicit disclaimer found on the page. Any Threadleaf Canvas
  editor UI must be independently designed against the schema, not derived from Obsidian's
  implementation, which is proprietary application behavior outside the clean-room boundary.

**Disposition**: **Depend.** This is the cleanest seam in the corpus: an MIT-licensed, stable,
schema-only open format with a single first-party authority and no application code entanglement.
Implementing `.canvas` read/write directly against the spec is lower-risk than any other seam here.
The interaction design remains **Reject** for reuse (must be independently designed; nothing to
depend on or extract from a proprietary UI).

**Open risks**: none material. The one caveat is confidence, not risk: the "UI is out of spec" framing
above is a reasoned inference from the spec page's content (schema-only, no UI section), not an
explicit sentence found on the page stating so. See Pass 2.

## Seam 5: Sync and conflict behavior, as publicly documented

**Current corpus claims**: none. No existing Threadleaf compatibility doc cites Obsidian Sync. The
closest related material is `roadmap.md`'s own "Future lane: encrypted sync service," which commits
Threadleaf to a self-hostable, end-to-end-encrypted, versioned-object protocol, an intentionally
different design, not a claim of Obsidian Sync compatibility.

**Checked against live sources** (via `obsidian.md/help/obsidian-sync`,
`.../troubleshoot-obsidian-sync`, `obsidian.md/changelog`, and `github.com/obsidianmd/obsidian-headless`):

- Markdown files: Sync merges conflicting changes automatically using Google's diff-match-patch
  algorithm by default.
- All other files, including `.canvas`: "last modified wins", no merge attempt.
- Since Obsidian 1.9.7, Settings → Sync → Conflict resolution is user-configurable between
  "Automatically merge" (default; Obsidian's own documentation states this "may sometimes create
  duplicate text or formatting problems" requiring manual cleanup) and "Create conflict file" (writes
  a separate file for manual review).
- `obsidian-headless` (npm, requires Node.js 22+, MIT-adjacent open-source repository under
  `obsidianmd`) was introduced with Obsidian 1.12 (February 2026) as a scriptable Sync client:
  `ob login`, `ob sync-list-remote`, `ob sync-setup`, `ob sync --continuous`. No documented `pull`,
  `push`, or `status` subcommands as of this pass.
- The real desktop Obsidian CLI (Seam 6) independently exposes a `sync:*` verb family:
  `sync [on|off]`, `sync:status`, `sync:history`, `sync:read`, `sync:restore`, `sync:open`,
  `sync:deleted`, implying per-file versioned history is part of Sync's own public operational
  surface, not merely its marketing description.

**Disposition**: **Reject** the Obsidian Sync protocol itself as a dependency target: it is a
proprietary paid service with no open specification, correctly out of clean-room bounds and correctly
not pursued by `roadmap.md`. **Extract** the conflict-UX concepts as validating evidence, not as a
source of new requirements: Threadleaf's existing choice (always write keep-both conflict copies,
documented throughout `contract.md`'s attachment-publication and editor sections) is *more*
conservative than Obsidian's own default behavior, whose documentation admits the default
"automatically merge" path can corrupt content and require manual fixing. This is a genuine point in
favor of Threadleaf's already-made design decision, worth recording as such rather than silently
assumed. **Prioritization-only**: `obsidian-headless`'s verb shape (`ob login`, `ob sync --continuous`)
is landscape awareness for whenever the encrypted-sync roadmap lane starts CLI design, not a
requirement.

**Open risks**: none that change authority or disposition. This seam had zero prior corpus
engagement; Pass 1's main contribution is establishing the authority map and confirming Threadleaf's
existing implicit design choice is already the safer one relative to documented upstream behavior.

## Seam 6: Packaging and installer surface

**Current corpus claims**: `roadmap.md` Phase 5 lists shipped unsigned Linux x64 AppImage and RPM
artifacts, reproducible unpacked trees, native macOS ARM64 ZIP/DMG, and a manual update controller;
unshipped signed Windows/macOS/Linux installers, notarization, and a signed update-feed rehearsal.
`docs/releases.md` (out of this lane's edit scope) holds the operational detail.

**Checked against live sources**:

- `obsidian.md/download` documents: Windows universal `.exe`; macOS universal `.dmg`; Linux direct
  downloads as AppImage, Deb, and an ARM64 AppImage variant, plus Snap (official) and Flatpak
  (community-maintained). **No RPM is offered by upstream Obsidian at all.** Threadleaf's own RPM
  artifact is therefore an independent product decision, not something upstream sets a compatibility
  precedent for; there is no upstream RPM convention to diverge from or match. The page carried no
  statement on code signing or notarization for any platform, and no auto-update description; the page
  links to `obsidian.md/changelog` for release history but does not itself describe an update
  mechanism. **Recorded as an evidence gap, not asserted either way**: this pass does not claim
  Obsidian's Windows/macOS builds are or are not signed/notarized.
- `github.com/obsidianmd/obsidian-releases` has a live GitHub Releases page (confirmed via search
  indexing), already cited once in `plugins.md` for `community-plugins.json`; it is the same
  repository, not a separate app-release channel, so no new citation is needed beyond what
  `plugins.md` already has.
- Version cadence: 1.13.7 released 2026-08-12 (two days before this pass), a patch release fixing a
  macOS filename-display bug, inline-math rendering, pop-out image resizing, a duplicate CSS-snippet
  listing, and disabled-control styling. This confirms the task's stated "Obsidian is at 1.13.7 now"
  and gives an exact date for future drift comparisons.
- The real desktop CLI requires "Obsidian 1.12+" and requires the GUI app to already be running; it is
  not a standalone headless binary. This is a relevant packaging-surface data point: upstream's own
  CLI has a hard dependency on the packaged desktop app process, unlike a fully headless tool.

**Disposition**: **N/A / informative-only** for RPM (no upstream convention exists to compare
against). **Extract** the observed installer-format matrix (per-OS universal single-artifact installers,
Linux multi-format) as a landscape reference for `docs/releases.md`'s own planning, without a
corresponding edit here. **Benchmark** is not applicable; no signing/notarization baseline was
confirmable from the reached pages.

**Open risks**:
- Code signing/notarization status of upstream's own Windows/macOS builds remains unconfirmed by this
  pass; do not cite it as either present or absent without a better source.
- Snap (official Linux channel) is not currently in Threadleaf's packaging roadmap at all; not a gap
  against any existing claim, just an unclaimed option.

## Pass 1 saturation receipt

- **Date**: 2026-08-14.
- **Seams covered**: all six.
- **Sources fetched** (WebFetch unless marked WebSearch):
  - `https://docs.obsidian.md/Home`
  - `https://obsidian.md/roadmap/`
  - `https://docs.obsidian.md/sitemap.xml`
  - `https://jsoncanvas.org/spec/1.0/` and `https://jsoncanvas.org/`
  - `https://obsidian.md/help/bases` (redirected from `help.obsidian.md/bases`)
  - `https://docs.obsidian.md/Reference/Manifest`
  - `https://docs.obsidian.md/Plugins/Editor/Markdown+post+processing`
  - `https://docs.obsidian.md/Reference/CSS+variables/CSS+variables`
  - `https://docs.obsidian.md/Reference/TypeScript+API/getFrontMatterInfo`
  - `https://obsidian.md/help/cli`
  - `https://obsidian.md/help/properties` (redirected from `help.obsidian.md/properties`)
  - `https://obsidian.md/help/files-and-folders` (redirected; 404 at this slug)
  - `https://obsidian.md/download`
  - WebSearch: JSON Canvas spec/version status; Bases documentation and file format; Sync conflict-file
    documentation; Obsidian 1.13.7 release notes; Obsidian Sync headless client/CLI documentation;
    `obsidian.md/help` attachments/hidden-files guidance.
- **Changes made**: created this document. No other file touched (no correction to any
  `docs/compatibility/*.md` claim was required: every claim checked against a live source was either
  confirmed accurate or already honestly scoped as unshipped; the gaps found are additions of new
  upstream surface, not falsifications of existing claims).
- **Gate state**: open, pending Pass 2. Pass 2 is a separate bounded pass run after this document is
  committed; see the project's saturation gate for its own receipt once run.

## Reuse ledger addendum

| Seam | Disposition | Basis |
| --- | --- | --- |
| Vault/link/frontmatter | Depend (confirmed subset); Extract (Bases as future case category) | Property types and hidden-file rules match live docs exactly; Bases is new, uncovered surface. |
| Plugin API surface | Depend (confirmed subset); N/A (Bases API) | Manifest and Markdown post-processor contract match; no Threadleaf-side Bases-API consumer exists to evaluate. |
| Theme/CSS contract | Adapt | No upstream stability guarantee exists, so alias coverage is inherently a re-verify-per-release posture, not a one-time capture. |
| JSON Canvas | Depend (format); Reject (UI reuse) | MIT, stable two years, schema-only, single first-party authority; the cleanest seam. Interaction design has nothing to depend on. |
| Sync/conflict | Reject (protocol); Extract (conflict-UX validation only) | Proprietary paid service, correctly out of clean-room bounds; documented default behavior validates Threadleaf's already-chosen conservative conflict handling. |
| Packaging/installer | N/A (RPM); Extract (format-matrix awareness) | No upstream RPM precedent exists to diverge from; installer-format landscape is informative only. |

## Stop conditions this corpus would raise

Following the same convention as `alternatives-landscape.md`: this corpus would require stopping and
re-opening the gate before further compatibility-claim work if any of these occur:

- an upstream source is found asserting a compatibility claim in `docs/compatibility/*.md` is
  factually wrong (none found in Pass 1; all checked claims held; re-check in Pass 2);
- Obsidian ships a breaking change to the manifest schema, the Markdown post-processor family, or the
  JSON Canvas format (none found as of Pass 1; re-check in Pass 2);
- Obsidian publishes a CSS-variable stability/deprecation policy where none exists today (would
  *reduce* Seam 3's risk, still material enough to record);
- a `.base` file appears in a real fixture or user report and Threadleaf's handling of it is
  unspecified in production (currently a documentation gap, not yet an incident).
