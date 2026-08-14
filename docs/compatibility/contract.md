# Compatibility contract

Threadleaf treats compatibility as measured behavior, not a binary marketing claim.

## Levels

| Level | Meaning | Required evidence |
| --- | --- | --- |
| 0 | Discovered | Valid manifest and bundle found |
| 1 | Loaded | Bundle evaluated and plugin instance constructed |
| 2 | Activated | `onload` completed without an uncaught error |
| 3 | Integrated | Commands, events, views, or processors registered as expected |
| 4 | Workflow verified | A representative user workflow passed end to end |

A plugin may pass one workflow and fail another. Reports must name the tested behavior and runtime
version instead of assigning an unexplained universal percentage.

## Evidence sources

- Public API documentation and permissively licensed type definitions.
- Open file-format specifications.
- Open-source plugin code and published plugin bundles.
- Independently written synthetic fixtures and behavior tests.
- User-submitted failure reports reduced to reproducible fixtures.

Proprietary application code, copied assets, and decompiled bundled resources are out of scope.
Third-party directories, feature tables, stars, and README claims are discovery inputs only. They
do not raise a compatibility level without a production-path fixture.

## Pre-enablement evidence

The installed-package catalog reports evidence before execution. Manifest metadata states an
Obsidian API baseline and desktop-only flag; it is not proof of compatibility. Standard plugin
packages bundle external dependencies into `main.js` and do not declare a cross-plugin dependency
graph in `manifest.json`, so Threadleaf states that model instead of fabricating dependencies.

Workflow evidence is keyed by plugin ID and exact version. An exact tested release may display its
measured level and named scope. A different release remains level 0 and names the prior tested
version only as context. An otherwise valid unknown package is discovered at level 0 until a
production-path fixture raises it.

## Migration evidence

Opening a vault is not authorization to copy behavior. Threadleaf's Migration preview reads only a
fixed, bounded, contained set of existing `.obsidian` metadata and does not load plugin code or
write any source or destination setting. It reports exact-version plugin evidence, private settings
shape without keys or values, reviewed hotkey mappings, available appearance assets, and restorable
note tabs. Unsupported and missing behavior remains explicit.

The preview is covered by malformed-input, oversized-input, containment, private-value
non-disclosure, and exact-byte preservation fixtures. The production Electron surface is checked in
light and dark schemes against a copied real-world Obsidian configuration. Reviewed apply is
separately covered for per-item keyboard selection, exact grant conflicts, private-state restart
recovery, rollback conflict safety, and complete `.obsidian/` byte preservation. These checks
establish a private-state transaction boundary, not authority to rewrite Obsidian metadata. See the
[migration contract](migration.md) for source limits, candidate rules, and transaction semantics.

## Headless catalog fixture

The headless CLI has a separate Level 0 catalog fixture for discovered community-plugin packages,
community themes, and CSS snippets. It reuses the contained desktop loaders but never evaluates a
plugin bundle or applies catalog CSS. The fixture covers public command names and arguments,
deterministic text and JSON, empty and missing sources, malformed manifests, oversized bundles and
CSS, external symlinks, and no-write behavior.

Its projection is intentionally narrower than migration preview or desktop settings. It exposes
only safe catalog metadata and numeric diagnostics. Private enablement and active selection, plugin
settings values, raw hotkeys, vault identity, absolute paths, source code, CSS, and raw loader
errors cannot enter CLI output. Core-plugin, action, hotkey, and workspace inventory remain outside
this fixture until a safe headless authority and executable behavior contract exist.

The headless daily, template, and random-note fixture covers `daily:path`, `daily:read`,
`daily:append`, `daily:prepend`, `templates`, `template:read`, and `random:read` against disposable
vaults. It exercises LF and CRLF notes, frontmatter-aware prepend, existing and absent daily notes,
bounded UTF-8 and oversized templates, contained-path rejection, resolution on and off, stable
template ordering, folder filtering, duplicate-name ambiguity, empty random corpora, deterministic
injected selection, interrupted-write recovery, and zero vault writes for reads. These commands
require an explicit vault, remain offline, and report argument or behavior compatibility rather than
byte-identical output or active GUI control.

