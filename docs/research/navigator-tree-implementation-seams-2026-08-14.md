# Navigator tree implementation seams

**Discovery date:** 2026-08-14
**Scope:** a bounded public-HTTPS and local-source pass for the left navigator tree. No upstream repository was cloned, fetched, built, installed, or executed. No upstream code will be copied.

> This is the original metadata-indexed tree record. The current Files authority and the closed
> empty-folder/non-Markdown gap are documented in
> [filesystem-truthful navigator and folder management](filesystem-truthful-navigator-and-folder-management-2026-08-16.md).

## Decision in one screen

**Adapt a flattened, virtual visible-row tree backed by generation-tagged, immediate-child pages from Threadleaf's existing metadata-index projection.** Keep the renderer as a bounded consumer. It will hold expanded paths plus fetched child pages, not a full vault tree or a filesystem mirror.

Folders appear only when an indexed Markdown path implies them. Empty folders are deliberately not represented in this first surface because the current authority is the Markdown index and this lane must not add an unrestricted filesystem walk or IPC read. Dot-prefixed paths remain excluded by the existing discovery and path-policy boundary.

The existing flat virtual list remains available. Search remains its existing flat ranked-results surface. The navigator starts in tree mode with only root entries shown, except that revealing the active note may expand its ancestors.

## Decision gate and local constraints

| Question | Decision | Reason and local proof obligation |
| --- | --- | --- |
| Data authority | Depend on `WorkspaceIndexProjection`, never renderer path discovery | `WorkspaceRuntime` already derives the flat file page from the authoritative in-memory metadata index after the census becomes current. Tree pages must use the same generation and stale-vault guards. |
| Renderer size | Adapt a sparse, virtual visible-row projection | `workspace-file-pages.ts` already proves a 200,000-slot sparse page model and `virtual-list.ts` bounds mounted rows. The tree must not create one DOM node or serialized row per indexed file. |
| Tree interaction | Adapt WAI-ARIA tree semantics | Use `tree` and `treeitem`, expose expanded state only on folders, and implement the requested arrow, Home, End, and Enter behavior against the visible projection. |
| Persisted state | Extend private per-vault workspace layout from v1 to v2 | Persist only normalized expanded folder paths under the existing vault-ID-keyed `workspace-layouts/` store. Parse v1 as a safe v2 default and save only through the existing atomic store/controller path. |
| Creation | Reuse the existing guarded kernel directory create | A narrow main-renderer IPC calls the existing `createPluginFolder` route, which already enforces writable-vault, private-path, symlink, and containment policy. Rename, move, and delete are not added. |
| Dependency/code reuse | Reject | No tree component, virtual-list package, or upstream source is needed. This is a behavioral adaptation only. |

## Coverage ledger

