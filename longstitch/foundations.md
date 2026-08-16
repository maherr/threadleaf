# Longstitch foundations

## Type

Longstitch ships three variable families, each with one job.

| Face | Job | Rule |
| --- | --- | --- |
| Literata | Note titles, Markdown headings, reading prose, callout titles | Carries the book. Never use it for dense control chrome or machine facts. |
| Hanken Grotesk | Navigation, controls, labels, ordinary application prose | Carries the quiet workspace. It should recede beside note content. |
| JetBrains Mono | Paths, counts, statuses, tags, code, compact metadata | Carries machine truth. Keep it small but readable, and do not use it as the default voice. |

Reading hierarchy scales with `--threadleaf-text-font-scale`, including the inline title and all
Markdown heading levels. The scale changes the hierarchy proportionally instead of enlarging only
body text. Code and machine metadata keep their separate roles.

## Color semantics

The exact values live only in [`tokens.css`](tokens.css).

| Role | Meaning |
| --- | --- |
| Paper and walnut surfaces | Depth and working material. Raised and sunken layers are structural, not status colors. |
| Ink and parchment | Primary content. Soft and muted inks retain hierarchy without becoming disabled-state camouflage. |
| Blue interaction ink | Links, focus, selection, and actions. This is the only general interactive accent. |
| Brass | Binding hardware, active knot, and tag frames. It marks identity, not success or approval. |
| Red brand cloth | The Threadleaf mark and Pressroom headband. It is never a destructive-state code by itself. |
| Thread | Navigator hierarchy. The active brass knot and row state make the hierarchy readable without color alone. |
| Callout inks | Category border, icon, and focus ring only. Every category also has a glyph and visible title. |

Callout body and title grounds are shared across categories. A pale tint cannot safely distinguish
13 categories under deuteranomaly, so Longstitch does not pretend that it can. The strong ink set is
measured pairwise in both themes. See [`accessibility.md`](accessibility.md).

## Geometry

- Corners are cut and restrained: 3px, 5px, and 8px are the system radii.
- Tags are square foil labels, not pills.
- Callouts are bounded sheets with a 4px categorical spine and a sunken title band.
- Navigator rows are 40px high and tag rows are 44px high, preserving reliable pointer targets.
- The navigator heading is intentionally two rows: identity first, actions second. It must not
  compress Tree, Tags, and New into a clipped single row.
- Main reading width follows the existing Threadleaf content rail. Decorative marks cannot expand
  the document or create horizontal overflow.

One-off geometry is allowed only where the bindery metaphor carries information, such as the
headband, stitched spine, active knot, and lamp pool. Ordinary dialogs, menus, and controls continue
to use the shared spacing and radius rules.

## State grammar

Task state is redundant by design:

- Open: empty box and ordinary text.
- Completed: checked box and completed semantics.
- Cancelled: dash glyph, dashed box, muted struck text, and cancelled semantics.
- Question: question glyph, brass treatment, italic text, and question semantics.
- Custom markers: their literal marker and a custom-state accessible label.

Native `checked` state is reserved for `x` and `X`. A custom marker is never exposed as completed
merely because it is non-empty.

Pressroom and Lampside must preserve the same information architecture, target sizes, and state
grammar. Their signatures may differ, but capability and reading order do not.

