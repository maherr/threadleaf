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

Modifier-clicking a rendered internal link requests navigation. A normal click reveals the source.
External links remain non-navigating in this release, matching Reading mode's safety policy.

## Honest fallback

Frontmatter, tables, HTML, math, malformed links, nested destinations that cannot be parsed without
guessing, and other unsupported constructs stay visible as source. Styling a source fallback is
allowed; replacing it with a lossy approximation is not.

## Acceptance gates

1. Toggling Live, Source, and Read never changes the CodeMirror document or undo history.
2. A task checkbox changes only its exact three-byte marker and enters the normal dirty, draft, save,
   and conflict paths.
3. Cursor movement reveals and re-hides syntax without moving the cursor or changing source.
4. Both panes may use different modes and keep independent selections and drafts.
5. Light and dark screenshots expose every affected component without color-only state.
6. Restart recovery, packaged-app smoke, upgrade rollback, and representative-vault source hashes
   remain green.
