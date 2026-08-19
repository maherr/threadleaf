# Longstitch

**Category:** design language  
**Owner:** Threadleaf  
**Status:** live  
**Maturity:** bespoke  
**Signature:** A quiet file tree, neutral writing surface, and violet focus rail keep the active note obvious without competing with it.
**Themes:** Paper / Graphite
**Runtime authority:** `tokens.css`  
**Reference implementation:** `../src/renderer/styles.css`  
**Adoption:** bespoke, not an adoption target; 1 owning app  
**Last verified:** 2026-08-19, 18-state live Electron matrix plus both-theme package preview

## Identity and referent

Longstitch is Threadleaf's bespoke design language: a quiet, familiar desktop knowledge workspace
that keeps file truth close without turning the interface into a developer tool. Neutral layers
show depth, compact rows preserve information density, and violet marks focus and interaction.
Machine text stays visibly separate from prose, but ordinary interface copy remains comfortably
readable instead of shrinking into metadata.

The arrival question is: **which note am I working on, and how do I begin without surrendering file
truth?** The open note answers with title and path; an empty pane answers with a direct, shortcut-
labeled creation action instead of a dead end. A fresh install arrives on a read-only welcome leaf
with **Open folder** beside the clearly labeled demo identity.

## Signature

The signature is restraint with an inspectable file boundary: a compact tree, one clear active-row
rail, a calm document canvas, and controls that appear where the work happens. The interface should
feel immediately legible to an experienced Markdown-workspace user while remaining recognizably
Threadleaf through its typography, violet interaction channel, and explicit file-state language.

## Themes

- **Paper:** a neutral near-white canvas with quiet grey chrome and a restrained violet accent.
- **Graphite:** a layered charcoal workspace with soft text and a clearer violet focus state.

They share one information architecture, density, typography, and state grammar. Their difference
is working condition, not decoration. Neither theme adds ornamental structure or changes control
placement.

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

Longstitch is not a generic Obsidian skin and is not a fleet adoption target. Its value is the
complete density, type, spacing, focus, and file-truth system rather than any isolated color token.
Callouts use shared neutral materials; their category is carried by one measured strong ink, a
distinct glyph, and the written title rather than unsafe pale categorical tints.
