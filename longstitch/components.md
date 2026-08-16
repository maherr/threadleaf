# Longstitch component grammar

**Last updated:** 2026-08-15

## Sewn navigator

Each tree row is gathered onto a dotted vertical thread at its depth station. The current note adds
a brass diamond knot, an active-row material, and `aria-current="page"`. Disclosure state remains a
separate chevron and accessible expanded state.

Required states: resting, hover, keyboard focus, current, collapsed branch, empty tree, and search
result. The thread may change value by theme, but hierarchy cannot depend on its color alone.

Forbidden default: a plain list of rounded rows with only a blue selection bar.

## Binding signatures

Pressroom carries an alternating red-cloth and cream headband across the navigator edge. Lampside
omits it and places a radial lamp pool along the status bar. Each signature appears only in its own
theme and never carries status meaning.

Required states: both signatures must survive desktop and narrow layouts without changing content
height, clipping controls, or creating horizontal overflow.

Forbidden default: showing both signatures together or treating the dark theme as a color-inverted
Pressroom.

## Working leaf

The open document uses Literata for note title, Markdown hierarchy, and reading prose; Hanken
Grotesk for application controls; and JetBrains Mono for paths, counts, tags, code, and compact
metadata. Raised and sunken materials describe page depth. The reading scale multiplies the inline
title and every heading level along with body text.

Required states: Live Preview, source, reading, loading, no selection, long title, and text scale up
to 1.8. Decorative marks cannot widen the content rail.

Forbidden default: one undifferentiated font voice or enlarged body copy under fixed-size headings.

## Foil-label tags

Tags are compact square labels with a brass frame and mono text. Hover and keyboard focus add the
blue interaction channel. An untagged state uses a dashed frame plus the visible word `Untagged`.

Required states: ordinary, nested path, hover, focus, selected navigator row, count, and untagged.

Forbidden default: generic rounded pills or hue-only hierarchy.

## Stitched tasks

Task markers retain their Markdown meaning in Live Preview and Reading view:

- open: empty square and ordinary text;
- completed: checked square and completed semantics;
- cancelled: dashed square with a dash, muted struck text, and cancelled semantics;
- question: brass question glyph, italic text, and question semantics;
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

Tabs, metadata fields, dialogs, menus, status rows, and commands inherit the same type roles, paper
or walnut layers, restrained radii, and blue interaction channel. Loading preserves the final
footprint. No support control introduces another metaphor.
