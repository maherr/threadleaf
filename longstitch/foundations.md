# Longstitch foundations

## Type

Longstitch ships three variable families, each with one job.

| Face | Job | Rule |
| --- | --- | --- |
| Literata | Optional reading prose and long-form display accents | Use only where a document benefits from a literary voice. Never use it for dense control chrome or machine facts. |
| Hanken Grotesk | Note titles, Markdown headings, navigation, controls, labels, and ordinary application prose | Carries the default workspace and keeps the hierarchy coherent. |
| JetBrains Mono | Paths, counts, statuses, tags, code, compact metadata | Carries machine truth. Keep it small but readable, and do not use it as the default voice. |

Reading hierarchy scales with `--threadleaf-text-font-scale`, including the inline title and all
Markdown heading levels. The scale changes the hierarchy proportionally instead of enlarging only
body text. At the default scale, reading-view H1 and H2 cap at 38px and 29px so document hierarchy
does not overpower the workspace. Code and machine metadata keep their separate roles, with 11px
as the absolute floor for visible application chrome.

## Color semantics

The exact values live only in [`tokens.css`](tokens.css).

| Role | Meaning |
| --- | --- |
| Paper and graphite surfaces | Depth and working material. Raised and sunken layers are structural, not status colors. |
| Primary, muted, and faint ink | Content hierarchy. Muted ink remains readable and faint ink is never used for load-bearing controls. |
| Violet interaction ink | Links, focus, selection, and actions. This is the only general interactive accent. |
| Borders and rails | Structure, active rows, and keyboard focus. Shape and labels accompany color. |
| Callout inks | Category border, icon, and focus ring only. Every category also has a glyph and visible title. |

Callout body and title grounds are shared across categories. A pale tint cannot safely distinguish
13 categories under deuteranomaly, so Longstitch does not pretend that it can. The strong ink set is
measured pairwise in both themes. See [`accessibility.md`](accessibility.md).

## Geometry

- Corners are cut and restrained: 3px, 5px, and 8px are the system radii.
- The 40px window rail is the native drag surface and the first workspace row. It aligns to the
  left file dock, center workspace, and right metadata dock, and reserves the operating system's
  window controls instead of stacking a second title bar above the app.
- Document tabs sit immediately below the rail. The active tab uses a 2px violet edge plus a
  material change; inactive tabs recede into the workspace chrome.
- Tags are square foil labels, not pills.
- Callouts are bounded sheets with a 4px categorical spine and a sunken title band.
- Navigator rows are 28px high, with full-row pointer targets and visible keyboard focus.
- The navigator header keeps identity and primary actions compact without clipping or hiding the
  current mode.
- Main reading width follows the existing Threadleaf content rail. Decorative marks cannot expand
  the document or create horizontal overflow.

One-off geometry is allowed only where a distinct workflow needs it, such as the image lightbox or
graph canvas. Ordinary dialogs, menus, and controls use the shared spacing and radius rules.

## State grammar

Task state is redundant by design:

- Open: empty box and ordinary text.
- Completed: checked box and completed semantics.
- Cancelled: dash glyph, dashed box, muted struck text, and cancelled semantics.
- Question: question glyph, brass treatment, italic text, and question semantics.
- Custom markers: their literal marker and a custom-state accessible label.

Native `checked` state is reserved for `x` and `X`. A custom marker is never exposed as completed
merely because it is non-empty.

Paper and Graphite preserve the same information architecture, target sizes, and state grammar.
Capability and reading order never depend on the selected theme.
