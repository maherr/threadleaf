# Tag implementation seams

**Discovery date:** 2026-08-15
**Scope:** a bounded public-HTTPS and local-source pass for first-class tags in parsing, reading view, live preview, indexed search, and the left sidebar. No upstream repository was cloned, fetched, built, installed, or executed. No proprietary application, decompiled resource, or binary behavior lab was read or used. No upstream code will be copied.

## Decision in one screen

**Adapt Threadleaf's existing per-file metadata reactor into a case-insensitive derived tag catalog, add an explicit `tag:` filter to the existing search index, and render the same tag identity as native anchors in reading view and CodeMirror widgets in live preview.** The tag pane is a lazy sibling view inside the existing left navigator. It reads the current index generation and never becomes a second source of truth.

Tag bodies in this lane accept Unicode letters and digits plus `_`, `-`, and `/`, with at least one nonnumeric character. Display spelling is preserved from source while matching and aggregation use Threadleaf's existing Unicode search folding. A nested tag contributes to its own row and every parent row. A parent filter matches the exact tag and descendants.

This is a deliberately narrower grammar than the broader symbol support described by Obsidian Help. The lane plan explicitly fixes the accepted body characters, so the implementation follows that contract and records the difference instead of inventing a wider compatibility claim.

## Decision gate and local constraints

| Question | Decision | Reason and local proof obligation |
| --- | --- | --- |
| Source authority | Depend on saved Markdown and the existing `VaultIndexReactor` | `MetadataIndex.refresh`, `remove`, `move`, and rebuild already cover autosave, create, delete, rename, and external watcher batches. Tags must travel through those same paths. |
| Parsing | Extract one shared source-range model before indexing or rendering | One grammar and exclusion boundary must cover frontmatter, fenced code, inline code, Markdown links, numeric-only bodies, Unicode, and nesting without renderer-specific drift. |
| Casing | Preserve first deterministic display spelling, match by folded key | Official Help says matching is case-insensitive while the Tags view keeps a display spelling. Rebuilding from sorted current documents makes the representative stable across incremental and clean rebuild paths. |
| Search | Extend the existing query parser with `tag:` filters | The current ranked full-text index already owns query limits, result ordering, and renderer navigation. A tag filter should constrain candidates, not create a parallel search surface. |
| Tag pane | Add a lazy navigator sibling view backed by an explicit tag-catalog bridge | The normal workspace snapshot and file list are intentionally bounded. All tags are fetched only when the tag view is active and are guarded by vault ID plus generation. |
| Reading view | Add a Markdown-It inline token rendered as `a.tag` | Markdown-It already suppresses inline rules inside code and exposes link nesting state. A tag token can therefore avoid links and code without post-processing rendered HTML. |
| Live preview | Replace inactive tag source with a CodeMirror `WidgetType`; reveal source on cursor proximity | This matches Threadleaf's existing live-preview link and embed architecture and preserves editability on the active line. |
| Dependency/code reuse | Reject | Threadleaf already has the parser masks, Markdown-It instance, CodeMirror widgets, virtual sidebar patterns, and incremental index needed for the lane. |

## Coverage ledger

