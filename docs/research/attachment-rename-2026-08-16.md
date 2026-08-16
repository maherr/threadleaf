# Attachment rename decision gate

**Last updated:** 2026-08-16 11:25:23 EDT

## Outcome

Threadleaf will add an explicit source-removing **Rename or move** operation for ordinary
attachments without changing the existing source-retaining **Publish copy** operation. The rename
will reuse the current exact-byte attachment planner and recoverable compound transaction, report
success only as `committed`, and preserve the workspace's automatic-link-update policy:

- `always`: apply every proven Markdown rewrite without a second confirmation;
- `ask`: show the exact revision-bound rewrite preview and require its confirmation capability; and
- `never`: rename the exact source bytes without rewriting references.

For `always` and `ask`, JSON Canvas is part of the reference-safety boundary. A valid Canvas file
that refers to the source attachment, or a malformed, unreadable, or oversized Canvas that cannot be
proved not to refer to it, blocks the rename without changing files. Canvas rewriting is deferred
until Threadleaf can preserve the original JSON bytes outside the exact changed value. A valid
Canvas with no matching reference is included in the operation's complete reference-corpus receipt,
so a concurrent Canvas creation, deletion, or edit invalidates the plan before source removal.

This is a bounded first slice. Drag-and-drop, paste, missing-file repair, and Canvas reference
rewriting remain separate work.

## Local authority and decision gate

The charter makes user files authoritative and requires explicit, recoverable, interruption-tested
mutations. The current implementation already provides most of the necessary mechanism:

- `src/application/attachment-move.ts` resolves wiki and Markdown links across the complete Markdown
  corpus, blocks ambiguous or unprovable targets, binds the preview to source and document
  revisions, and emits a confirmation digest;
- `src/kernel/vault-kernel.ts` stages exact bytes, refuses target overwrite, journals the source
  rename and related writes, preserves recovery evidence, revalidates external winners, and resumes
  every interruption phase; and
- the renderer already exposes a modal source-retaining Publish copy workbench with preview,
  confirmation, conflict, keyboard, and focus-return behavior.

The missing product seam is an explicit operation mode and an honest Canvas boundary. Replacing
Publish copy, using raw `fs.rename`, or silently ignoring Canvas references would violate existing
contracts.

The decision question was:

> How should Threadleaf expose source-removing attachment rename or move while preserving exact
> bytes, internal references, collision safety, interruption recovery, offline operation, and the
> existing Publish copy behavior?

## Primary evidence and disposition

