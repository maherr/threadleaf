# Installed Obsidian extension parity study

**Last updated:** 2026-08-20

## Decision

Threadleaf must treat an Obsidian-installed plugin bundle as a distinct exact distribution identity when its bytes differ from the publisher's release asset. It must not weaken exact-package authority or silently rewrite a user's installed plugin. Reviewed identities may cover both the publisher asset and the deterministic Obsidian-installed form, but compatibility still requires a named executable workflow for each exact version.

This study covers the initial community-plugin and theme acceptance corpus, the active vault's exact Minimal Theme Settings 8.1.1 distribution, and the official Calendar release selected as the next sidebar compatibility proof. It is bounded executable evidence, not evidence of universal plugin or theme parity.

## Rights and evidence boundary

- The evidence sources are public project repositories, public release assets, public licenses, exact hashes from a local installed tree, and independently executed Threadleaf workflows.
- No Obsidian proprietary implementation text or asset is copied into Threadleaf.
- A plugin's public source can explain its own API use. It cannot prove Threadleaf compatibility. Only the exact installed bytes running through a named Threadleaf workflow can do that.
- Reviewed authority profiles store hashes, declared capability sets, and policy metadata. They do not store third-party plugin source.

## Exact acceptance inventory

| Package | Version | Upstream | License | Installed `main.js` SHA-256 | Initial workflow target |
|---|---:|---|---|---|---|
| Data Files Editor | 1.3.0 | [zuktol/obsidian-data-files-editor](https://github.com/zuktol/obsidian-data-files-editor/tree/1.3.0) | MIT | `1f962a44845adad7ea3de6792bbf536f111ee131b0fcd16fa9cf4d18ff0d0676` | Open, edit, save, reopen JSON and YAML through registered file views |
| Calendar (Beta) | 2.0.0 manifest, `2.0.0-beta.2` release | [liamcain/obsidian-calendar-plugin](https://github.com/liamcain/obsidian-calendar-plugin/releases/tag/2.0.0-beta.2) | MIT | `64d1c6c620803246724bc922c5c2e0a17c406ffc23f6bbcfbfb14c643958fbb7` | Mount in the physical right dock, create a templated daily note, update its marker, and reconstruct after restart |
| Excalidraw | 2.25.3 | [zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin/tree/2.25.3) | AGPL-3.0 | `3baa63e288992c910fa5ac10e3811aaea4210211b29781446c07259b6df96391` | Create, draw, embed, export, detach, crash-recover, switch vault, reload, and restart |
| Excalidraw | 2.26.4 | [zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin/tree/2.26.4) | AGPL-3.0 | `b26f3fc8cfa39cfefe8c11c82e43f80afdc642d8ca4d4ece3bdd817f72d4cf5a` | Repeat the full workflow against the exact package in the user's active Threadleaf vault |
| Iconize | 2.14.7 | [florianwoelki/obsidian-iconize](https://github.com/florianwoelki/obsidian-iconize/tree/2.14.7) | MIT | `b68bcfd318d678892f671736e54396fd72414180736e58f164fb17a3f72a22e1` | Assign and remove file and folder icons, rename, reload, and restart |
| Minimal Theme Settings | 8.1.1 | [kepano/obsidian-minimal-settings](https://github.com/kepano/obsidian-minimal-settings/tree/8.1.1) | MIT | `a092f66342eb46dd93d96ffd75c9dc5e4f398d8547c41fa51b38f9edb59f4df6` | Repeat the paired theme, computed-style, persistence, and restart workflow against the active vault's exact package |
| Minimal Theme Settings | 8.2.3 | [kepano/obsidian-minimal-settings](https://github.com/kepano/obsidian-minimal-settings/tree/8.2.3) | MIT | `70573512ec859fad644e79ca9883d0b6d7dfb5369cde66e366884638317efdf3` | Change representative Minimal controls, verify computed styles, reload, and restart |
| Omnisearch | 1.30.1 | [scambier/obsidian-omnisearch](https://github.com/scambier/obsidian-omnisearch/tree/1.30.1) | GPL-3.0 | `4ea4d51f5ce283ea0f83ceb1f1db8e8f8c3ae156fab69a5f8f4c4e09d101a314` | Index a fixture vault, search from its command and ribbon surface, open a result, modify, and reindex |
| Minimal theme | 8.2.0 | [kepano/obsidian-minimal](https://github.com/kepano/obsidian-minimal/tree/8.2.0) | MIT | `theme.css` is `c75b6043bb8e7de95efaf835b509c3e995fe5fd49c43d7639a6b4a9efe934bdd` | Apply with Minimal Settings, verify representative components in light and dark, reload, and restart |

The local Minimal 8.2.0 `theme.css` and `manifest.json` hashes exactly match the two [official 8.2.0 release assets](https://github.com/kepano/obsidian-minimal/releases/tag/8.2.0).

## Pass 1, distribution identity and installation normalization

All five installed `manifest.json` files and all five installed `styles.css` files exactly match their official release assets. All five installed `main.js` files differ from the official asset.

Four official bundles have no trailing source map. Their installed form is the exact release bytes followed by `\n/* nosourcemap */`. Iconize's official bundle contains a trailing inline source map. Its installed form preserves the executable prefix exactly, removes the source-map line, and appends the same marker. The installed Iconize bundle is 414,155 bytes instead of the release asset's 1,003,749 bytes.

This is a distribution transformation, not a code change. Nevertheless, exact authority correctly treats the transformed bytes as a different identity. The original Excalidraw 2.25.3 authority profile matched only the public GitHub asset, so the user's real installed package was denied before runtime construction. The repair adds a second exact reviewed identity rather than canonicalizing two byte strings into one trust record.

The package-directory inspector also initially treated mutable `data.json` as an unknown distribution entry. Threadleaf's sealed package policy already excludes `data.json`, `.threadleaf-package.json`, and atomic data temporary files. The directory adapter now applies the same boundary while retaining every genuinely unknown distribution entry for rejection.

## Pass 2, plugin-owned API seams

The second pass inspected the public tagged source and existing Threadleaf runtime ledger independently of the bundle hash pass.

### Calendar 2.0.0-beta.2

The official release tag is `2.0.0-beta.2` while its manifest version is `2.0.0`; Threadleaf keeps
both values in the reviewed identity rather than treating one as an alias. Calendar registers a
right-sidebar view, traverses the vault for date markers, reads Daily Notes folder, format, and
template settings from the core-plugin facade, creates notes through ordinary vault and leaf APIs,
and copies template fold information.

Disposition: **Depend** on the unchanged MIT package. **Adapt** per-region workspace visibility,
the physical right-dock host, Daily Notes settings transport, and bounded fold compatibility.
**Benchmark** the ordinary confirmation, template creation, marker update, both themes, and a full
application restart. Result on 2026-08-20: the exact release rendered a 42-day month grid in a
299 by 715 pixel right dock beside the active note, created `Journal/2026-08-20.md` from the
configured template with tokens expanded, added one marker, and reconstructed the same dock and
marker after restart while Data Files Editor, Iconize, Minimal Theme Settings, and Omnisearch also
remained loaded and repeated their accepted workflows. The two-region gate also kept Calendar
visible and hit-testable while Data Files Editor owned the main document surface, covering the same
layout seam used by an open Excalidraw canvas.

### Data Files Editor 1.3.0

The plugin registers `TextFileView` subclasses for JSON, YAML, TXT, and XML, binds extensions to view types, emits a CodeMirror compatibility event, adds file-menu commands, creates files, and persists settings. Threadleaf already exports `TextFileView`, extension registration, file-menu events, settings persistence, vault creation, leaf opening, and the compatibility menu. The load-bearing open question is the legacy CodeMirror editor object expected by its views, so activation alone is insufficient.

Disposition: **Adapt** the existing file-view and editor bridge, then **Benchmark** exact JSON and YAML persistence. Do not build a separate data editor.

Result on 2026-08-20: the exact installed bundle passed reviewed activation, its registered JSON
view accepted real CodeMirror input, and the changed bytes autosaved exactly. A second application
launch reopened the plugin-owned JSON view with the edited content intact. YAML, TXT, XML, and
explicit plugin reload remain outside this workflow claim.

### Excalidraw 2.25.3

The package uses file views, workspace layout readiness, editor extensions, settings, vault reads and writes, external navigation, clipboard, network assets, and dynamic module selection. Threadleaf's existing 2.26.4 workflow already exercised the broad surface, but the installed 2.25.3 identity and its recovery path had not been proven.

Disposition: **Adapt** the reviewed identity list and retry state. **Benchmark** the full exact installed workflow. Result on 2026-08-19: passed create, draw-edit, compressed and native scene open, embed, PNG and SVG export, settings, command palette, popout, induced popout and renderer crash recovery, vault switching, visible reload, restart, and byte preservation in isolated mode.

### Excalidraw 2.26.4

The exact package in the active `obsidian-vault` matches the existing reviewed 2.26.4 identity. Its executable workflow exposed three runtime lifecycle faults that activation and the 2.25.3 package did not: a broad `md` registration could replace ordinary Markdown, switching documents could leave a stale plugin surface alive, and plugin-owned modals could be replaced by automatic document-view reactivation. A reloaded plugin host also needs a fresh layout-ready signal even when the vault does not change.

Disposition: **Adapt** native Markdown precedence and plugin-surface lifecycle ownership. **Benchmark** with ordinary workspace-tab switching and real pointer scrolling inside the taller export dialog. Result on 2026-08-19: the exact installed package passed the same full workflow as 2.25.3, including PNG and SVG export, settings and plugin-owned modal retention, crash recovery, reload, restart, and source-byte preservation.

### Iconize 2.14.7

The plugin uses workspace and vault events, file menus, modals, metadata cache, Markdown processors, CodeMirror extensions, CSS-change and layout-change events, icon registration and DOM rendering, and settings persistence. Threadleaf has public equivalents for the principal APIs. File-explorer decoration is the critical integration seam because a plugin can run successfully while its icons remain invisible in Threadleaf's native navigator.

Disposition: **Adapt** navigator decoration and context-menu projection. **Benchmark** assignment, removal, rename, reload, restart, and both themes. Reject an activation-only claim.

Result on 2026-08-20: the exact installed bundle's ordinary picker assigned and persisted a star,
and Threadleaf projected the plugin-authored decoration into the native virtualized Files row in
light and dark. A second application launch reconstructed both the plugin and the same native star
without a startup error. SVG packs, rules, remove, rename, and explicit plugin reload remain outside
this claim.

### Minimal Theme Settings 8.2.3

The plugin reads vault configuration, listens for configuration and CSS changes, adds a settings tab and commands, writes classes and CSS variables, and persists settings. Threadleaf already exposes settings components, `loadData` and `saveData`, `vault.getConfig`, CSS-change events, and theme/snippet controls. Its value depends on the paired Minimal theme, so plugin-only evidence would be misleading.

Disposition: **Depend** on the unchanged public plugin and theme assets. **Adapt** any missing configuration or CSS-event semantics. **Benchmark** paired computed styles and pixels in light and dark.

Result on 2026-08-20: the exact installed plugin loaded beside official-matching Minimal 8.2.0,
registered 51 owned commands, changed and persisted the body font through both APIs, and projected
the result into the native editor at a measured 16.5px in light and dark. A second application launch
read the persisted vault preference and restored the same 16.5px computed native editor size. Other
controls and explicit plugin reload remain outside this claim.

### Minimal Theme Settings 8.1.1

The active vault carries 8.1.1 rather than the separately proven 8.2.3 distribution. Threadleaf
therefore binds a second reviewed authority profile to the active package's exact manifest, main,
styles, and package-tree hashes instead of treating nearby versions as interchangeable.

Disposition: **Depend** on the unchanged MIT package and paired Minimal theme. **Benchmark** the
same native typography and persistence seam using version-selected matrix input. Result on
2026-08-20: the exact 8.1.1 package registered 52 owned commands, projected a 16.5px body font into
the native editor in light and dark, persisted it through a full application restart, and remained
loaded while Calendar, Data Files Editor, Iconize, Omnisearch, Advanced Tables, Templater, and
Excalidraw repeated their accepted workflows. The remaining 51 commands, non-default schemes, and
explicit plugin reload remain outside this claim.

### Omnisearch 1.30.1

The plugin uses vault create, delete, modify, and rename events, metadata-cache ignore rules, modals, ribbon and command surfaces, vault adapter cache files under `.obsidian/plugins/omnisearch`, and optional HTTP features. Threadleaf already provides the core modal, ribbon, command, event, metadata, and adapter surfaces. Search-index storage and the bundled Svelte modal lifecycle are the highest-risk seams.

Disposition: **Depend** on the plugin's own index and UI. **Adapt** missing metadata and modal semantics. **Benchmark** initial index, query ranking, result open, mutation reindex, reload, and restart. Do not substitute Threadleaf's native search and call it plugin parity.

Result on 2026-08-20: the exact installed bundle built its own index, returned the expected result
through its own modal, and opened that result in Threadleaf's native workspace. A second application
launch rebuilt the index, repeated the same query, and opened the same native note. Mutation reindex,
cache reuse, and explicit plugin reload remain outside this claim.

## Saturation and stop gate

Two independent passes changed the implementation order:

1. The byte and release pass found the installed-distribution identity mismatch and mutable-state inspection bug.
2. The tagged-source and local-ledger pass separated activation from visible workflow requirements, especially Iconize navigator decoration, Data Files Editor's legacy editor object, Minimal's paired theme behavior, and Omnisearch's own index and modal lifecycle.

Additional discovery would not change authority, rights, or implementation order before the executable workflows run. The next evidence must therefore come from the exact-package matrix. A package stays unverified until its named workflow passes in a disposable vault and the visible surface is inspected.
