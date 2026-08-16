# Ordinary file inspector

**Last updated:** 2026-08-16 04:02:51 EDT

## Outcome

Threadleaf will treat activation of an ordinary Files row as a transient, read-only inspection,
not as opening a Markdown or Canvas document. The current note or Canvas remains active, no tab or
history entry is created, and the ordinary row does not gain document selection semantics.

The inspector may receive only one bounded result from the main-process vault service:

- a magic-byte-verified PNG, JPEG, GIF, or WebP data URL;
- valid UTF-8 text without NUL bytes, displayed inertly and capped at 64 KiB;
- metadata for PDF, audio, video, document, archive, or unknown binary bytes; or
- an explicit unavailable, stale-vault, or stale-inventory result.

The source read is capped at 10 MiB. The renderer receives no absolute path, filesystem handle,
`file://` URL, shell action, network action, decoder, editor, or mutation authority.

## Local authority and seam

The Files navigator already exposes a complete, generation-bound physical inventory. Its ordinary
rows are focusable but deliberately do not call `openNote`, create a tab, change panes, or become
current. Existing Markdown attachment loaders are note-relative, while Canvas attachment loaders
are Canvas-relative. Inventing a fake source document for either would corrupt path semantics.

The new service therefore accepts an exact normalized Files path, active vault identity, and the
inventory generation that produced the row. The runtime refreshes the physical inventory, requires
that generation and exact visible membership, then delegates a stable bounded read to the kernel.
The controller drops late responses and closes if vault or inventory identity changes.

## Primary evidence and disposition

| Seam | Primary evidence | Boundary | Disposition |
|---|---|---|---|
| Renderer privilege | [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security) | Keep context isolation and sandboxing, validate privileged IPC senders, and do not grant untrusted content broad native APIs. | **Adapt.** One narrow bridge method returns a typed bounded value. The handler accepts only the owned main renderer. Reject shell and external-navigation capability. |
| Preload exposure | [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) | Expose one method per operation instead of raw `ipcRenderer`. | **Depend.** Add one explicit `loadVaultFilePreview` method and no generic invoke surface. |
| Content classification | [WHATWG MIME Sniffing Standard](https://mimesniff.spec.whatwg.org/) | Filename and declared type can be misleading; byte patterns and text-or-binary classification are security-relevant. | **Adapt.** Reuse Threadleaf's bounded magic-byte classifier. Extensions route Markdown and Canvas away from this service but never decide preview content. |
| Modal behavior | [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | Focus enters the dialog, Tab stays within it, Escape closes it, and focus returns to the invoking control. | **Depend.** Use a native modal dialog, visible close control, Escape handling, and exact row focus restoration. |
| Vault formats | [Obsidian accepted file formats](https://obsidian.md/help/file-formats) and [Obsidian attachments](https://obsidian.md/help/attachments) | Attachments are ordinary files, but browser support and codecs vary by platform. | **Adapt.** Show metadata for formats that require a decoder. Do not infer that Obsidian support authorizes browser embedding. |
| Editor preview tabs | [VS Code editor UI](https://code.visualstudio.com/docs/editing/userinterface) | A single click can reuse a preview tab. | **Reject for this slice.** Threadleaf would need pane, tab, pin, history, persistence, recovery, and active-document semantics before an ordinary file could truthfully occupy a tab. |
| Binary custom editors | [VS Code custom editor API](https://code.visualstudio.com/api/extension-guides/custom-editors) | Binary formats use explicit read-only or editable provider contracts. | **Extract.** Metadata-only is the honest default when Threadleaf has no format provider. |
| Native/browser separation | [VS Code source organization](https://github.com/microsoft/vscode/wiki/source-code-organization) | Browser-safe workbench code is separated from Electron and Node authority. | **Adapt.** Keep path resolution and bytes in kernel/application code; the renderer owns presentation only. |
| Local file URLs | [Electron issue 23393](https://github.com/electron/electron/issues/23393) | Direct local file access can tempt applications to weaken `webSecurity`. | **Reject.** Keep `webSecurity` intact and return only data URLs for allowlisted sniffed raster bytes. |

Two bounded independent passes found no candidate that changed the authority, risk, proof, or
implementation order. The first pass covered standards and product contracts. The second covered
independent editor architecture and a concrete Electron local-file failure pressure. The decision
gate is closed for this slice.

## Chosen contract

1. The request is bound to exact vault and physical-inventory identity.
2. The service accepts only a currently visible ordinary file. Markdown, Canvas, hidden, private,
   missing, outside-vault, directory, special-file, and stale-row requests expose no bytes.
3. A stable kernel read returns at most 10 MiB and checks vault identity before and after.
4. Classification trusts bytes, not suffixes. Only sniffed raster formats return base64.
5. Text must be valid UTF-8 without NUL bytes. The 64 KiB display prefix backs up to a valid code
   point boundary, so truncation does not manufacture a replacement character.
6. PDF, audio, video, Office or rich text, archives, and unknown binary remain metadata-only.
7. The renderer writes file-controlled strings only through text-only DOM properties, including a
   read-only `textarea.value`. It creates no `iframe`, `object`, `audio`, `video`, executable HTML,
   arbitrary URL, or native-open affordance.
8. The inspector is transient. It does not mutate the workspace snapshot, active document, tabs,
   pane history, selection, source vault, or private layout state.

## Deliberately rejected or deferred

- Persistent ordinary-file tabs or `activeFile` workspace state.
- OS Open, Reveal, shell, subprocess, external navigation, or network fetch.
- PDF, SVG, HTML, Office, archive, audio, or video rendering.
- Editing, autosave, undo, conflict copies, recovery, rename, move, trash, drag-and-drop, paste, or
  publication.
- A generic file-provider abstraction or new dependency.

These require separate behavior, authority, and interruption contracts. A metadata result is not a
promise that one of those capabilities exists.

## Required proof

- Unit tests cover direct containment, exact visible membership, hidden and private refusal,
  Markdown and Canvas routing refusal, extension spoofing, raster allowlisting, inert hostile text,
  valid UTF-8 boundary truncation, metadata-only binary types, bounded failure, and vault staleness.
- Controller tests prove `textContent`, the absence of active or executable elements, raster MIME
  allowlisting, late-response refusal, inventory invalidation, Escape, and focus return.
- The isolated X11 Files gate drives both pointer and Enter activation with an armed `openNote`
  counter, proves pane and tab state stay unchanged, inspects text, raster, metadata, and stale
  states, verifies source-vault bytes, and captures light, dark, narrow, and high-DPI screenshots.
- The complete repository gate remains green before commit.
