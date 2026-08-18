# Longstitch accessibility evidence

Measured 2026-08-15 against the live Longstitch token source.

Run the deterministic color gate from the repository root:

```sh
pnpm run longstitch:check
```

The gate reads [`tokens.css`](tokens.css), verifies that callout grounds remain shared materials,
checks each strong ink against the title, body, and surrounding surface, applies the Machado 2009
deuteranomaly matrices in linear RGB at severity 0.6 and 0.8, and compares all 78 category pairs
with CIEDE2000.

## Current result

| Theme | Check | Minimum | Limiting pair or state |
| --- | --- | ---: | --- |
| Pressroom | UI contrast | 3.2997:1 | warning ink against title material |
| Pressroom | Small text contrast | 5.073:1 | active navigator metadata against the selected-row ground |
| Pressroom | CIEDE2000, deutan 0.6 | 12.0834 | abstract / success |
| Pressroom | CIEDE2000, deutan 0.8 | 11.0267 | bug / example |
| Lampside | UI contrast | 3.1944:1 | danger ink against body material |
| Lampside | Small text contrast | 6.129:1 | active navigator metadata against the selected-row ground |
| Lampside | CIEDE2000, deutan 0.6 | 11.2409 | note / todo |
| Lampside | CIEDE2000, deutan 0.8 | 11.5207 | info / danger |

The hard gates are 3:1 for graphical boundaries and focus indicators, and CIEDE2000 11 or greater
for every categorical pair after simulation. All 78 pairs clear the stronger 11-point threshold in
both themes and at both severities.

The callout glyphs are graphical category marks and therefore use the 3:1 non-text threshold. A
live computed-style audit separately applies the 4.5:1 text threshold; selected navigator metadata,
the limiting small-text case, clears it in both themes.

The callout title and body backgrounds intentionally have no categorical separation. They are
shared material channels. Category is communicated by border and icon ink, a unique glyph, and the
written title. Reintroducing a category-dependent pale tint fails the automated gate.

## Non-color state cues

- Task states use shape, text treatment, and accessible names in addition to color.
- Navigator state uses an active-row treatment and a brass diamond in addition to thread color.
- Tags use a framed shape and text. Empty metadata uses a dashed frame and the word `Untagged`.
- Pass and failure concepts are never encoded as red versus green.
- Focus remains a visible outline with at least 3:1 contrast against the adjacent component ground.

Rendered verification also covers Pressroom and Lampside at desktop and narrow widths, task states,
table headers, callouts, tags, font loading, overflow, proportional text scaling, the empty-pane
creation action, and its visible remappable shortcut. The production Electron gates remain `pnpm
run test:live-preview`, `pnpm run test:tasks`, and the 16-case `pnpm run visual:check`; the design
color gate is additionally part of `pnpm run check`.
