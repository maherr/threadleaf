# Exact-path attachment restoration

**Date:** 2026-08-16
**Status:** Implemented and packaged-proof complete for one missing passive embed

## Outcome

Threadleaf can restore selected external bytes at the exact unresolved path represented by one
authorized missing passive attachment card. The source note stays byte-identical. The action does
not relink the token, invent a filename, create a directory, decode the payload, or overwrite an
existing or equivalent vault name.

This is the first user-facing adapter over a shared external-byte ingress authority. Drag-and-drop
and clipboard paste remain open work and must reuse the same authority rather than add renderer or
runtime filesystem writers.

## Authorization boundary

The Reading-view card exposes **Restore file** only when the attachment service can prove all of the
following:

- the rendered target is a missing local passive attachment rather than a note, raster image,
  external URL, private path, or unsupported source form;
- one visible public Markdown source contains exactly one supported embed token resolving to the
  missing path;
- the card carries the exact source-note path and revision that authorized the offer, including for
  a card nested inside an embedded note;
- the target path is public, non-Markdown, non-Canvas, and has an already-existing contained parent.

The renderer owns file selection and reads at most 16 MiB. It passes only the selected filename and
a copied `ArrayBuffer`; no selected absolute path, file URL, or filesystem handle crosses IPC. The
main handler accepts only the owned main renderer, rechecks all string and byte bounds, copies the
payload again, and dispatches through the active workspace controller.

## Two-step restore

The first submission is read-only. The application rebuilds source-token evidence, verifies the
displayed source revision, resolves the raw target to the same exact missing path, checks exact and
case/NFC-equivalent absence, and binds the current index generation. Its preview contains:

- source note path and exact target path;
- selected filename and byte count;
- SHA-256 content revision for the selected bytes.

The confirmation identity binds every preview field, the source revision, raw resolver target, and
index generation. The second submission rebuilds the plan from the copied bytes. Changed evidence
returns a refreshed confirmation or a typed refusal. A matching plan enters the kernel mutation
lane and never writes the source note.

## Shared ingress journal

The kernel records a dedicated `attachment-ingress` transaction with `intent`, `staged`,
`published`, and `committed` phases. Its authorization persists the operation, source path and
revision, exact missing path, and raw resolver target. Staged bytes are private, revision-checked,
and capped by the shared attachment limit.

Immediately before publication, the kernel checks the source revision, resolver-level absence,
exact target absence, public and contained path, existing parent, case/NFC namespace uniqueness,
and strict attachment publication capability. Linux publishes from private staged evidence through
descriptor-contained `O_TMPFILE` plus absent-name `linkat`, so a claimant is never replaced and a
partial final file is never exposed. The kernel then verifies the exact published revision and
rescans the normalized namespace before writing the durable committed receipt.

Recovery is intentionally conservative:

- `intent` with no staged blob rolls back;
- staged evidence with no target may resume only after the authorization checks pass again;
- staged recovery that observes an exact target cannot know whether publication completed, so it
  records manual conflict and retains evidence;
- an exception from the strict installer also records manual conflict because the native link may
  have completed before target observation, even when a concurrent parent rename makes the original
  lexical target appear absent;
- an unexpected exact, case-equivalent, or Unicode-equivalent target after publication also records
  manual conflict and preserves both the visible bytes and private evidence;
- committed and rolled-back blobs are removed only after their durable history receipts.

This refuses to turn existence after a crash into an unearned success claim.

## Proof

Focused tests cover application validation, exact-byte preview and commit, source-note preservation,
source and target drift, case/NFC aliases, invalid filenames, stale vaults and generations,
controller replacement races, owned-renderer IPC, renderer file-size checks before byte reads,
autosave ordering, runtime inventory invalidation, and ready-card rehydration.

Kernel interruption tests inject failure after intent, stage, publication, and commit boundaries.
They cover exact NUL, high-bit, and BOM bytes, no source rewrite, pre-publication source and target
races, restart source revalidation, staged-target uncertainty, and post-publication normalized-name
ambiguity. A red control also publishes the bytes, moves the parent namespace before receipt
observation, and proves that the result retains its private blob as a manual conflict rather than
deleting it as a rollback. Every terminal result is checked against live bytes, journal history,
retained evidence, and cleanup state.

The packaged Linux Electron gate adds the real user path:

- explicit X11 Xvfb renderer with a dedicated profile and disposable vault;
- real pointer activation of **Restore file** and an intercepted native file chooser;
- selected filename and byte count with no absolute source path in visible renderer state;
- dark and light two-step previews with an independently measured pixel-changing positive control;
- absent target and byte-identical source note before confirmation;
- exact restored bytes after confirmation and byte-identical source note;
- ready-card rehydration with stale Restore file and Relink controls removed;
- renderer exception and error-log rejection.

Private product study may directly inform Threadleaf's architecture and interaction choices. This
proof comes from Threadleaf's own authority checks, journal, fixtures, fault injection, and packaged
behavior. It contains no extracted implementation text or assets.
