# Community plugin compatibility

Threadleaf reads the standard installed-package layout so an existing community plugin can be
tested without conversion:

```text
.obsidian/
  plugins/<id>/manifest.json
  plugins/<id>/main.js
  plugins/<id>/styles.css
```

These files are compatibility input only. Threadleaf does not rewrite, install into, enable, or
disable packages under `.obsidian/`. Its enabled set and restricted-mode choice live in private
application data keyed by the vault identity.

## Discovery is not execution

Opening Settings discovers installed packages but does not execute them. A ready package has a
valid contained manifest and CommonJS bundle. A package can still fail when enabled if it requests
an API that Threadleaf has not implemented. Threadleaf reports that activation failure beside the
package and keeps loading other selected plugins.

Compatibility means a named, executable workflow passes against a public fixture. A package being
listed, enabled, or activated is not by itself a workflow claim. The unchanged open Excalidraw
2.25.3 release bundle now passes discovery and `onload` activation in Threadleaf's disposable DOM
probe. It registers its two view types, ribbon action, settings tab, and Markdown processor without
an uncaught activation error. The same unchanged bundle now activates at startup in Threadleaf's
production Electron compatibility renderer. Its registered drawing view attaches to a visible
workspace leaf with the filename header, plugin action icons, release-notes modal, and real loaded
Excalidraw canvas. Its plugin-owned header replaces the normal Markdown editor header for that leaf.
Opening an existing drawing, mutating its scene, saving through the revision-bound compatibility
vault, fully detaching the view on close, and reopening the exact persisted scene is measured level
4 for that named workflow. The unchanged new-drawing command also reaches level 4: it creates the
standard Excalidraw folder and Markdown file through Threadleaf's recovery-backed kernel, opens the
new custom leaf through the built-in Markdown handoff, saves deterministic scene elements, closes
the leaf, and reloads those elements from the exact persisted file. Native-editor embed insertion
and SVG/PNG vault export also reach level 4. The full unload fixture starts from an active drawing,
removes the leaf, plugin-owned release modal, all 69 commands, and every registered integration,
then completes two clean reload cycles with the exact original counts and no captured runtime
error. Plugin-owned settings are now reachable through an Options control shown only for the
loaded plugin that registered the tab. The unchanged Excalidraw tab renders 200 setting rows, 215
inputs, 22 dropdowns, and 32 buttons in the production compatibility renderer. It works with or
without an open note, follows Threadleaf's light and dark scheme, persists a changed option through
the plugin's normal `saveData` path on close, restores it on reopen, and removes the settings DOM on
close or unload. Inline wiki-embed rendering, other export formats, and universal plugin parity are
not implied by those results.

Vault resources now expose contained browser URLs through `Vault.getResourcePath`. The compatible
desktop `FileSystemAdapter` provides `basePath`, `url.pathToFileURL`, `getBasePath`, `getFilePath`,
`getResourcePath`, `exists`, `stat`, `list`, `read`, and `readBinary`. It can read hidden files as
the public adapter contract permits, accepts internal symlinks, and rejects a symlink resolving
outside the active vault. Adapter mutation methods remain unsupported; plugin writes continue to
cross the revision-bound `Vault` and `FileManager` methods described above. The CommonJS module
also provides byte-exact `arrayBufferToBase64`, `arrayBufferToHex`, and `base64ToArrayBuffer`
helpers used by image and attachment workflows. The undocumented `Vault.getConfig` lookup is
present as a conservative undefined fallback, which preserves default behavior without claiming
ownership of Obsidian's private configuration. In the production Electron renderer, Chromium
loaded the corpus's real 58,472-byte Excalidraw PNG through this resource URL and reported its exact
803 by 549 dimensions while the adapter independently returned all 58,472 bytes.

## Trust model

Existing community bundles run in the trusted desktop compatibility runtime. This is not a
security sandbox. Enabled JavaScript can use the authority available to that host, including the
Node.js behavior many existing desktop plugins expect. Enable only code you trust.

Threadleaf's future native extension runtime is a separate capability-based design. Tightening that
runtime will not be represented as retroactive sandboxing of arbitrary existing bundles.

## Lifecycle

Threadleaf reconciles selected plugins after the vault runtime opens:

1. Discover and validate installed packages.
2. Load nothing when restricted mode or process safe mode is active.
3. Unload runtime instances that are no longer selected.
4. Activate each selected ready package independently.
5. Retain command, event, compatibility-level, and failure diagnostics per plugin.

Disable unloads the selected runtime instance. Reload performs clean unload and activation. Closing
or replacing the workspace unloads every instance. Catalog and lifecycle operations are serialized
and bound to the active vault identity so a late result cannot cross a vault switch.
Plugin-owned modals that retain a direct reference to their plugin are tracked independently, so
targeted unload closes that plugin's transient UI without closing another plugin's modal.
Plugin-owned settings tabs are tracked by plugin ID. Closing Options invokes the tab's `hide`
lifecycle before removing its child surface, and disabling, reloading, or replacing the workspace
uses the same cleanup boundary.

Plugin stylesheets are applied only while the corresponding package is selected and compatibility
mode is enabled. Imports and legacy executable CSS remain rejected. External and relative asset
URLs are replaced with inert embedded assets and reported, while data, fragment, and CSS-variable
URLs remain intact. The primary renderer content-security policy independently blocks
stylesheet-initiated network access.

## Loader boundaries

- Plugin IDs are validated against the manifest and immediate containing folder.
- Realpath containment rejects bundle, manifest, and stylesheet symlink escapes.
- Each manifest is limited to 64 KiB, each CommonJS bundle to 16 MiB, and each stylesheet to 2 MiB.
- Active plugin CSS is limited to 4 MiB in total and catalogs to 256 entries.
- Files must decode as UTF-8.
- Stylesheets reject imports and legacy executable CSS constructs, and neutralize other asset URLs
  before applying the remaining rules.
- Invalid packages with a valid folder identity remain visible; invalid folder identities and
  missing selected packages are reported with explicit evidence.

## Recovery

Restricted mode is a persisted per-vault preference. It unloads community code and CSS while
leaving installed files and the selected set untouched.

For a startup problem, launch with either process boundary:

```sh
THREADLEAF_SAFE_PLUGINS=1 pnpm start
pnpm start -- --safe-plugins
```

Safe mode loads no community JavaScript or CSS and disables lifecycle controls for that process.
Settings still shows installed packages and the saved selected set for diagnosis. Exiting and
starting normally restores the persisted preference.

## Remaining work

- Activation timeouts, process isolation, crash attribution, and per-plugin resource budgets.
- Minimum-app-version, desktop-only, dependency, and permission reporting before enablement.
- An explicit import preview for existing enabled-plugin inventory, settings, hotkeys, and layout.
- Reviewable install, update, rollback, and uninstall through an open package index.
- A generated compatibility registry backed by public workflow fixtures.
- Broader workspace, editor, menu, settings-control, adapter-mutation, file, and metadata APIs.
- Complete Excalidraw inline wiki-embed, remaining export-format, and cross-application
  byte-preservation workflows.