The separate [automated package inspection](package-inspection.md) consumes an exact package byte
set before distribution or enablement. It adds bounded trusted activation, registration, cleanup,
timeout, and disposable-vault evidence without treating static inspection as a sandbox. Its
candidate level stops at Level 3 because a named workflow is required for Level 4.

## Native note transclusion fixture

Reading view recognizes wiki and Markdown note embeds without changing source bytes. The verified
surface resolves whole-note, heading, and block-ID targets through the current rebuildable metadata
index. Heading extraction includes descendants until the next peer or higher heading. Block lookup
ignores code and HTML-comment lookalikes. Nested fragments reuse the same sanitizer, link resolver,
raster-image loader, and source-navigation controls as the root note.

The production fixture proves nested same-note sections terminate correctly, true cycles remain
visible rather than recursing, exact source controls open the embedded note and line, and nested
links and images resolve relative to the embedded note. It also proves explicit failure states for
missing and ambiguous targets, invalid subpaths, private and out-of-vault paths, invalid UTF-8,
oversized notes, stale vault responses, depth, count, and aggregate-byte limits. Current limits are
2 MiB per source note, 32 expanded fragments, 8 MiB of returned Markdown, and four recursive
levels. Live Preview adds a separate bounded source-backed card and mapping corpus, but does not
claim recursive rich rendering inside the editor, block-range editing, SVG rendering, or arbitrary
plugin-defined embed processors. Its explicit exclusions are documented in
[Live Preview compatibility](live-preview.md).

## Same-vault behavior corpus

The repository's implementation-neutral same-vault corpus covers links, aliases, heading and block
anchors, note embeds, attachments, typed and malformed frontmatter, rename rewrites and exclusions,
Unicode and ambiguity, external atomic saves, JSON Canvas byte preservation, and `.obsidian/`
coexistence. Its manifest, provenance, case schema, and contribution contract live in
[Same-vault behavior corpus](same-vault.md). The executable gate runs supported cases through the
public kernel, application services, and CLI on temporary copies, compares every canonical byte,
and reports unsupported cases separately. It does not treat an untested external application as a
pass or require an external product during offline checks.

## Complex properties and passive attachments

The same-vault fixture also covers dotted and indexed nested property paths, exact scalar patches,
mapping additions, list-leaf removal, CRLF and BOM preservation, comments, quoted values, duplicate
keys, anchors, tags, multiline scalars, flow values, malformed frontmatter, and revision races.
The complex property service uses a line-range proposal rather than a serializer. Unsupported
constructs remain readable and byte-identical; a mutation that would normalize one is reported as
unsupported instead of silently choosing a winner or rewriting unknown YAML.

