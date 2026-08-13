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
levels. This transclusion fixture does not claim rendered note transclusion inside Live Preview,
block-range embeds, SVG rendering, or arbitrary plugin-defined embed processors. Live Preview's
separate bounded corpus and explicit exclusions are documented in
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
