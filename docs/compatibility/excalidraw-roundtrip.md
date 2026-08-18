# Excalidraw round-trip boundary

Threadleaf measures Excalidraw interoperability from the unchanged open plugin and the public
Excalidraw Markdown and scene formats. It does not convert a drawing into a Threadleaf-owned
format, copy plugin source into the repository, or claim that an external application was tested
when no observation exists.

## Deterministic corpus

The synthetic corpus is at
[`fixtures/corpus/excalidraw-roundtrip-v1/`](../../fixtures/corpus/excalidraw-roundtrip-v1/). Its
manifest covers:

- native `.excalidraw` JSON plus frontmatter and both `json` and opaque `compressed-json` scene fences;
- text and rectangle elements, embedded scene-file data, and Unicode scene and folder names;
- nested attachments, wiki image embeds, Markdown image embeds, and a note link;
- an atomic external replacement during a revision-bound save; and
- an attachment rename with one exact Markdown image-reference rewrite.

The manifest records every canonical vault file's byte size and SHA-256 digest. The corpus is
copied to a temporary vault for each mutation, so the checked-in bytes remain untouched.

## Round-trip claims

The format helpers in
[`src/kernel/excalidraw-roundtrip.ts`](../../src/kernel/excalidraw-roundtrip.ts) make the boundary
explicit:

- an unchanged scene is `byte-exact`;
- an uncompressed JSON scene may be `semantic` after JSON whitespace or object-key reserialization,
  but every byte outside the scene payload must remain exact;
- a compressed scene is intentionally opaque and has an exact-byte contract unless the unchanged
  plugin codec is running the edit; and
- attachments are checked through a path, byte-size, MIME, and SHA-256 manifest.

An intentional text edit is compared to its expected canonical scene digest. The comparator does
not call an edited scene equal to its pre-edit scene merely because its surrounding Markdown is
unchanged.

## Conflicts and recovery

Corpus text and binary mutation cases go through the revision-bound vault kernel. If an external
atomic save wins the revision race, the external bytes remain at the original path and the proposed
plugin bytes become a labeled conflict copy. Interrupted writes and renames are recovered by the
same journal boundary already used by other vault mutations. No stale Excalidraw save silently wins.

Source-retaining, no-clobber attachment publication is a Linux capability. The Linux corpus proves
the complete rename, byte-retention, and reference-rewrite workflow. The macOS and Windows lanes
instead require the same request to fail closed as `attachment-publish-unavailable`, leave the
source and Markdown bytes unchanged, and create no destination. Their corpus result is reported as
`platform-unsupported`, never as an executable pass.

## Packaged Electron workflow

Run:

```sh
pnpm run test:excalidraw-roundtrip
```

The gate uses a unique temporary fixture vault, Electron user-data directory, explicit
`--ozone-platform=x11`, an isolated Xvfb display, and an isolated CDP port. It downloads only the
exact public Excalidraw 2.26.4 release at runtime, unless
`THREADLEAF_EXCALIDRAW_PLUGIN_PATH` points to an already supplied copy. Nothing from that download
is checked in.

A supplied copy must contain the exact public 2.26.4 release assets. The gate preserves the raw
manifest instead of normalizing JSON and rejects any mismatch:

- `manifest.json`: 463 bytes, SHA-256
  `f6b817daea2fa2106671a62d7236cdc8d806f52465f1ff3ab5343231c020b703`;
- `main.js`: 5,106,385 bytes, SHA-256
  `b26f3fc8cfa39cfefe8c11c82e43f80afdc642d8ca4d4ece3bdd817f72d4cf5a`; and
- `styles.css`: 224,752 bytes, SHA-256
  `615b560c5193b2ca4ef3ff1844d2807913bc51c40333c79fdd08a840b0c42735`.

Those assets must also produce package-tree SHA-256
`b5d2ce2c808a56cf668b020623c2a4a1702416214dfb898d7b2ad651ea0f8ea5` and package-identity
digest `1075ef87ee0d8003dca8b0ed6b0fb5f5cb091d8fb6c35619319333aa3c4926e7`, matching reviewed
authority profile `obsidian-excalidraw-plugin-2.26.4`. The main process independently stages and
seals that complete identity before construction. A modified installed-vault copy therefore fails
the exact byte or identity checks rather than being silently accepted.

The copied fixture configures the plugin to retain uncompressed deterministic scene text, follow
the host theme, and skip release notes already acknowledged at 2.26.4. The gate derives the first
authority grant from Threadleaf's own catalog, then proves the clean application restart
reconstructs the persisted grant and sealed package without granting again. It exercises:

