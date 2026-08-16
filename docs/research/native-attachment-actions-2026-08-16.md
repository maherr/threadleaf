# Vault-bound native attachment actions

**Last updated:** 2026-08-16 13:26:30 EDT

## Outcome

Threadleaf provides native **Open** and **Reveal** actions for passive Reading-view attachment
cards without exposing a path, file URL, shell object, or generic IPC method to the renderer.
Every request carries the active vault identity, normalized vault-relative path, and exact SHA-256
revision from the hydrated card. The main process accepts the request only from its owned renderer,
re-resolves the canonical contained file, rejects hidden and private paths, performs a stable read
within the existing 16 MiB attachment limit, and rechecks the active vault immediately before it
dispatches to the operating system.

Reveal is available for every attachment that passes that boundary. Open is narrower: both the
bounded bytes and the suffix of the requested and canonical paths must identify an allowlisted,
non-launcher document or media class. Unknown bytes, extension/content mismatches, HTML, scripts,
desktop launchers, and other unapproved classes remain revealable but cannot cross native Open.

## Decision gate

The previous passive-card implementation intentionally displayed inert Open and Reveal controls.
The decision question was:

> What is the smallest native boundary that makes those controls useful without granting a
> compromised renderer general filesystem or shell authority or claiming OS state Threadleaf
> cannot observe?

## Primary evidence and disposition

| Seam | Primary evidence | Claim boundary | Disposition |
| --- | --- | --- | --- |
| Native Open | [Electron `shell.openPath`](https://www.electronjs.org/docs/latest/api/shell/#shellopenpathpath) | Resolves a path through the desktop's default handler and returns an empty string on success or an error string on failure. | **Depend** through a main-only port. Treat a nonempty string or rejection as a generic native failure; never relay its path-bearing details. |
| Native Reveal | [Electron `shell.showItemInFolder`](https://www.electronjs.org/docs/latest/api/shell/#shellshowiteminfolderfullpath) | Requests that the file manager show and select the item, but returns no completion receipt. | **Depend** through the same port. Report `reveal-dispatched`, never “revealed” or “selected.” |
| Privileged IPC | [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages) | A privileged IPC receiver must validate its sender. | **Depend.** Reject every sender except the owned main renderer before parsing or dispatch. |
| Preload boundary | [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [IPC tutorial](https://www.electronjs.org/docs/latest/tutorial/ipc) | A preload should expose one narrow operation rather than raw `ipcRenderer` or a generic send wrapper. | **Depend.** Expose one typed attachment-action request and typed response. |
| Revision and containment | Threadleaf vault kernel and path policy | A recent stable read can bind the card revision and reject path redirection, but cannot atomically lock a path against every unrelated external writer through another application's open. | **Adapt.** Revalidate immediately before dispatch and document the residual path replacement race instead of making an atomicity claim. |

No proprietary application code, decompiled resource, bundled asset, or private behavior trace is
an input to this decision. The decision uses only the cited public documentation and Threadleaf's
independently authored local contracts and tests.

## Chosen contract

1. The renderer sends `{ action, path, expectedRevision, expectedVaultId }` through one typed bridge
   method. It never receives an absolute path or native error string.
2. The main handler validates the IPC sender and the complete request shape before invoking the
   application service.
3. The service captures the active vault root and identity, accepts only a canonical portable
   relative path and lowercase SHA-256 revision, and rejects every dot-prefixed path segment.
4. `VaultPathPolicy` resolves the file canonically inside the captured vault. A contained leaf
   symlink is reduced to its canonical target; a hidden canonical target or outside-vault symlink
   is rejected.
5. A regular-file check prevents folders and special files from entering a potentially blocking
   native path. A stable bounded read rejects missing, oversized, unreadable, changing, or stale-
   revision targets.
6. Reveal dispatches the canonical absolute path to `showItemInFolder` and returns only
   `reveal-dispatched` plus the original relative path.
7. Open re-sniffs the bytes and verifies both requested and canonical suffixes against the approved
   matrix before `openPath`. Unknown or mismatched content returns `unsupported` and retains Reveal.
8. The service checks the current vault again immediately before the native call. A response that
   completes after a renderer-side vault switch is ignored by that renderer.

### Native Open matrix

The current matrix covers byte-sniffed PNG, JPEG, GIF, WebP, PDF, RTF, OOXML with non-macro
filename suffixes, ZIP archives, MP3, FLAC, Ogg, WAV, M4A/M4B, AVI, WebM, MP4/M4V/MOV, and
plain text with `.txt`, `.text`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.toml`, or `.log`.
Reveal remains the fallback for every other safe contained file. Expanding the matrix requires a
new byte classifier, suffix mapping, tests, and packaged proof; a filename alone is never enough.

## Truth boundary

`openPath` provides a result string, so Threadleaf may report **Opened** only after Electron returns
success. `showItemInFolder` is fire-and-forget, so Threadleaf reports only that it **asked the file
manager to reveal** the file. Neither API proves what an external application rendered.

The stable revision check closes stale-card and ordinary redirection errors, but an unrelated
same-user process can replace a path after the final read and before the OS consumes it. Native
Open and Reveal therefore make no transaction-level atomicity claim. They never mutate vault bytes.
The suffix gate blocks direct launcher and script classes; it does not claim to sandbox the user's
configured external viewer or eliminate vulnerabilities in that application.

## Required proof

- Unit tests for canonical containment, contained symlinks, outside symlinks, hidden/private paths,
  traversal, missing files, folders, bounded reads, invalid and stale revisions, vault switches,
  unknown-byte Reveal, extension/content mismatch, and redacted native failures.
- A source contract test proving the IPC sender guard precedes dispatch, preload authority stays
  typed and narrow, production maps to Electron shell, and the diagnostic receiver exposes only a
  path hash.
- A packaged Electron/X11 gate using real pointer input. Its main-process diagnostic receiver must
  observe Open and Reveal with the exact canonical-path SHA-256; a renderer toast alone is not proof.
- Packaged assertions that unknown bytes expose Reveal but no Open, all fixture bytes remain exact,
  and the cards plus truthful Reveal receipt render in both light and dark themes.
- Full repository, public-content, and staged-scope gates before commit.
