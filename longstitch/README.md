# Longstitch

**Category:** design language  
**Owner:** Threadleaf  
**Status:** live  
**Maturity:** bespoke  
**Signature:** A sewn navigator binds every note to a visible thread, with a brass knot marking the open leaf.  
**Themes:** Pressroom / Lampside  
**Runtime authority:** `tokens.css`  
**Reference implementation:** `../src/renderer/styles.css`  
**Adoption:** bespoke, not an adoption target; 1 owning app  
**Last verified:** 2026-08-15, live Electron in both themes at desktop and narrow widths

## Identity and referent

Longstitch is Threadleaf's bespoke design language: a working knowledge desk built with the visual
logic of a hand-bound book. Thread shows hierarchy, paper layers show depth, brass marks durable
identity, and machine text stays visibly separate from prose. Action state remains blue and never
depends on the decorative brass or red brand cloth.

## Signature

A sewn navigator binds every note to a visible thread, with a brass knot marking the open leaf.
The metaphor changes structure rather than decorating a generic workspace: tree rows hang from the
thread, the current note is tied to it, and note content reads as the working leaf beside the spine.

## Themes

- **Pressroom:** warm paper, ink blue, brass, and an alternating two-color cloth headband.
- **Lampside:** walnut, parchment ink, quiet blue, and a low pool of lamplight in the status bar.

They are related bindings, not a light theme with a dark inversion. Pressroom alone carries the
headband; Lampside alone carries the lamp pool. Information architecture and state semantics stay
the same.

## Folder map

- [`tokens.css`](tokens.css): canonical runtime tokens and both themes.
- [`foundations.md`](foundations.md): type, material, color, geometry, and state rules.
- [`components.md`](components.md): component anatomy, required states, and forbidden defaults.
- [`accessibility.md`](accessibility.md): measured color, contrast, task, and scaling evidence.
- [`adoption.md`](adoption.md): portable principles and the identity-bound boundary.
- [`previews/index.html`](previews/index.html): offline two-theme specimen.
- [`audit-colors.mjs`](audit-colors.mjs): deterministic WCAG and deuteranomaly gate.

## Authority and use

[`tokens.css`](tokens.css) is imported directly by `../src/renderer/styles.css`; it is the canonical
token source. Component geometry remains in the renderer because Longstitch has one adopter. The
six shipped variable font files and their OFL license texts live in `../src/renderer/fonts/`.

Revise a semantic token here, consume it from the renderer, then run `pnpm run longstitch:check` and
the live rendered verification. Do not copy values into another stylesheet.

## Boundaries

Longstitch is not a generic vintage skin and is not a fleet adoption target. Do not borrow the sewn
spine, brass knot, headband, or lamp pool as isolated decoration. Callouts use shared paper or
walnut materials; their category is carried by one measured strong ink, a distinct glyph, and the
written title rather than unsafe pale categorical tints.
