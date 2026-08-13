# Live Preview mapping fixture v1

This fixture is public, synthetic Markdown for the source/decorated mapping
contract. Offsets are UTF-16 code-unit offsets, matching CodeMirror
positions. `source` is authoritative; `rendered` is a disposable projection
used only to exercise mapping behavior.

The cases cover delimiter boundaries, aliases, nested emphasis, inline code,
tasks, callouts, tags, frontmatter and tables as source-only blocks, malformed
links, and exact source fallback. A case may also list `roundTrips`, which
require `renderedToSource(sourceToRendered(...))` to return a source position
rather than a generated DOM position.

No case contains user-vault data or application-owned configuration.
