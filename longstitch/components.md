# Longstitch component grammar

**Last updated:** 2026-08-19

## File navigator

Each tree row uses compact, consistent indentation and a dedicated disclosure control. The current
note adds a violet side rail, an active-row material, and `aria-current="page"`. Disclosure state
remains a separate chevron and accessible expanded state.

Required states: resting, hover, keyboard focus, current, collapsed branch, empty tree, and search
result. Indentation and disclosure state remain readable without color.

Forbidden default: rounded card rows, clipped names, or color as the only selected-state cue.

## Window rail and document tabs

The top rail is both native window furniture and workspace navigation. The left segment carries
Threadleaf identity, the center segment names the active vault and its state, and the right segment
holds global search, settings, and theme actions before the operating system's own window controls.
Self-authored line icons share one weight and 30px target geometry. Every icon has an accessible
name and a shortcut-aware tooltip. The drag surface excludes all links and buttons.

Document tabs sit directly beneath the rail within each editor pane. The active tab changes both
material and lower-edge shape; pin and close remain explicit controls. Split panes retain their own
tab rows so ownership never becomes ambiguous.

Required states: Paper, Graphite, native Linux/Windows controls, macOS traffic lights, hover,
keyboard focus, one tab, many tabs, pinned tab, split panes, and the 860px minimum window.

Forbidden default: a native title bar stacked above app chrome, unlabeled glyphs, decorative
window furniture, or a global tab strip that obscures which split pane owns a tab.

## Theme signatures

Paper uses a neutral near-white editor canvas against light grey chrome. Graphite uses a dark editor
canvas against a deeper navigator and status layer. Violet marks the same interactive states in
both themes and never carries pass or failure meaning.

Required states: both bindings must survive desktop and narrow layouts without changing content
height, clipping controls, or creating horizontal overflow.

Forbidden default: decorative gradients, ornamental rails, or a dark theme that changes capability.

## Document workspace

The open document uses Hanken Grotesk for the default note title, Markdown hierarchy, prose, and
application controls; JetBrains Mono remains reserved for paths, counts, code, and compact metadata.
Raised and sunken materials describe depth. The reading scale multiplies the inline title and every
heading level along with body text.

Required states: Live Preview, source, reading, loading, no selection, long title, and text scale up
to 1.8. Decorative marks cannot widen the content rail. Visible application chrome never drops
below the 11px machine-metadata floor, and reading headings stay subordinate to the active note
title instead of jumping to display-poster proportions.

Forbidden default: one undifferentiated font voice or enlarged body copy under fixed-size headings.

## Tags

Tags are compact square labels with a neutral frame and readable text. Hover and keyboard focus add
the violet interaction channel. An untagged state uses a dashed frame plus the visible word
`Untagged`.

Required states: ordinary, nested path, hover, focus, selected navigator row, count, and untagged.

Forbidden default: oversized pills or hue-only hierarchy.

## Stitched tasks

Task markers retain their Markdown meaning in Live Preview and Reading view:

- open: empty square and ordinary text;
- completed: checked square and completed semantics;
- cancelled: dashed square with a dash, muted struck text, and cancelled semantics;
- question: question glyph, italic text, and question semantics;
- custom: literal marker shape and a custom-state accessible name.

Native `checked` state belongs only to `x` and `X`. Every state has text or shape in addition to
color.

Forbidden default: exposing every non-space marker as a completed checkbox.

## Callout folios

All 13 callout types use one raised body material and one sunken title material per theme. Category
is communicated by a measured strong-ink spine and icon, a distinct glyph, and the visible title.
Collapsible callouts add an explicit disclosure control; keyboard focus outlines the title band.

Required states: expanded, collapsed, focus, nested task content, unknown callout fallback, and plain
blockquote. Body and title grounds remain non-categorical.

Forbidden default: pale category tints, color-only identity, or a generic card shadow.

## Supporting controls

Tabs, metadata fields, dialogs, menus, status rows, and commands inherit the same type roles,
neutral layers, restrained radii, and violet interaction channel. Loading preserves the final
footprint. No support control introduces another metaphor.

Command results state the whole result count before the runnable subset. Disabled commands remain
visible with a reason, so capability and current availability are not conflated. A control whose
durable setting is still being saved becomes visibly unavailable until the save completes; a
second click is never accepted and silently discarded.

## Empty leaf and arrival states

An empty editor pane centers one answer: select an existing note or create a new one. The creation
action sits beside that answer and shows its current remappable shortcut. It calls the same shared
action as the navigator, native menu, and command palette. If the pane represents a missing or
otherwise unavailable document, the creation action is withheld so recovery evidence is not
mistaken for a blank workspace.

A fresh install opens the read-only welcome leaf, labels the current vault as a demo, and turns the
adjacent vault action into the explicit next step, **Open folder**. The welcome leaf explains that
the user's Markdown remains ordinary files before it demonstrates links, backlinks, outline, and
transclusion. Returning users keep their own restored workspace instead of seeing onboarding again.

Required states: no open note, writable vault, read-only vault, vault opening, missing note,
restoring private editing mode, keyboard focus, and a second empty split pane.

Forbidden default: explanatory empty-state prose with the primary action stranded in distant
chrome, or a button that bypasses the shared recovery-backed creation service.
