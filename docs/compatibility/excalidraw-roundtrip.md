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

## Packaged Electron workflow

Run:

```sh
pnpm run test:excalidraw-roundtrip
```

The gate uses a unique temporary fixture vault, Electron user-data directory, explicit
`--ozone-platform=x11`, an isolated Xvfb display, and an isolated CDP port. It downloads only the
exact public Excalidraw 2.25.3 release at runtime, unless
`THREADLEAF_EXCALIDRAW_PLUGIN_PATH` points to an already supplied copy. Nothing from that download
is checked in.

A supplied copy must be the exact public 2.25.3 release bytes, not an Obsidian-installed copy of
the plugin. The gate pins and rejects any mismatch: `manifest.json` must hash to SHA-256
`43f18bc17c5c3f76af1a9a4191daa1c3566e2875aa4430561d57b7828785282e`, and `main.js` must be exactly
4,898,048 bytes with SHA-256 `684cf6da43f6e3b2a7646d5a50d14f7a43eb5d859d073dc6a375c4a1b0990dd6`.
A copy taken from an installed Obsidian vault carries an installer-appended 18-byte
`/* nosourcemap */` suffix on `main.js` (4,898,066 bytes), so it fails the pinned byte count and
SHA-256 and is rejected rather than silently accepted.

The copied fixture configures the plugin to retain uncompressed deterministic scene
text, follow the host theme, and skip release notes already acknowledged at 2.25.3. The gate derives
the authority grant from Threadleaf's own catalog, then exercises:

1. the reachable Plugin control plus open and visible canvas rendering;
2. a deterministic scene edit and save;
3. new drawing creation and Markdown embed insertion;
4. the unchanged plugin's SVG and PNG vault-export controls plus byte checks;
5. note switching;
6. plugin unload and reload;
7. clean application restart; and
8. source-byte and attachment-manifest checks after restart.

The draw/edit step sends a real canvas gesture through CDP and then uses the deterministic source
save to set the expected text element. The export step invokes the unchanged plugin's public
`export-image` command, selects its `PNG to Vault` and `SVG to Vault` controls, and validates the
resulting public-format bytes in the copied vault. Dark and light screenshots are captured from
both the native renderer and the plugin renderer. A magenta outline positive control must change
captured pixels before the screenshots are considered instrumented.
Set `THREADLEAF_EXCALIDRAW_SCREENSHOT_DIR` to retain the PNG evidence.

The unchanged 2.25.3 plugin now passes this complete packaged workflow on the Linux gate. The host
dispatches workspace layout-ready callbacks as events instead of waiting on plugin-owned promises,
and it preserves Obsidian's view teardown order (`onunload` before `onClose`). Regression fixtures
prove that a never-settling layout callback cannot block readiness, view cleanup retains plugin
state through `onunload`, and plugin vault writes are acknowledged without re-entering a renderer
command that may be waiting for that acknowledgement. CDP requests are bounded, so a renderer seam
reports a failure instead of hanging the gate.

## Official Obsidian observation

The manual record at
[`observations/obsidian-roundtrip.v1.json`](../../fixtures/corpus/excalidraw-roundtrip-v1/observations/obsidian-roundtrip.v1.json)
is provenance-stamped with `status: "unverified"`. No official Obsidian output, screenshot, or
private application asset is checked in. The headless corpus reports that absence as unverified,
not as a pass. A future manual run must use a copied synthetic vault and record only independently
observed behavior, exact source manifests, and its method.