Local non-note embeds are resolved only inside the active vault. A bounded read classifies PDFs,
common documents, audio, video, text, archives, and unknown bytes by magic bytes, never by filename
extension. The reading view shows metadata and explicit open/reveal affordances without injecting
bytes into an executable or media element. Relative Markdown links and wiki embeds are rewritten
by the recoverable attachment publication planner, with one shared local-target parser, exact query and
fragment preservation, case/NFC-aware source and duplicate-basename refusal, and revision-bound
external-edit conflicts. Media metadata probes use a fast seek, one-second bounded
sampling, capped output, and a kill deadline; no arbitrary decode is part of offline reading view.
The reading-view card exposes a reachable Publish copy workbench. It binds the source revision,
previews exact local rewrite targets, and binds the exact Markdown path set, note revisions, and
metadata generation. Direct write targets and the source revision are checked in the mutation lane.
Attachment publication is a distinct source-retaining outcome: the exact source bytes are retained,
the destination is installed without overwrite, Markdown references are rewritten only after that
publication receipt, and success is reported as `published-source-retained`. A collision, source
replacement, containment failure, unsupported sharing primitive, crash, or recovery mismatch keeps
external bytes and retained evidence and returns a conflict or recovery result instead of claiming a
rename.
Ordinary and image reference-style usages share a source-evidence safety policy. A visible single
source definition rewrites once; source-only, opaque, unresolved, ambiguous, or source-related
duplicate definitions block publication. CommonMark's deterministic first-definition precedence does
not relax this local safety boundary. Dormant, unrelated, and external definition bytes remain
unchanged.
Generic attachment-link scans are offset-preserving. Renderer-recognized code, HTML, autolink, tag,
and bounded math regions stay opaque, while complete wiki spans and valid reference-definition lines
are parsed once before they are masked from generic rescans.
Definition destinations are supported only on one physical source line. A source-related multiline
destination is retained as opaque evidence and blocks publication rather than receiving a partial
rewrite; a definitely unrelated continuation remains byte-identical and nonblocking.
The strict publish gate is `FILE-PUBLISH-CAP-02`: vault open/create performs a non-mutating native
binding, descriptor-containment, and destination-device preflight only. For an already-existing,
contained exact destination parent, Threadleaf then uses its held directory descriptor to create an
unnamed `O_TMPFILE` inode, write one bounded byte, apply mode 0600, fsync the inode and directory,
and close it before it creates a journal, evidence, target, or Markdown change. This no-name probe
proves anonymous-inode create, write, and durability on the exact target filesystem and directory
without exposing a vault pathname. It cannot prove `linkat` at the actual basename without creating
a visible name. The final absent-name `linkat` and directory sync therefore remain the authoritative
publication and no-overwrite receipt before Markdown mutation. No target-side staging pathname is
exposed, and an existing claimant is never replaced.
Strict publication requires an already-existing contained destination parent. A missing or unsafe
parent, unavailable publication capability, or cross-device layout fails as a typed conflict before
Threadleaf creates a journal, evidence, target, or Markdown change. When link rewrites are required,
every rewritten note parent and the receipt-gated private rollback claim directory need the
descriptor and same-device receipt, not the no-name probe, because they do not publish the
attachment. A cross-device layout fails before publication.
There is no exclusive-copy fallback because a crash could expose a partial final target. ReFS-like
unsupported anonymous-inode or link behavior, `EXDEV`, durability failure, unsupported
descriptor/reparse behavior, and Windows sharing violations are typed unsupported capability states
before Markdown mutation. A final native capability failure after durable intent returns
`attachment-publish-unavailable`, leaves source and Markdown bytes unchanged, and retains the
private journal and evidence for recovery. It does not claim that the exact target is absent, because
`linkat` may have succeeded before a later durability failure.
Strict attachment claims are moved through no-clobber retention or left as recoverable evidence;
they are never unlinked through a mutable pathname. Portable private stages use bounded
high-entropy claims and clean only after exact verification under the documented ordinary-editor
threat model. Private rollback claims are grouped by transaction and removed only after a
durable `committed` history receipt, with the same receipt-gated sweep repeated at startup after a
crash. An uncertain claim has no automatic pathname GC.
The whole-corpus receipt is a conservative preflight and post-mutation check, not an atomic lock
against arbitrary external writers: a change observed after the final preflight drives exact
journaled rollback or a manual conflict, preserving surviving bytes and never silently retiring a
pending transaction. Strict attachment publication additionally scans the full non-hidden,
non-private lexical namespace by NFC- and case-folded complete path. Files, directories, symlinks
without descent, and special entry names participate. The scan runs at final pre-publication, after
exact publication before Markdown writes, after Markdown writes before commit, and before
source-retained recovery success. The post-write barrier rolls revision-matched Markdown back. It
treats an observed equivalent claimant as a manual conflict and preserves both external and
published bytes. The scan is a detection barrier, not an atomic normalized-name reservation: a
same-UID process can race a pathname during or after it, while descriptor-contained mutation still
prevents redirection and `linkat` protects only the exact basename. Note tabs and bookmarks are not remapped: those are Markdown note
identities, not attachment references. The packaged attachment fixture exercises metadata cards
for a PDF-signature file, an MP3-signature file, and unknown bytes; its move byte-preservation path
uses the PDF-signature fixture only. It makes no broader attachment format support claim. Its gate
requires explicit X11 Xvfb, a dedicated profile and vault, real CDP pointer and keyboard input,
hit-target checks, mandatory light/dark/positive-control screenshots, and a pixel-changing positive
control before a completed run can count as packaged evidence. Open and Reveal remain inert until a
separately reviewed native capability is implemented.

