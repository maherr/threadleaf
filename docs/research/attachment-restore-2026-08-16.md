# Exact-path attachment restoration

**Date:** 2026-08-16
**Status:** Implemented and packaged-proof complete for one missing passive embed and its bounded
external-file adapters

## Outcome

Threadleaf can restore selected external bytes at the exact unresolved path represented by one
authorized missing passive attachment card. The source note stays byte-identical. The action does
not relink the token, invent a filename, create a directory, decode the payload, or overwrite an
existing or equivalent vault name.

The card's Restore file chooser, card-scoped single-file drop, and focused Paste file control are
three input adapters over one shared external-byte ingress authority. They do not add renderer or
runtime filesystem writers. General editor ingestion uses a separate recoverable compound
publish-then-reference transaction because it must choose a new destination and insert a new
Markdown token; see [recoverable editor attachment insertion](attachment-insert-2026-08-16.md).

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

The renderer owns file selection and reads at most 16 MiB. The authorized card also accepts exactly
one regular dragged file, or exactly one file from a ClipboardEvent while the Paste file button is
focused. Text, HTML, URLs, directories, multiple files, unsafe names, unreadable files, and
oversized files are refused. Ordinary editor paste and workspace tab dragging are outside the
card-local handlers. Every accepted adapter passes only the selected basename and a copied
`ArrayBuffer`; no selected absolute path, file URL, or filesystem handle crosses IPC. The main
handler accepts only the owned main renderer, rechecks all string and byte bounds, copies the
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
autosave ordering, runtime inventory invalidation, and ready-card rehydration. Renderer adapter
tests additionally cover one-file selection with companion string flavors, empty and multiple
selections, directory-shaped transfers, exact bytes, unsafe and overlong names, declared and
post-read size overflow, and read failure.

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
- trusted CDP file drag onto the exact authorized missing card, including visible non-color drop
  state in both themes;
- URL/text and multi-file drop refusal that keeps the packaged renderer on the same document,
  opens no workbench, and mutates no source or target bytes;
- deterministic file-backed ClipboardEvent delivery to the focused **Paste file** button, plus a
  text-only negative control that remains uncancelled and opens no workbench;
- selected filename and byte count with no absolute source path in visible renderer state;
- dark and light two-step previews with an independently measured pixel-changing positive control;
- absent target and byte-identical source note before confirmation;
- exact restored bytes after confirmation and byte-identical source note;
- ready-card rehydration with stale Restore file, Paste file, and Relink controls removed;
- renderer exception and error-log rejection.

The clipboard fixture proves the browser event adapter. It does not claim physical OS clipboard
integration or filename synthesis for generic ClipboardItem blobs.
Editor insertion has its own packaged file-paste and physical file-drop proof; it does not inherit
physical OS clipboard integration from this deterministic card fixture.

Private product study may directly inform Threadleaf's architecture and interaction choices. This
proof comes from Threadleaf's own authority checks, journal, fixtures, fault injection, and packaged
behavior. It contains no extracted implementation text or assets.
