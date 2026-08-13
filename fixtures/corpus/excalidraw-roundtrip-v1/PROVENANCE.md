# Provenance

This corpus is original synthetic data written for Threadleaf. It contains no copied vault
content, proprietary application output, bundled plugin source, or third-party binary asset.

The corpus includes a native `.excalidraw` JSON scene. Its Markdown shape follows the public
Excalidraw Markdown conventions: YAML frontmatter, the public `excalidraw-plugin: parsed` marker,
an Excalidraw scene fence, ordinary Markdown image embeds, and public scene JSON fields. The
compressed scene payload is an opaque deterministic fixture. Threadleaf does not claim to decode or
semantically compare compressed-json without the unchanged plugin codec.

`observations/obsidian-roundtrip.v1.json` is a provenance-stamped manual-observation record. Its
status is `unverified` because no Obsidian run was performed for this repository change. An absent
observation is never counted as a pass.