| Seam | Source and pin | Authority | What it supports | Boundary |
| --- | --- | --- | --- | --- |
| Tree semantics and keyboard behavior | [WAI-ARIA 1.2](https://www.w3.org/TR/wai-aria-1.2/) and [WAI-ARIA APG tree view](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/) | Normative role/state model plus W3C authoring guidance | `tree`/`treeitem` ownership, `aria-expanded` only on parents, and Right/Left/Up/Down/Home/End/Enter behavior | The APG does not decide Threadleaf's persistence or paging architecture. |
| Dynamic and virtualized tree metadata | [MDN tree role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tree_role), checked 2026-08-14 | Advisory cross-check of the W3C model | Dynamic nodes need `aria-level`, `aria-setsize`, and `aria-posinset`; focus order must match visual order | MDN is not a substitute for W3C requirements and no prose is copied. |
| High-cardinality tree composition | [VS Code Lists and Trees wiki](https://github.com/microsoft/vscode/wiki/Lists-And-Trees), plus [Code-OSS `abstractTree.ts`](https://raw.githubusercontent.com/microsoft/vscode/8bed8782864c64dbd3e42219b79672b0acff1009/src/vs/base/browser/ui/tree/abstractTree.ts) and [MIT license](https://raw.githubusercontent.com/microsoft/vscode/8bed8782864c64dbd3e42219b79672b0acff1009/LICENSE.txt) | First-party engineering and pinned MIT implementation reference | A tree can compose a virtual list with a flattened visible projection; virtual DOM is the correct scale boundary | Code-OSS is not a dependency or source transplant. Threadleaf owns its own model, IPC, and interaction code. |
| Default expansion and action controls | [React Spectrum TreeView](https://react-spectrum.adobe.com/TreeView), checked 2026-08-14 | Independent product/library cross-check | Collapsed-by-default expansion and arrow-key row navigation are conventional | No React Spectrum dependency, component API, or styling is adopted. |
| Existing Threadleaf scale boundary | `docs/research/upstream-startup-performance-seams-2026-08-14.md`, `src/renderer/workspace-file-pages.ts`, and `src/renderer/virtual-list.ts` | Local architecture authority | Generation-tagged bounded pages and virtual DOM are existing project direction | The navigator implementation must not reintroduce a complete renderer snapshot. |

## Two independent passes

### Pass 1: standards and first-party implementation

The W3C tree pattern supplies the requested keyboard contract. Code-OSS independently demonstrates a tree built as a virtualized flattened list. Both agree with Threadleaf's existing virtual-list architecture. This pass changes the implementation decision from a nested DOM tree to a visible-row projection with explicit ARIA position metadata.

### Pass 2: independent product and documentation check

MDN and React Spectrum independently confirm dynamic-tree metadata, collapsed initial expansion, accessible labeling, and arrow-key row navigation. They introduce no conflicting behavior and no new dependency. The result is unchanged: retain native buttons with `role="treeitem"`, one roving focused row, and an accessible folder-action button rather than a library tree or a visual-only disclosure.

## Chosen local shape

1. Build an index projection of immediate children. Each response is bounded to the existing page maximum, carries the opaque index generation, and returns folder metadata or note summaries only for one parent path.
2. Add a path-location query for the active note. It returns page offsets for its ancestor chain so reveal does not scan an arbitrarily large root folder from the renderer.
3. In the renderer, represent each fetched parent page sparsely. Build a compact sequence of loaded rows and unloaded ranges; resolve only the visible virtual window into DOM. A 200,000-entry root must therefore produce bounded mounted rows and bounded IPC payloads.
4. Persist normalized expanded folder paths in workspace-layout v2. A v1 document reads as a v2 document with no expanded paths; the next normal layout write atomically records v2.
5. Keep search and the flat mode on the existing file-page route. Tree mode is the default only for an empty query.
6. Route `New note here` through the existing note dialog with a folder prefix. Route `New folder` through the existing kernel directory-creation authority. Do not expose rename, move, delete, filesystem traversal, or raw path access.

## Required executable proof

- Unit-test immediate-child construction, folders-before-notes ordering, Unicode/deep path behavior, dot-segment exclusion, persisted expansion validation/migration, and stale generation rejection.
- Unit-test a 200,000-entry root plus an expanded folder with more than 1,000 direct children. Assert virtual visible-range access is bounded and no full DOM-row projection is created.
- Test the application/controller/main bridge seams for generation, stale-vault, folder containment, and layout persistence.
- Run the full repository gate, native build before native-dependent suites, and existing integration/E2E coverage.
- Capture real Electron Xvfb screenshots in both themes for nested expansion, active-note reveal/highlight, long-name truncation, and a folder with more than 1,000 children. Record paths and measured counts in the completion report.

## Rejected alternatives and bounded gaps

- **Rejected:** asking the renderer to page through the entire flat index and derive a tree locally. It recreates the all-files renderer cost that the current startup work explicitly avoids.
- **Rejected:** a recursive filesystem IPC. It would create a second authority/discovery surface, leak excluded/private paths, and bypass watcher/index generation semantics.
- **Rejected:** materializing a nested DOM tree. It fails the 200K scale requirement before paint.
- **Rejected:** a third-party virtual tree package. Existing project primitives cover the bounded behavior with less dependency and compatibility surface.
- **Closed by the later physical-inventory lane:** empty folders and non-Markdown-only folders now
  appear under the independent contained inventory contract linked above.