| Seam | Source and pin | Authority | What it supports | Boundary |
| --- | --- | --- | --- | --- |
| User-facing tag syntax and navigation | [Obsidian Help: Tags](https://obsidian.md/help/tags), rolling first-party source checked 2026-08-15 | Product behavior documentation | Inline `#tag`, `tags` property, case-insensitive matching, nested `/` tags, parent queries including descendants, click-to-search, and a hierarchical Tags view | The lane's accepted character set is narrower by explicit plan. The document does not define Threadleaf's parser architecture. |
| Tags property | [Obsidian Help: Properties](https://obsidian.md/help/properties), rolling first-party source checked 2026-08-15 | Product behavior documentation | `tags` is a special list property; hashtags in unrelated text properties are not tags | Threadleaf additionally accepts scalar and comma-separated `tags` values because the lane requires them. |
| Public metadata boundary | [`CachedMetadata.tags`, `TagCache`, and `getAllTags` in `obsidian-api`](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts), generated rolling declaration checked 2026-08-15 | Public plugin API declaration | Inline tags have source positions and frontmatter tags combine with cached inline tags | The public API does not prescribe DOM structure, catalog IPC, or incremental storage. No implementation is copied. |
| Theme-facing tag tokens | [Obsidian developer docs: tag CSS variables](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Reference/CSS%20variables/Editor/Tag.md), rolling first-party source checked 2026-08-15 | Public theme documentation | Tag ink, hover ink, decoration, background, border, padding, radius, size, and weight are theme-adjustable concepts | Threadleaf maps these concepts onto its own stable tokens and does not claim byte-identical upstream CSS. |
| Reading-view parser seam | `markdown-it` 15.0.0 in `pnpm-lock.yaml`; [official API documentation](https://markdown-it.github.io/markdown-it/) and [MIT license](https://github.com/markdown-it/markdown-it/blob/15.0.0/LICENSE) | Exact local dependency plus first-party API | Inline rulers and renderer rules are the supported extension points; link nesting is parser state rather than an HTML guess | No plugin source or upstream rule body is copied. |
| Live-preview parser seam | `@codemirror/view` 6.43.8 and `@codemirror/state` 6.7.1 in `pnpm-lock.yaml`; [CodeMirror reference](https://codemirror.net/docs/ref/) | Exact local dependencies plus first-party API | `WidgetType`, replacement decorations, and editor-wide event handlers support a source-backed clickable presentation | Threadleaf retains its own cursor-proximity and async-lifecycle rules. |
| Hierarchical keyboard behavior | [WAI-ARIA APG tree view](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/), checked 2026-08-15 | W3C authoring guidance | `tree` and `treeitem`, parent `aria-expanded`, roving focus, arrow keys, Home, End, and Enter | The APG does not choose Threadleaf's counts, query syntax, or persistence model. |
| Existing scale and generation boundary | `docs/architecture.md`, `docs/performance.md`, `src/application/workspace-runtime.ts`, `src/renderer/navigator-tree.ts` | Local architecture authority | Derived indexes stay in main, renderer payloads carry generations, and high-cardinality sidebar data is lazy or bounded | The tag catalog may enumerate all tags only on explicit tag-view demand. It must not force full-file payloads back into startup. |

## Two independent expansion passes

### Pass 1: product contract and public API

Obsidian Help and the generated public API agree on the core model: inline and frontmatter tags combine, comparisons are case-insensitive, `/` defines nesting, a parent query includes descendants, clicking enters search, and the tag view is hierarchical. The public API's positioned `TagCache` also supports keeping extraction source-aware rather than rescanning rendered HTML.

This pass changed one local choice: a nested tag must contribute a derived parent row and a parent filter must match descendants even when no note contains the parent spelling directly. It did not justify a second persistent database or renderer-owned scan.

### Pass 2: implementation and accessibility seams

Markdown-It's documented inline ruler and renderer hooks, CodeMirror's documented widget and decoration APIs, and the W3C tree pattern independently fit the three existing Threadleaf seams. Reading view can emit native anchors during parse, live preview can replace only inactive source ranges, and the sidebar can reuse the established roving-focus tree interaction instead of making every row an unrelated tab stop.

This pass introduced no new dependency and no priority-0 design change. It confirmed that post-processing HTML, attaching handlers to mark decorations, or building a nested unbounded DOM tree would be weaker fits than the existing parser, widget, and virtual-tree paths.

## Chosen local shape

1. Add a source-range tag parser that masks frontmatter, code, comments, and Markdown links. Parse `tags` from the existing frontmatter property representation, normalize by folded key, and keep the first source spelling for display.
2. Extend `MetadataIndexSnapshot` with a derived tag catalog. Recompute that catalog from the current sorted in-memory documents after a per-file update, move, remove, or rebuild. This is proportional to indexed tag metadata, not note bytes, and preserves incremental file parsing.
3. Parse `tag:` filters separately from ordinary ranked terms. Match exact folded tag keys or the `<parent>/` prefix, AND multiple filters, and keep the current text ranking and limits for any remaining terms.
4. Expose the catalog through a vault-ID and generation-guarded bridge called only while the tag view is active. Refresh it when a newer workspace generation arrives.
5. Emit sanitized `a.tag` anchors in reading view, an equivalent CodeMirror tag widget on inactive lines, and native anchors for inspector property pills. Route all three to one renderer function that writes `tag:#<display>` into the existing vault search field and runs the existing result path.
6. Render a virtual, hierarchical visible-row projection in the left navigator. Parent rows expose descendant-inclusive counts and disclosure state; activation runs the same tag search. Reuse the existing tree keyboard contract and both theme token systems.

## Required executable proof

- Unit-test valid and invalid bodies, numeric-only rejection, frontmatter list/scalar/comma forms, case folding with display preservation, exclusion from links/code/fences, nested parents, and duplicate occurrences.
- Unit-test incremental upsert, delete, move, external watcher refresh, clean rebuild equivalence, case-only variants, and parent-filter descendant behavior.
- Prove the tag catalog request rejects stale vault/generation state and does not enter the startup snapshot.
- Register `test:tags` and drive a synthetic vault in real Electron under isolated Xvfb: type and autosave a tag, observe the live-preview pill, click into filtered results, open the tag pane, verify nested counts, add an external note, and observe the increment.
- Capture and judge the live tag pane and pills in both bundled themes with a visible positive-control assertion. Run the final repository gate and record its exit code.

## Rejected alternatives and bounded gaps

- **Rejected:** a persistent tag database or kernel schema migration. Tags are fully derived from saved Markdown and the existing in-memory index already has the required watcher lifecycle.
- **Rejected:** a full vault rescan on editor input. Autosave refreshes only the changed file; catalog aggregation reads cached tag metadata only.
- **Rejected:** an HTML post-processor that regexes rendered output. Markdown-It already knows code and link nesting, so post-processing would discard the safer parse context.
- **Rejected:** clickable CodeMirror mark decorations. Existing widget replacement gives a native anchor on inactive lines while active-line source remains directly editable.
- **Rejected:** a second tag-results UI. `tag:` extends the existing search and keeps one result authority.
- **Gap, consciously bounded:** tag rename, autocomplete, graph integration, and saved searches remain out of scope.
- **Gap, consciously bounded:** characters outside Unicode letters and digits plus `_`, `-`, and `/` are not recognized even though current Obsidian Help documents broader symbol support. This is the explicit lane contract, not an inferred product limitation.