The Excalidraw-specific public-format extension lives in
[Excalidraw round-trip boundary](excalidraw-roundtrip.md). It adds native `.excalidraw` JSON,
frontmatter, compressed and uncompressed Markdown scenes, Unicode and nested attachment manifests,
rename reference rewrites, exact-byte versus semantic comparisons, and a revision-conflict case.
Its packaged Electron gate is separate because it requires an explicit X11 Xvfb display, temporary
profile, CDP, and the unchanged public plugin release at runtime.

## Phase 0 fixture

The first fixture is an unchanged CommonJS bundle that:

1. imports `Plugin` and `Notice` from `obsidian`;
2. extends `Plugin`;
3. registers a command during `onload`;
4. creates a notice when the command runs;
5. releases its registrations on unload.

The acceptance test must exercise the bundle through the same loader used by Electron.

## Visible view fixture

The production renderer fixture registers an `ItemView`, opens it through the shared workspace
model, and proves that its title, content, action icon, layout bounds, theme, and close lifecycle
cross the main-renderer and compatibility-renderer seam. The unchanged Excalidraw 2.25.3 bundle is
then sampled through that same path. Its verified workflow opens an existing Excalidraw Markdown
document, mutates the scene, saves with the file revision through the recoverable writer, closes and
detaches the plugin leaf, and reopens the exact persisted scene. A second verified workflow runs the
unchanged plugin's new-drawing command, creates its standard nested folder and
`Drawing <timestamp>.excalidraw.md` file through the recoverable kernel, opens the resulting custom
view, persists deterministic scene elements, fully closes the view, and reloads those elements from
the exact saved file. A third workflow runs the unchanged auto-create-and-embed command from a
native Markdown editor, creates the drawing through the recoverable kernel, and inserts its embed
link into the revision-bound draft. A fourth opens Export Drawing and verifies both SVG-to-vault
and PNG-to-vault creation and overwrite. The SVG parses as XML, while the PNG retains its exact
binary signature and decodes as the expected image after closing and reopening the drawing. A fifth
workflow unloads Excalidraw while that drawing view is active. It proves the plugin instance,
canvas leaf, plugin-owned release modal, all 69 commands, and every registered view, extension,
processor, suggester, ribbon, and settings tab are gone, then repeats reload and unload without a
duplicate or captured runtime error. These results do not imply inline wiki-embed rendering or
every export format.

## Compatibility-host resource policy

Every Electron compatibility request is measured against the versioned
`PluginRendererOperation` surface. The policy has explicit startup (`initialize`) and close
deadlines, plus per-plugin renderer memory and sustained CPU guardrails owned by the main process.
CPU enforcement waits through its startup quiet window and requires consecutive over-budget
samples. Electron metrics are injectable for deterministic tests; when production metrics are
missing or invalid, the snapshot says unavailable and Threadleaf does not infer a value or kill a
plugin. Breaches produce structured diagnostics and terminate only the owning compatibility
renderer, after which explicit reload is required. This is a trusted-host availability control,
not OS sandboxing or hard isolation from Node-capable plugin code.

## Native extension capability fixture

Native Threadleaf extensions use the separate version 1 capability host described in
[Native extension capability contract](native-extensions.md). A manifest review computes exact
bundle and authority digests; a private per-vault grant must match both before an entrypoint or
public port call can run. A changed bundle, authority growth, stale grant, revocation, safe mode,
cross-vault request, undeclared request, missing adapter, timeout, and teardown each have a typed
failure. The portable fixture reads a note and writes a summary only through public vault ports.

Invocation and teardown deadlines are in-process availability limits: they abort the context signal
and reject later guarded port calls, but do not cancel already-running extension code or undo an
adapter operation that has already started. A teardown callback failure takes precedence as a typed
`NativeExtensionError` with code `teardown`; when execution also failed, the execution error remains
available as its `cause`. This host is an API boundary, not an OS sandbox or production bundle
isolation mechanism.

This fixture measures a capability boundary, not universal native-code isolation. The host reports
`sandboxed: false` because this first implementation is in-process. Desktop navigation,
subprocess, secrets, and dynamic-code ports are explicit trusted desktop escapes; they are not
portable and must not be described as sandboxed. Existing Obsidian compatibility plugins remain in
the separately labeled trusted runtime.
