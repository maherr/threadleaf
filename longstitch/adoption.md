# Longstitch adoption boundary

**Last updated:** 2026-08-19

**Status:** bespoke to Threadleaf; not a fleet adoption target.

## Portable core

- Separate reading, interface, and machine type roles.
- Let semantic material tokens carry depth while interaction state keeps one consistent accent.
- Give categorical state a label, glyph, or shape before color, then measure every live color pair.
- Scale the whole reading hierarchy proportionally under accessibility controls.
- Give light and dark themes distinct working-condition signatures without changing capability.

These are principles, not permission to copy Longstitch's visual identity.

## Identity-bound signature

The compact file tree, neutral document canvas, restrained violet focus system, typography, and
explicit file-state language belong together. They derive from Threadleaf's job of keeping a local
vault legible while exposing file truth.

## Inspiration versus adoption

Borrowing a principle is inspiration. Adoption would require the referent, signature composition,
semantic roles, theme pair, task and callout grammar, typography, and accessibility evidence to move
together. That would erase another product's identity, so Longstitch is deliberately unavailable as
a fleet skin.

## Review checklist

1. Confirm the change still serves Threadleaf's local-file knowledge-work job.
2. Change semantic tokens in `tokens.css`, never by copying values into component CSS.
3. Exercise Live Preview, Reading view, tree and tag navigation, tasks, callouts, tables, and support
   chrome in both themes.
4. Verify desktop and narrow layouts, keyboard focus, 1.8 text scaling, computed contrast, and
   Machado deuteranomaly severity 0.6 and 0.8.
5. Keep the prior token values and component diff recoverable through Git.

## Forbidden borrowing

Do not extract one color or row treatment and call it the design system. Do not turn the package
into a shared token dependency, and do not use the violet accent as pass or failure semantics.

## Rollback

Revert the Longstitch checkpoint as one unit: runtime token import, component styling, fonts,
task-state semantics, package docs, and checks. Never leave copied token values behind in the
renderer after removing the canonical import.
