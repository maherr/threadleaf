# Measured plugin compatibility APIs

This document is the public contract for measured API families in the trusted desktop
compatibility runtime. It is normative for the signatures and observable behavior below.
The measured usage inventory in [`compatibility/open-plugin-usage.v1.json`](../../compatibility/open-plugin-usage.v1.json)
is evidence of why these members are implemented; it is not a claim that every plugin API exists.

## Scope and classification

The family contains Markdown post processors, fenced-code block processors, and the render-child
context used to manage their lifecycle. It is available to existing CommonJS plugins in the
trusted desktop compatibility renderer. It is classified as desktop compatibility only. It is not
a portable native-extension API and is not available to mobile clients.

The host keeps the existing capability and grant boundary. A bundle that registers a processor is
reported under the existing `workspace-ui` capability. Registration does not grant vault writes,
network access, filesystem access, subprocesses, or any other authority.

## Named workflows

This family unlocks three bounded desktop workflows represented by the measured corpus:

- Render a plugin's fenced task, query, or drawing block into a replacement element (Tasks,
  Dataview, and Excalidraw).
- Post-process rendered Markdown in deterministic order, including context-sensitive inline
  decoration (Tasks and Excalidraw).
- Keep processor-created DOM children alive and release them with the render component (Tasks and
  Excalidraw).

These are compatibility workflows, not claims that the corresponding plugins are fully supported.

## Settled Reading projection

Native Reading and CodeMirror 6 do not consume an ordinary community plugin's Markdown
postprocessor directly: the compatibility runtime and the isolated plugin renderer communicate
only through the versioned `PluginRendererOperation` IPC surface, which carries typed metadata and
counts, never an arbitrary callback or DOM reference. `RuntimeSnapshot.integrations` reports how
many post processors a plugin registered; it never lets native Reading call them.

