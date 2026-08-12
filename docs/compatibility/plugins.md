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
Excalidraw canvas. Opening an existing Excalidraw Markdown document is measured level 4 for that
named read-only workflow. Drawing creation, edit persistence, save, embed, reopen-after-write, and
export remain unsupported and are not implied by that result.

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
- Broader workspace, editor, menu, settings-control, file, and metadata APIs.
- Complete Excalidraw create, edit, save, embed, reopen-after-write, export, unload, and
  byte-preservation workflows.
