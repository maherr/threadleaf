# Excalidraw round-trip corpus

This is a deterministic, license-clean corpus for the boundary between native `.excalidraw` JSON,
Excalidraw Markdown, public scene JSON, compressed scene payloads, and referenced attachments. All
bytes are synthetic.

The manifest records every canonical byte. The supported cases prove exact bytes for untouched,
native, and compressed scenes, canonical semantic equivalence for an intentionally reserialized
uncompressed scene, attachment digests and reference rewrites, and revision-bound external-edit
conflicts.
The official Obsidian record is an attended external observation for one pinned application,
plugin, settings pair, and corpus manifest. It remains excluded from executable pass counts.

Run the headless gate with:

```sh
pnpm run corpus:check
```

Run the targeted unit tests with:

```sh
pnpm exec vitest run src/kernel/excalidraw-roundtrip.test.ts
```

The packaged workflow is separate because it needs Electron, an isolated X11 display, and a
temporary profile:

```sh
pnpm run test:excalidraw-roundtrip
```

That workflow downloads the exact open Excalidraw release only at runtime when the host permits
it. No plugin source, release asset, license file, or Obsidian output is checked in.
