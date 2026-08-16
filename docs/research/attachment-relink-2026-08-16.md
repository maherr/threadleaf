# Single-reference attachment relinking

**Date:** 2026-08-16
**Status:** Implemented and packaged-proof complete for one missing passive embed

## Outcome

Threadleaf can now recover one missing passive attachment reference by pointing it at an existing
visible attachment in the same vault. The action changes one proven Markdown target token. It does
not restore bytes, create the missing path, or copy, move, delete, decode, or overwrite either
attachment.

This slice is deliberately narrower than general missing-file recovery. Raster images, byte import,
drag-and-drop, paste, multiple matching references, and automatic candidate selection remain out of
scope.

## Authorization boundary

The Reading-view card exposes **Relink** only when all of these facts are current:

- The target is a missing local passive attachment, not a note, raster image, external URL, private
  path, or unsupported source form.
- One visible public Markdown source contains exactly one supported embed token that resolves to
  the missing path. Code spans, fenced code, comments, and reference definitions do not authorize
  the action.
- The card carries the exact source-note path and revision that produced the recovery offer,
  including when the rendered card belongs to a nested embedded note rather than the root note.

The replacement must be supplied as a full vault-relative path. It must identify exactly one
visible, non-hidden, non-Markdown passive attachment after case and Unicode normalization. The
kernel must contain it inside the vault and complete a stable read within the 16 MiB attachment
bound. A symlink outside the vault never becomes a candidate.

## Two-step mutation

The first submission is read-only. It returns one before/after target preview and a SHA-256
confirmation identity over:

- source and replacement paths;
- source and replacement revisions;
- the exact token rewrite and resulting source content;
- the current derived-index generation.

The second submission rebuilds the plan. Any changed input produces a refreshed confirmation or a
typed refusal. A matching confirmation enters the recovery-backed kernel mutation lane. The kernel
checks the exact missing path, resolver-level missing identity, candidate namespace uniqueness,
canonical identity, bounded revision, and containment before staging, then checks them again at the
last no-source-mutation seam immediately before the source move-aside or install. Query and fragment
suffixes, aliases, BOM, line endings, whitespace, and unrelated bytes remain exact because the
implementation replaces only the parser-proven target range.

If that final physical check fails, the kernel retires the staged note and recovery evidence,
archives a rolled-back receipt, and leaves the source unchanged. The boundary serializes Threadleaf
mutations and narrows the external race window; it cannot lock out an unrelated same-user process
that writes after the last check.

If the source changes in the final write race, the kernel keeps the external version at the live
path and preserves Threadleaf's proposed version as a named conflict copy. The UI reports that
conflict path for review. If the active runtime changes after a commit, the controller returns the
new vault snapshot plus the basename-safe identity of the vault that actually committed.

## Refusal cases

No relink commits when the source is stale or unreadable; the original target resolves again,
becomes ambiguous, returns physically, or gains an unsafe parent; the replacement is missing,
ambiguous, changed, hidden, private, outside the vault, Markdown, unsupported, unreadable, or
oversized; zero or multiple source tokens match; the index generation changes; the confirmation
changes; the vault changes; or the kernel cannot complete the source write without a recoverable
conflict.

## Proof

The focused application suite covers recovery-offer gating, exact BOM and CRLF preservation,
query/fragment preservation, candidate drift, stale sources, duplicate references, returned targets,
case-normalized ambiguity, hidden and outside-vault candidates, nested-note source provenance,
conflict-copy recovery, runtime index convergence, controller vault-switch races, owned-renderer
IPC, autosave ordering, and inert unauthorized cards. Fault-injected final-boundary tests restore the
exact missing target, add a case-equivalent missing target, change candidate bytes, add a
case-equivalent candidate duplicate, and swap a contained candidate symlink outside the vault. Each
case proves the source stays exact, private staging and recovery evidence are retired, the live
journal is empty, and one rolled-back receipt remains.

The packaged Linux Electron gate adds the real user path:

- explicit X11 Xvfb renderer with a dedicated profile and disposable vault;
- real CDP pointer clicks and keyboard input with hit-target and input read-back checks;
- exact two-step preview and confirmation in dark and light themes;
- unchanged candidate bytes and absent missing path before and after commit;
- exact one-token Markdown change and ready-card rehydration;
- renderer exception and error-log rejection;
- screenshot positive control on the same capture path.

Private product study may directly inform Threadleaf's architecture and interaction choices. The
compatibility evidence above comes from Threadleaf's own parsers, kernel contracts, fixtures, and
packaged behavior. This public record contains no extracted implementation text, assets, or private
reference material.