1. the reachable Plugin control plus open and visible canvas rendering;
2. compressed Markdown and native `.excalidraw` scenes, with the native scene selected through the
   real Files tree and retained outside the Markdown index;
3. a deterministic scene edit and save;
4. new drawing creation and Markdown embed insertion;
5. the unchanged plugin's SVG and PNG vault-export controls plus byte checks;
6. note switching;
7. application settings open and close while the drawing is active, followed by the unchanged
   plugin's own options page;
8. native pop-out detach and reattach, including main and detached renderer responsiveness and
   toolbar/chrome ownership;
9. a forced pop-out renderer crash, degraded-state recovery, and stale pop-out cleanup;
10. a vault switch from a detached drawing and return to the original vault;
11. plugin unload and reload;
12. clean application restart with the native scene left active, automatically restored as the
    selected plugin document, and rendered without an explicit reopen; and
13. source-byte and attachment-manifest checks after restart.

The draw/edit step sends a real canvas gesture through CDP and then uses the deterministic source
save to set the expected text element. Settings, pop-out, vault-switch, and reattach controls use
real CDP pointer and keyboard events. The export step invokes the unchanged plugin's public
`export-image` command, selects its `PNG to Vault` and `SVG to Vault` controls, and validates the
resulting public-format bytes in the copied vault. Dark and light screenshots are captured from
the native renderer and both attached and detached plugin renderers. Main and detached surfaces
each have an independent visual positive control that must change captured pixels before the
screenshots are considered instrumented. The gate records requestAnimationFrame response times
and fails any surface that does not respond within one second.

Chromium's optional CDP `Page.crash` command is attempted for the compatibility renderer. When it
does not expose a failed plugin state safely, the gate records that limitation and continues after
an ordinary plugin reload; the native pop-out crash and degraded recovery remain mandatory.
Set `THREADLEAF_EXCALIDRAW_SCREENSHOT_DIR` to retain the PNG evidence.

The unchanged 2.26.4 plugin passes this complete packaged workflow on the Linux gate. This is
current supporting behavior evidence. The public compatibility level remains 2 until a dedicated
controller finalizes a signed, verifier-accepted, exact-build production receipt for this named
workflow; a successful harness run does not self-promote Level 4.

The host
dispatches workspace layout-ready callbacks as events instead of waiting on plugin-owned promises,
and it preserves Obsidian's view teardown order (`onunload` before `onClose`). Regression fixtures
prove that a never-settling layout callback cannot block readiness, view cleanup retains plugin
state through `onunload`, and plugin vault writes are acknowledged without re-entering a renderer
command that may be waiting for that acknowledgement. CDP requests are bounded, so a renderer seam
reports a failure instead of hanging the gate.

## Official Obsidian observation

The manual record at
[`observations/obsidian-roundtrip.v1.json`](../../fixtures/corpus/excalidraw-roundtrip-v1/observations/obsidian-roundtrip.v1.json)
is provenance-stamped with `status: "observed"`. The attended run used official Obsidian 1.13.7
from the x86_64 Flathub Flatpak at commit
`d91a9e9d80451e51f9d0fb3b8d89227af556e93493005033b3f8dcbe2e6acc91`, Electron 43.3.0,
Chromium 150.0.7871.212, and unchanged Excalidraw 2.25.3 release assets. Each official launch used
an isolated Xvfb display, X11, a disposable profile, a copied synthetic vault, loopback-only CDP,
and an isolated network namespace.

Official Obsidian opened, edited, saved, closed, and reopened the corpus under both
`compress: false` and `compress: true`. Threadleaf then consumed the official uncompressed output through the
packaged gate, edited and restarted it, and returned the resulting vault to official Obsidian.
Official Obsidian rendered the edited scene before and after its own restart. All 11 public vault
files had the same path, byte size, and SHA-256 digest before and after both return opens. The
sorted manifest digest was
`a41f0cd8fd984137dc20629af74287d95e80ed0d4b1600053d97537c3e46d2ba` on both sides.

This is external-oracle evidence, not an executable Threadleaf gate. The case remains declared
`support: "unsupported"`, and the Linux `pnpm corpus:check` reports seven executable gates, zero
platform-unsupported gates, one observed external case, and zero unverified cases. No official
Obsidian output, profile, screenshot, or private application asset is checked in; the record
retains only exact identities, digests,
isolation facts, observed behavior, and limitations.