| Seam | Primary evidence | Claim and rights boundary | Disposition |
| --- | --- | --- | --- |
| Obsidian user behavior | [Obsidian CLI file commands](https://github.com/obsidianmd/obsidian-help/blob/b8cf62bc2aac486dd0e2ec4cdaf7fa518b1a10a0/en/Extending%20Obsidian/Obsidian%20CLI.md) and [Internal links](https://github.com/obsidianmd/obsidian-help/blob/b8cf62bc2aac486dd0e2ec4cdaf7fa518b1a10a0/en/Linking%20notes%20and%20files/Internal%20links.md), public documentation | Rename and move are one user-visible file operation; internal links can be updated according to the vault setting. The docs describe behavior, not a transaction implementation. | **Benchmark.** Match the explicit operation and policy choices. Keep Threadleaf's stronger preview and recovery proof. |
| Obsidian public API | [`FileManager.renameFile`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/obsidian.d.ts#L2770-L2789), MIT | The public contract says a file can be moved safely and links updated according to preferences. It does not expose collision, interruption, or receipt semantics. | **Adapt.** Preserve the observable behavior without copying proprietary implementation details. |
| JSON Canvas references | [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) and [`canvas.d.ts`](https://github.com/obsidianmd/obsidian-api/blob/cc1744324150c632416857c98964f87b1574a5fc/canvas.d.ts), MIT | File nodes carry a file path and group nodes may carry a background-image path. Both can refer to the renamed attachment. Unknown fields must remain forward-compatible. | **Depend** on the open format. **Reject** whole-document reserialization for this slice; block matching or unprovable Canvas references and bind all nonmatching Canvas revisions. |
| Multi-resource editor mutation | [VS Code `WorkspaceEdit`](https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit) and [workspace file-operation events](https://code.visualstudio.com/api/references/vscode-api#workspace), source revision `b6d86f7dea54686892c2efb61118492e199d4e8c`, MIT | Resource and text edits share one ordered operation surface, but resource edits do not promise the all-or-nothing text-only guarantee. | **Benchmark.** Keep rename plus link writes in Threadleaf's own recoverable parent transaction rather than depending on editor-level batching. |
| Filesystem rename | [Node.js `fs.rename`](https://nodejs.org/api/fs.html#fsrenameoldpath-newpath-callback) and [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/renameat2.2.html), platform documentation | Node's normal rename overwrites an existing target. Linux offers `RENAME_NOREPLACE`, but support varies by filesystem, and NFS can report failure after a server-side rename completed. | **Reject** raw rename as the product contract. **Adapt** the existing staged, no-overwrite, receipt-driven kernel and verify final source and target state. |
| Dialog and keyboard behavior | [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) and [WCAG HTML dialog technique](https://www.w3.org/WAI/WCAG21/Techniques/html/H102) | Focus enters the modal, remains inside, Escape closes it, and focus returns to the invoking control. | **Depend.** Reuse the existing native dialog and test both pointer and keyboard paths. |

No new dependency, imported implementation, package, or proprietary observation is needed.

## Saturation passes

Pass 1 covered Obsidian's first-party help, public MIT API, and the open JSON Canvas contract. It
changed the initial Markdown-only proposal: source removal must account for Canvas file-node and
group-background references, so the baseline was revised to block and corpus-bind Canvas rather
than silently breaking it.

Pass 2 expanded into platform failure semantics. Node's overwrite behavior, Linux no-replace
support variance, and NFS result ambiguity reinforced the existing journal and receipt engine; no
candidate changed authority, disposition, risk, proof, or implementation order.

Pass 3 independently expanded into editor transaction semantics and W3C interaction standards.
VS Code's resource-edit caveat supports a Threadleaf-owned compound transaction, while the modal
guidance matches the existing workbench. No candidate changed the revised baseline. The gate is
closed for this slice.

## Chosen contract

1. Publish copy remains source-retaining, Linux capability-gated, and reported only as
   `published-source-retained`.
2. Rename or move is a distinct operation, removes the source only after the exact target and every
   authorized related write have been verified, and reports success only as `committed`.
3. Both operations are bound to the active vault, exact source revision, normalized source and
   target identities, and no-overwrite target checks.
4. Rename honors `always`, `ask`, and `never`. Publish copy retains its current explicit preview
   behavior because changing references to a retained copy is the operation the user requested.
5. For `ask` and `always`, the complete reference corpus contains every visible Markdown and Canvas
   path plus revision. The kernel revalidates that scoped corpus before journaling and at every
   existing pre-source-removal barrier.
6. Markdown references are rewritten only when the existing resolver proves their old and new
   identities. Ambiguous, unresolved, unsupported, or changed references block or conflict.
7. Valid Canvas file-node and group-background references to the source block with an exact Canvas
   location. Malformed, unreadable, or oversized Canvas files also block because absence of a
   reference cannot be proved.
8. The renderer labels both actions literally, explains whether the original remains, previews the
   exact link effect, returns focus on cancel, and reports source removal only from a complete
   committed receipt.

## Deliberately deferred

- Byte-local JSON Canvas path rewriting and Canvas-side confirmation previews.
- Drag-and-drop and paste ingestion, attachment-location preferences, collision naming, and editor
  insertion semantics.
- Missing-file recovery and relinking.
- Richer Canvas attachment controls.
- Folder mutation and bulk attachment reorganization.
- Cross-filesystem or remote-filesystem guarantees beyond the kernel's verified final-state and
  recovery contract.

## Required proof

- Red-green application tests for copy versus rename result types, `always`/`ask`/`never`, exact
  bytes, target collisions, stale source, stale confirmation, full-corpus additions/deletions/edits,
  Markdown wiki and Markdown link rewrites, Canvas file and group-background blockers, malformed
  Canvas refusal, and valid unrelated Canvas acceptance.
- Kernel tests proving the scoped reference corpus survives journal parse/recovery, rejects changed
  Canvas state, never overwrites a destination, and converges after every rename and
  move-with-writes fault point.
- Runtime/controller tests proving inventory invalidation, rewritten-note refresh, stale-vault
  handling after either successful result, and no source removal from the Publish copy path.
- Packaged Electron checks in light and dark themes covering both attachment actions, pointer and
  keyboard activation, preview confirmation, Canvas-blocked refusal, success copy, success rename,
  Escape, focus return, and a source/target/link byte manifest.
- Full repository check, public-content scan, exact-scope staged check, and a clean commit. The broad
  roadmap attachment-lifecycle item remains unchecked until drag/drop, paste, missing-file recovery,
  and richer Canvas interaction are also complete.
