# Architecture

## Current decisions

### Desktop compatibility host

Threadleaf starts as an Electron and TypeScript desktop application. Existing plugins commonly
assume Chromium, the DOM, Node.js, and Electron behavior. Matching that environment reduces the
compatibility problem before optimization begins.

The renderer remains isolated with `contextIsolation`, no Node integration, and Chromium sandboxing.
The trusted compatibility runtime executes outside the renderer and exposes a narrow IPC surface.

### Filesystem authority

Markdown and attachments remain authoritative. Search indexes, metadata graphs, and caches must be
rebuildable from those files. Phase 0 has no user-vault write API.

Threadleaf will use its own configuration root. Its final name and exact location must be decided
before the first user-vault write implementation lands.

### Compatibility module

Existing plugin bundles request `require("obsidian")`. Threadleaf supplies an independently
implemented module at that boundary. The host loads `manifest.json`, `main.js`, and optional
`styles.css`, constructs the exported plugin class, and owns its lifecycle.

The first spike uses a trusted CommonJS execution host. It is not a security sandbox. Native
Threadleaf extensions will use a separate capability-based runtime.

## Initial component model

```text
Markdown vault
    |
    v
Vault kernel ---> rebuildable metadata index
    |
    v
Application services ---> isolated renderer
    |
    v
Compatibility module ---> trusted community plugin
```

## Phase 0 boundaries

- Synthetic fixture vault only.
- Read-only vault access.
- One plugin instance.
- Minimal `App`, `Vault`, `Plugin`, `Command`, and `Notice` behavior.
- Explicit lifecycle and event reporting in the renderer.
- No sync, rich editor, metadata database, package marketplace, or arbitrary vault picker.

## Decisions still to make

- Final application configuration path.
- Long-term process isolation for trusted plugins.
- Native extension SDK license and capability vocabulary.
- Editor architecture and source-to-preview mapping.
- Cache schema and filesystem watcher model.
- Packaging, signing, and update channels.