The `render-markdown` operation is a bounded, plugin-exact bridge for this family, not a general
delivery architecture. It runs exactly the requested, already-loaded plugin's registered
processors to completion through the existing `MarkdownRenderer.render` path (the same host used by
this document's Phase 0 evidence and the `markdown-processors-fixture` corpus), inside the trusted
isolated compatibility renderer, then discards the ephemeral render component. The resulting
settled DOM crosses back UNSANITIZED on `RuntimeSnapshot.markdownProjection`, bound to the exact
plugin ID, source path, and a SHA-256 of the rendered content: a plugin's registered processor runs
after `MarkdownRenderer.render`'s own script/attribute stripping, so nothing re-sanitizes what the
processor added before capture. Every consumer, including the one primary-renderer consumer this
slice ships (`sanitizePluginMarkdownProjection` in `src/renderer/markdown-preview.ts`), must
sanitize it through the same allowlist Reading view uses for ordinary note content before display;
that consumer also strips every privileged and delegated-click class (internal/external links,
footnote references, source-jump and embed/attachment-open controls) so plugin output can never
pose as a trusted native control. It is a point-in-time record of what the plugin produced, never a
live callback: no render child, timer, or DOM reference from the compatibility renderer survives
the call.

The first exact evidenced instance is the established `cite` fixture identity (name `CITE`, version
`0.1.2`, `minAppVersion` `1.12.7`; see `src/main/plugin-package-inspection.test.ts` and
`scripts/check-plugin-package-inspection-e2e.mjs`), reified as an independently written Markdown
post-processor bundle at `fixtures/vaults/cite-settled-reading/.obsidian/plugins/cite/`. Native
Reading view fetches and mounts CITE's settled projection in an explicitly labeled panel beneath
the note's own rendered content, honestly showing one of: the settled projection, an installed but
inactive plugin, or a processor/timeout/too-large failure -- never unprocessed content silently
standing in for a settled result. The panel renders CITE's complete settled output for the note's
full current content, not an excerpt: because `render-markdown` receives the whole note (so CITE
can see cross-paragraph context exactly as it would in a real Reading render), and the compatibility
renderer's own `MarkdownRenderer.render` re-parses that whole note through its own Markdown-it
instance, the panel's content -- including the note's own top-level heading -- necessarily repeats
everything already shown natively above it. This is the honest, disclosed consequence of showing a
plugin's genuine complete output rather than a selectively merged excerpt, not a defect; it is
asserted directly in `scripts/check-cite-settled-reading.mjs`, which confirms the panel's body
contains the full note's text, not only its citation-bearing lines.

The second exact evidenced instance is the official MIT-licensed Dataview `0.5.68` release. Its
manifest, bundle, and stylesheet are fetched from the release and checked against pinned SHA-256
identities before the disposable-vault workflow begins. The reviewed trusted-workspace profile
admits that exact package's measured vault-read, network, editor-extension, workspace-UI, and
dynamic-code references. The renderer provides the real MIT CodeMirror 5 `5.65.21` mode registry
used by legacy plugins and explicitly permits reviewed same-origin and Blob workers. Dataview then
indexes fixture frontmatter and replaces its own fenced query in native Reading view with the
settled table instead of duplicating the whole note. The generic Reading allowlist sanitizes the
result first; a second strict pass restores only contained vault-local Markdown destinations as
native Threadleaf links. `pnpm test:dataview-reading` proves the indexed value, in-place table,
resolved file link and navigation, dark and light rendering, and the explicit raw-query fallback
when the plugin is disabled. This is evidence for that named table-query workflow, not a claim of
full Dataview compatibility.

Both `content` sent to the compatibility renderer and the settled `html` returned from it are
bounded: inbound `content` at 2 MiB (matching the note-embed service's own per-source-note cap),
outbound `html` at 8 MiB (matching the note-embed service's aggregate returned-Markdown budget,
since settled HTML can exceed its Markdown input due to tag/attribute overhead). Either bound
crossed reports the explicit `too-large` reason rather than truncating or hanging.

`src/runtime/obsidian-markdown-processors.test.ts` and
`src/application/plugin-markdown-projection-service.test.ts` cover the settled render, its explicit
failure states (including both size caps and the plugin ID/source path/content hash identity check
that actually enforces the bound-result guarantee), and the vault/content staleness guard;
`pnpm test:cite-settled-reading` and `pnpm test:dataview-reading` are the Electron/Xvfb proofs for
the two named workflows and their visible theme and failure-state behavior.

This slice does not claim general dynamic render-child or Live Preview/CM6 delivery for arbitrary
community plugins, and it does not claim Tasks compatibility. Live Preview and CodeMirror 6 remain
outside this bridge entirely (see [Live Preview compatibility](live-preview.md)); broader dynamic
delivery still requires a named executable workflow for each plugin and surface.

## Public signatures

The following signatures are compatible with the public Obsidian API definitions, with the
bounded behavior described below:

```ts
export interface MarkdownSectionInformation {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export class MarkdownRenderChild extends Component {
  readonly containerEl: HTMLElement;
  constructor(containerEl: HTMLElement);
}

export interface MarkdownPostProcessorContext {
  readonly docId: string;
  readonly sourcePath: string;
  readonly frontmatter: Record<string, unknown> | null | undefined;
  addChild(child: MarkdownRenderChild): void;
  getSectionInfo(element: HTMLElement): MarkdownSectionInformation | null;
}

export type MarkdownPostProcessor = {
  (element: HTMLElement, context: MarkdownPostProcessorContext): Promise<unknown> | void;
  sortOrder?: number;
};

export type MarkdownCodeBlockProcessor = (
  source: string,
  element: HTMLElement,
  context: MarkdownPostProcessorContext,
) => Promise<unknown> | void;

class Plugin {
  registerMarkdownPostProcessor(
    processor: MarkdownPostProcessor,
    sortOrder?: number,
  ): MarkdownPostProcessor;

  registerMarkdownCodeBlockProcessor(
    language: string,
    processor: MarkdownCodeBlockProcessor,
    sortOrder?: number,
  ): MarkdownPostProcessor;
}
```

`MarkdownRenderChild` is also exported from the `obsidian` compatibility module. `Component` is
the existing lifecycle base class.

## Observable behavior

1. `registerMarkdownPostProcessor` and `registerMarkdownCodeBlockProcessor` reject a non-function
   processor, an empty language, a non-finite sort order, or a non-integer sort order with an
   `Error`. A post-processor registration returns the exact callback object supplied by the caller.
   A code-block registration returns the public registration callback wrapper; its `sortOrder`
   property is mutable after registration and the supplied block handler remains separate.
2. Fenced-code processors run first. A fenced block is selected when its language, after trimming
   and ASCII case folding, equals the registered language. The host removes the original
   `<pre><code>` element, creates one empty `<div class="markdown-code-block">`, and passes the
   source without the Markdown fence or one trailing line ending. A block with no matching
   processor remains unchanged.
3. Ordinary post processors run after fenced-code processors. Both stages run in ascending
   `sortOrder`; equal orders retain registration order. A callback's current `sortOrder` property
   takes precedence over the value passed to registration. Each callback is awaited before the
   next callback starts.
4. A processor receives the rendered root element for the current call. `sourcePath` is the
   normalized path supplied to `MarkdownRenderer.render`, or an empty string for an in-memory
   render. `frontmatter` is the parsed top-level YAML mapping when the source begins with a valid
   frontmatter block, `null` for an explicit empty mapping, and `undefined` when no valid mapping
   is available. `docId` is deterministic for the source path and exact Markdown bytes.
5. `getSectionInfo(element)` returns `null` when the element is outside the current render root.
   For an element inside the root it returns the complete source text and zero-based inclusive
   `lineStart` and `lineEnd` for this bounded render. This explicit whole-render fallback is
   stable even when a parser cannot map an individual HTML node to source lines.
6. `context.addChild(child)` requires a `MarkdownRenderChild`. The child is attached to the
   component passed to `MarkdownRenderer.render`; it is loaded immediately when that component is
   already loaded and is unloaded with the component. A child does not grant filesystem or host
   authority.
7. A synchronous throw or rejected promise is an explicit render failure. The host stops the
   current processor sequence and rejects the render promise. It does not convert a failure into a
   successful no-op, hide it in diagnostics, or affect registrations owned by another plugin.
8. Unloading a plugin removes all of its processor registrations. A sibling plugin's processors,
   and a processor's already-created child component, remain independent until their own owner or
   render component is unloaded.

## Explicit limits

This slice does not implement `MarkdownPreviewRenderer` static global registration, arbitrary
renderer section partitioning, inline Live Preview processors, editor extensions, or plugin-owned
network and filesystem adapters. Those names are not advertised by this contract. A bundle that
requires one of those unsupported members must fail during activation or render rather than
receiving a silent no-op shim.

The compatibility host remains trusted. Static capability evidence is a review aid, not a runtime
sandbox, and a successful processor workflow does not imply universal plugin compatibility.

## Workspace editor paste events

`app.workspace.on(name, callback, context?)` and `app.workspace.off(name, callback)` retain live
listener identity and owner cleanup in both compatibility topologies. `on` returns a disposable
event reference; `off`, that reference's `off()`, plugin unload, and runtime teardown each remove
the matching listener without disturbing sibling registrations.

The measured cross-surface delivery is `editor-paste`. When at least one loaded plugin registers
that event, `RuntimeSnapshot.integrations.workspaceEvents` advertises it to the native editor. A
bounded `run-editor-paste` operation then carries the active note path, exact content, SHA-256
revision, selection offsets, and at most 1 MiB of plain clipboard text to the plugin runtime. The
runtime constructs a cancelable paste event, supplies the native-compatible `Editor` and
`MarkdownView`, awaits registered callbacks in load order, and returns both the final editor
projection and whether any callback called `preventDefault()`.

The native editor prevents the browser paste only after capturing a revision-bound fallback. If no
plugin handles the event, or plugin delivery fails before the note changes, Threadleaf applies the
same plain text at the captured selection. If the note, revision, or content changes first, the
fallback is refused rather than written to a different document. File-backed paste remains owned
by the attachment workbench and never enters this text-only bridge.

`pnpm test:url-selection-paste` proves the unchanged MIT Paste URL into Selection 1.11.4 release:
selected text plus a URL becomes a Markdown link, while ordinary text remains an ordinary paste.
The same gate accepts an explicit operator package directory and has passed the distinct 1.11.4
bundle installed in the acceptance vault. Each identity has its own reviewed authority profile;
the shared version string never substitutes for exact bytes. This is evidence for selected-text
URL paste only. The plugin's clipboard-reading command, every setting combination, and unrelated
workspace event names remain outside the claim.
