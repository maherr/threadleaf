# Recoverable editor attachment insertion

**Date:** 2026-08-16
**Status:** Implemented and packaged-proof complete for one external file per drop or paste

## Outcome

Threadleaf can insert one external attachment directly from a writable Markdown editor. Dropping a
file inserts at the measured pointer position. Pasting a file replaces the current editor
selection. The user reviews the vault-relative destination and exact generated reference before
either the attachment or note is changed.

This is a compound mutation, not a convenience wrapper around two unrelated writes. Threadleaf
publishes the exact attachment bytes first, then writes the proposed note revision. The journal can
recover or conservatively surface every interruption boundary without claiming success from path
existence alone.

## Editor contract

The renderer owns only file-shaped transfers. Text, HTML, and URL paste or drop stays with
CodeMirror and the browser. Directory-shaped and multi-file transfers are canceled and refused, so
they cannot navigate the packaged window or create a partial batch.

One accepted `File` is copied into a bounded renderer-owned `ArrayBuffer`. The renderer never sends
an absolute source path, file URL, or filesystem handle across IPC. Inputs are capped at 16 MiB and
must use a safe basename plus a supported raster or passive attachment suffix. SVG, HTML, Markdown,
and Canvas are excluded from this ingress path.

The default destination is the source note's folder plus the selected basename. The path remains
editable before review, but its parent folder must already exist and remain visible. The operation
does not create folders, add a numeric suffix, or overwrite an exact, case-equivalent, or
Unicode-equivalent claimant.

The generated reference follows the active vault setting:

- `preserve` and `wikilink` produce an Obsidian-style wiki embed;
- `markdown` produces a source-note-relative Markdown image/embed target with encoded segments.

Paste captures the CodeMirror selection range. Drop resolves a CodeMirror position from the actual
pointer coordinates. Both ranges use the editor's LF representation. The application maps them
back to the exact external representation so a UTF-8 BOM, CRLF, CR-only line endings, and all
unrelated bytes remain unchanged.

## Two-step authorization

Before opening review, the renderer focuses the owning pane, verifies that the vault, note,
CodeMirror document, and captured selection still belong together, and flushes every pending pane
autosave. The review cannot open on a dirty or stale source.

The first application submission is read-only. It validates the source and target paths, supported
suffix, bounded bytes, current source revision, selection bounds, existing target parent, visible
namespace, and active index generation. The preview shows:

- source note and selected basename;
- byte count and SHA-256 attachment identity;
- exact vault-relative destination;
- exact generated reference and resulting selection position;
- SHA-256 identity of the proposed note revision.

The confirmation identity binds the complete preview, original source revision, generated syntax,
attachment bytes, selection, and workspace generation. Editing the target, changing the source,
switching the vault, moving the selection, changing link style, or replacing the bytes produces a
new review or a typed refusal rather than reusing stale consent.

The main process accepts this request only from the owned renderer. It validates bounded strings,
safe integer offsets, and a copied `ArrayBuffer`, then dispatches through the active workspace
controller. A runtime replacement after completion returns the affected vault identity instead of
presenting the new runtime as the mutation owner.

## Compound transaction and recovery

The kernel serializes the mutation behind one `attachment-insert` journal with `intent`, `staged`,
`attachment-published`, `note-written`, `conflict-preserved`, and `committed` phases. Private blobs
hold both the exact attachment bytes and complete proposed note bytes until a durable terminal
receipt permits cleanup.

Immediately before publication, the kernel rechecks source readability and writability, exact
source revision, target absence, public contained path, existing parent, normalized namespace
uniqueness, supported target suffix, and strict no-overwrite publication capability. Linux then
publishes the attachment through the descriptor-contained unnamed-inode and absent-name `linkat`
boundary. The kernel verifies the published revision and normalized namespace before recording the
publication phase.

Only then may the proposed note write begin. If the source still matches, the revision-bound writer
installs the complete proposed note. If an external writer wins the source race after attachment
publication, Threadleaf preserves the complete proposed note as a named conflict copy. That copy
already points to the published attachment, so neither part is orphaned and the external winner is
not overwritten.

Recovery is deliberately conservative:

- an intent with no complete staged evidence rolls back;
- staged evidence may resume only after all pre-publication checks pass again;
- an interruption between native publication and its durable phase receipt becomes manual review
  with both private blobs retained;
- a changed or ambiguous target namespace after publication becomes manual review;
- an unsafe or unreadable source namespace after publication becomes manual review;
- a verified published attachment plus unchanged source resumes the note write;
- a verified conflict copy resumes to a conflict receipt;
- a verified note write advances to committed;
- committed, rolled-back, and verified conflict receipts remove private blobs only after archival.

Journal parsing rejects hidden or private paths, Markdown and Canvas targets, unsupported suffixes,
invalid revisions, unsafe byte lengths, and malformed conflict paths. A tampered recovery record
therefore cannot turn startup into a broader file writer.

## User-visible results

A committed insertion closes the review, reconciles the current snapshot, places the cursor after
the inserted reference, and reports the exact destination. A source race focuses the named conflict
copy and reports why it exists. An uncertain post-publication state keeps the review open with a
manual-inspection message and retains private evidence.

Supported attachment targets are excluded from the note-link inspector and unresolved note-link
counts. Their existence and rendering belong to the attachment inventory and attachment service,
not the Markdown-note resolver.

## Proof

Focused application tests cover BOM and CRLF mapping, CR-only Markdown syntax, exact selection
replacement, confirmation binding, unsupported or private targets, case collisions, stale source
revisions, changed generations, runtime inventory convergence, source-race conflict copies, and
controller replacement after completion.

Kernel interruption tests inject failure after intent, staging, native publication, durable
publication receipt, note write, conflict preservation, and commit. Additional races cover source
changes, exact target claims, normalized aliases, source symlinks, post-publication namespace
divergence, source-write unavailability, blob retention, and tampered journal targets. Every result
is checked against live attachment bytes, note or conflict bytes, journal history, and private blob
cleanup.

The packaged Linux Electron gate adds the actual UI seams:

- explicit X11 Xvfb renderer with a dedicated profile and disposable vault;
- file-backed paste into a real focused CodeMirror selection;
- CDP file drop at the measured start of a real CodeMirror line;
- visible dashed drop state in dark and light themes;
- synthetic multi-file transfer proving every drag and drop event is owned, canceled, and refused;
- exact source, basename, byte count, target, hash, and generated reference in the two-step dialog;
- no target or note mutation before the second submission;
- exact attachment bytes, exact note bytes, cursor reconciliation, and success receipt after commit;
- zero outgoing or unresolved note links for the committed attachment embed;
- dark and light screenshots plus renderer exception and error-log rejection.

The deterministic clipboard fixture proves the browser event adapter, not physical OS clipboard
integration. The one-file scope is intentional. Multi-file destination policy and ordering remain a
separate product decision rather than an implicit loop over single-file transactions.

Private product study may inform Threadleaf's architecture and interaction choices. The evidence in
this record comes from Threadleaf's own authority checks, journal, fixtures, fault injection, and
packaged behavior. It contains no extracted implementation text or assets.
