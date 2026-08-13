# Live Preview Compatibility Contract

Threadleaf Live Preview is an editing surface over canonical Markdown source. It never converts a
note, stores a rendered document, or changes source merely because it was displayed.

## Modes

- **Live** is the default editing mode for a fresh install.
- **Source** shows every source byte with the same CodeMirror editing, undo, draft recovery, and
  revision-aware save path.
- **Read** uses the existing sanitized reading renderer and may hydrate local images and note
  embeds.
- Each workspace pane keeps its own current document mode. The preferred editing mode survives a
  restart.

## Reveal rule

Live Preview hides presentation punctuation only on lines that have no cursor or selection. The
line containing any selection endpoint, plus every line crossed by a selection, shows exact source.
Clicking a rendered token moves the cursor to its source range and reveals that line. This is the
primary cursor-to-source invariant.

## Source/decorated mapping

The editor keeps one canonical UTF-16 source document for its editing session. CodeMirror uses LF
line separators internally; the load/save boundary records the external BOM and exact per-line
line-ending sequence and reconstructs it when saving. Newly inserted line breaks use the first
existing line-ending convention (or LF for a document with no existing break). Live Preview builds
a disposable projection with
`buildLivePreviewMapping(source)`. Its segments are half-open source and rendered ranges. A
segment is either an identity text slice, a source-backed label, a non-editable generated widget,
or a zero-width hidden delimiter. Mapping never decodes or normalizes the editor source string,
and saving an untouched document preserves its external representation.

Projection positions use an explicit selection affinity: `before` chooses the source side before a
hidden delimiter, `after` chooses the side after it, and `inside` chooses the nearest side of a
zero-width segment. Reverse mapping always returns a source offset; generated widget text is
anchored to its owning source range and cannot create a phantom editable position. Selections that
cross a mapped token therefore reveal its complete source line before editing.

Link, alias, emphasis, strike, inline-code, task, callout, list, footnote-reference, math, and
table delimiters are mapped only when their boundaries are unambiguous. A malformed link, nested
destination, ambiguous table, unsupported math command, or any token that fails the safe projection
check becomes one `fallback` identity range. Fallback ranges stay source-visible and are never
replaced by a widget or hidden delimiter.

Note transclusions are source-backed cards. `resolveInlineTransclusions` accepts a bounded local
document snapshot, carries the owning path and source range on every node, and stops on path plus
subpath cycles, depth, fragment, or byte limits. The renderer may show a short read-only excerpt,
but edits and source reveals always target the owning note. Missing, external, stale, and limited
targets remain visibly labeled rather than becoming generated editable text.

The following never become hidden state:

- Markdown text and destinations
- task state
- link and embed targets
- frontmatter
- fenced code
- unsupported or ambiguous syntax

## Rendered editing corpus

Outside an active source line, Live Preview renders or styles:

- ATX headings
- strong, emphasis, strikethrough, and inline code
- Markdown links and Obsidian wikilinks, including aliases and subpaths
- local raster image embeds, with a bounded placeholder when loading is unavailable
- note embeds as explicit source-backed cards
- task markers as editable checkboxes
- unordered and ordered lists
- blockquotes and callout markers
- fenced code blocks
- tags
- standard footnote references and definitions with unique, whitespace-free IDs
- GitHub-style pipe tables with a valid delimiter row and left, center, or right alignment
- bounded offline math for `\(...\)`, `$...$`, `$$...$$`, and `\[...\]`

Modifier-clicking a rendered internal link requests navigation. A normal click reveals the source.
External links remain non-navigating in this release, matching Reading mode's safety policy.

## Honest fallback

Frontmatter, duplicate or malformed footnotes, malformed or ambiguous tables, HTML, unknown or
malformed math, diagrams, malformed links, nested destinations that cannot be parsed without
guessing, and other unsupported constructs stay visible as source. An unresolved frontmatter
opening marker is fail-closed after a bounded 256-line scan and keeps the entire note source-only.
Styling a source fallback is allowed; replacing it with a lossy approximation is not. Reading and
Live widgets carry source line metadata, and activation returns to the exact source range; display
never rewrites Markdown.

The math renderer is intentionally offline and bounded. It accepts a small TeX-like vocabulary
for text, scripts, fractions, roots, Greek letters, operators, and a few text styles. It does not
load MathJax, KaTeX, fonts, URLs, plugins, or arbitrary HTML. Mermaid, Graphviz, Excalidraw, and
other diagrams remain unsupported.

The large-note regression fixture maps a note containing emphasis and inline math without
normalizing source. The fixture asserts finite output, bounded segment shape, and source/render
length invariants; it is not a machine-independent latency claim.

## Acceptance gates

1. Toggling Live, Source, and Read never changes the CodeMirror document or undo history.
2. A task checkbox changes only its exact three-byte marker and enters the normal dirty, draft, save,
   and conflict paths.
3. Cursor movement reveals and re-hides syntax without moving the cursor or changing source.
4. Both panes may use different modes and keep independent selections and drafts.
5. Light and dark screenshots expose every affected component without color-only state.
6. Restart recovery, packaged-app smoke, upgrade rollback, and representative-vault source hashes
   remain green.
