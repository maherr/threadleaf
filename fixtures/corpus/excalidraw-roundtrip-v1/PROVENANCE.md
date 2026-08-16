# Provenance

This corpus is original synthetic data written for Threadleaf. It contains no copied vault
content, proprietary application output, bundled plugin source, or third-party binary asset.

The corpus includes a native `.excalidraw` JSON scene. Its Markdown shape follows the public
Excalidraw Markdown conventions: YAML frontmatter, the public `excalidraw-plugin: parsed` marker,
an Excalidraw scene fence, ordinary Markdown image embeds, and public scene JSON fields. The
compressed scene payload is an opaque deterministic fixture. Threadleaf does not claim to decode or
semantically compare compressed-json without the unchanged plugin codec.

`observations/obsidian-roundtrip.v1.json` is a provenance-stamped manual-observation record. Its
status is `observed` for the pinned official Obsidian 1.13.7 Flatpak and unchanged Excalidraw
2.25.3 release. It records only versions, isolation facts, behavior, and exact digests. No
proprietary application output, profile, screenshot, or asset is retained in the repository. The
observation remains external evidence and is never counted as an executable corpus pass.
