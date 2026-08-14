# Accessibility backlog

Phase one of the Phase 6 roadmap item "Complete independent security, accessibility,
data-loss, installer, updater, and plugin-host reviews; publish findings and remediation
status" (docs/roadmap.md). This pass covers the accessibility leg only: keyboard navigation,
screen-reader semantics, reduced motion, contrast, zoom, localization, bidirectional text, and
touch targets across `src/renderer/**`. It is a static code-analysis audit, not a runtime
verification; see Limitations at the end before treating any item here as confirmed against
real assistive technology.

## Summary

Threadleaf's renderer is unusually disciplined about accessibility for its size. Every one of
its 14 native `<dialog>` elements uses `showModal()`/`close()` with consistent pre-open focus
capture and post-close focus restoration, the app ships a real in-product accessibility
settings panel (contrast, per-surface font scaling, reduced motion, reduced transparency), and
the higher-risk custom widgets (the note graph, the JSON canvas, the command palette, the quick
switcher, the note tab strip) all implement real keyboard operability rather than mouse-only
shortcuts. Against that baseline, this pass found 10 concrete findings: 2 P1, 4 P2, 4 P3. The
P1s are narrow and precisely located (one widget class, one systemic gap), not evidence of a
pattern breakdown elsewhere. No finding here is a "the basics are missing" class of problem.

Counts by severity: P1: 2, P2: 4, P3: 4.

## Strengths

Credited so the backlog below reads as gap-filling, not a rebuild.

- **Every dialog uses the native modal API.** All 14 `<dialog>` elements in `index.html` (command
  palette, quick switcher, graph, recovery, settings, 4 package/authority review dialogs, and 5
  new-note/property/move/delete dialogs) are opened with `.showModal()` and closed with
  `.close()`, confirmed by direct call-site count (12 in `renderer.ts`, 1 each in
  `graph-view.ts:188` and `recovery-view.ts`). None fall back to `hidden` toggling, so focus
  trapping, `::backdrop`, top-layer stacking, and native Escape-to-cancel are free and correct
  rather than reimplemented.
- **Focus is captured and restored around every one of those dialogs.** Each of the 12
  `renderer.ts`-managed dialogs stores `document.activeElement` immediately before `showModal()`
  and returns focus to it after `close()` (e.g. `renderer.ts:2800`, `:2927`, `:3054`, `:3247`,
  `:3452`, `:3682`, `:3934`, `:4431`, `:5804`, `:5900`, `:7177`, `:7764`); `graph-view.ts:184-210`
  and `recovery-view.ts` do the equivalent independently.
- **Reduced motion is enforced twice, deliberately.** A blanket `@media (prefers-reduced-motion:
  reduce)` rule (`styles.css:8310-8317`) zeroes `animation-duration`/`transition-duration` on
  every element via the universal selector, so no individual `transition:`/`animation:` rule can
  be missed. A second, JS-driven `data-threadleaf-reduced-motion` attribute
  (`renderer.ts:5067-5069`, set at `:5106`) lets the in-app Accessibility setting override the OS
  preference in either direction. `canvas-view.ts:435-438` additionally checks
  `matchMedia("(prefers-reduced-motion: reduce)")` before choosing `smooth` vs `auto` scroll
  behavior for the canvas object-list jump action.
- **A real, working Accessibility settings page exists** (`index.html:827-980`): high contrast,
  a constrained accent-color set chosen to keep contrast in both schemes, independent UI text
  scale, reading text scale, editor font size, editor line height, reduced motion (system/on/off),
  and reduced transparency. This is well beyond what most desktop note apps this size ship.
- **Focus visibility has a strong global fallback.** `button:focus-visible, a:focus-visible,
  input:focus-visible, summary:focus-visible, [tabindex]:focus-visible` all get a 3px solid
  outline by default (`styles.css:118-124`), on top of 39 component-specific `:focus-visible`
  rules. Of the borderless search-input patterns that strip the native outline, 5 of 7 correctly
  compensate with a `:focus-within`/`:has()` rule on the wrapping element
  (`.search-field:focus-within` at `styles.css:589`, `.graph-search-input:focus-within` at
  `:3929`, `.recovery-toolbar label:focus-within` at `:4507`, `.plugin-index-search
  label:has(input:focus-visible)` near `:6282`, `.plugin-search-field:has(input:focus-visible)`
  at `:6397`); see P2 finding 3 for the 2 that do not.
- **Command palette and quick switcher implement the real ARIA 1.2 combobox pattern**, not an
  approximation: results get `role="option"` (`renderer.ts:3007`, `:8129`) and a toggled
  `aria-selected` (`:2958`, `:8094`), and the search input's `aria-activedescendant` is set to the
  active option's id and removed when none is active (`:2962`/`:2969`, `:8098`/`:8105`).
- **The note tab strip is a real tablist**, not a styled row of divs: `role="tab"`,
  `aria-selected`, and `aria-controls` pointing at the note view panel are all set
  (`renderer.ts:9079-9081`), and Arrow-key handling both cycles the active tab and reorders tabs
  (`:8969`, `:9009`, `:9108`, `:9113`), not just Tab-key traversal.
- **Settings navigation marks the active section for assistive tech**, not just visually:
  `aria-current="page"` is set on the active `settings-nav-*` button and removed from the rest on
  every page change (`renderer.ts:7976-7982`).
- **The note graph is fully keyboard-operable despite being a custom SVG canvas.** Each graph
  node is a real, independently focusable element (`role="button"`, `tabindex="0"`, a descriptive
  `aria-label` combining title and connection count, Enter/Space activation:
  `graph-view.ts:485-509`), and every node is *also* reachable through a parallel real-`<button>`
  list in the sidebar (`graph-view.ts:527-565`), matching the `aria-describedby` instructions
  baked into the dialog itself (`index.html:547-550`, "Tab to a note and press Enter to open
  it"). Hover-only visual feedback (`mouseenter`/`mouseleave`) is paired with `focus`/`blur`
  equivalents on both the SVG nodes and the sidebar rows (`graph-view.ts:499-502`, `:557-560`),
  so keyboard users get the same "highlight connected notes" feedback mouse users get. The
  keyboard pan/zoom implementation (`graph-view.ts:298-325`) exactly matches what
  `aria-keyshortcuts` and the `aria-describedby` text promise (`index.html:545-550`), which is a
  claim that is often made in markup and not actually true; here it is.
- **The JSON canvas has no drag-only affordance.** Every mutation (add text/group/file/link,
  connect, move, resize, remove, save) is a real `<button>` via a shared helper
  (`canvas-view.ts:20-27`); node position changes have explicit "Move left/right/up/down" and
  "Make larger" buttons (`:394-419`) as a full keyboard alternative to spatial dragging, and the
  board itself documents that the object list is the keyboard path
  (`canvas-view.ts:234-237`).
- **The one virtualized list in the app does ARIA virtualization correctly.** The file navigator
  list sets `aria-posinset`/`aria-setsize` on rendered rows (`renderer.ts:9477-9478`) so
  assistive tech is told the item's position in the full, unvirtualized set even though only a
  windowed subset of DOM nodes exists at a time.
- **6 of 7 Live Preview inline widgets pair mouse and keyboard activation.** Link, embed,
  image, footnote-reference, and math widgets all set `tabIndex = 0` and a `keydown` handler
  (Enter/Space) alongside their `mousedown` handler (verified directly: `live-preview.ts:1560`
  +`:1581-1585` for links; the count check is exhaustive, not sampled, at 7 `mousedown` listeners
  against 6 `keydown` listeners in the file). See P1 finding 1 for the one exception.
- **Dynamic accessible names are actually kept in sync with state**, not hardcoded once: the
  theme toggle's `aria-label` updates to name the *next* theme rather than freezing at "Switch to
  dark theme" (`renderer.ts:5344`), and toggle-style buttons throughout use `aria-pressed`
  reflecting live state rather than a static string.
- **Task-list checkboxes in Live Preview are real `<input type="checkbox">` elements**
  (`live-preview.ts:2160-2166`), keyboard-operable by default, not simulated with a styled div.
- Decorative glyphs are consistently marked `aria-hidden="true"` (63 occurrences across
  `index.html`) alongside a text label or a separate `aria-label` on the interactive parent, and
  a `cursor: pointer` sweep of the entire stylesheet found only 4 selectors, all of which resolve
  to genuinely keyboard-operable elements (a `<button>`, the graph SVG node, another `<button>`,
  and the one exception logged as P1 finding 1).

## Findings

| # | Sev | Surface | Location | Issue | Suggested fix direction | WCAG 2.2 |
|---|-----|---------|----------|-------|--------------------------|----------|
| 1 | P1 | Live Preview callout badge | `src/renderer/live-preview.ts:2011-2036` (`CalloutWidget.toDOM`) | The only one of 7 inline source-reveal widgets with no `tabIndex`, `role`, or `keydown` handler; it only listens for `mousedown`. An Obsidian-style `> [!note]` callout badge cannot be activated (reveal source) from the keyboard at all. Confirmed by exhaustive count: 7 `mousedown` listeners vs 6 `keydown` listeners in the file, and this is the one without a pair. | Mirror `LinkWidget` (`live-preview.ts:1554-1587`): add `tabIndex = 0`, a role (`role="button"` fits better than `role="link"` here), a descriptive `aria-label` naming the callout type, and a `keydown` handler for `Enter`/`Space` that calls the same activation path the existing `mousedown` handler uses. | 2.1.1 Keyboard (A) |
| 2 | P1 | User-supplied text throughout the shell (note titles, file/tab names, search and quick-switcher/palette results, markdown body) | No single line; confirmed absent app-wide (`rg` for `dir=`, `direction: rtl`, `unicode-bidi`, `<bdi` across every `*.ts`/`*.html`/`styles.css` in `src/renderer` returns zero matches) | Threadleaf places no bidirectional-text isolation anywhere: no `dir="auto"`, no `<bdi>`, no `unicode-bidi: plaintext`/`isolate`. Because vault content (note titles, folder and file names, tab labels, search results) is arbitrary user text with no language constraint, any note or file named in Arabic, Hebrew, Persian, or Urdu will have its surrounding punctuation and adjacent UI structure visually reordered by the browser's bidi algorithm in unpredictable ways. Most visible at `elements.noteTitle.textContent = note.title` (`renderer.ts:9607`), the file-list rows, the note tab strip, and the quick-switcher/command-palette result rows. | Apply `dir="auto"` (or CSS `unicode-bidi: plaintext`) to the elements that render arbitrary user-supplied strings; wrap short user strings embedded inside structured rows (counts, badges, paths) in `<bdi>` so they cannot pull neighboring UI text out of order. | 1.3.2 Meaningful Sequence (A), closest formal hook; WCAG has no dedicated bidi criterion |
| 3 | P2 | Command palette and quick switcher search inputs | `src/renderer/styles.css:4807-4817` (`.palette-search input`) and `:3580-3590` (`.quick-switcher-search input`) | Both set `outline: 0` unconditionally with no compensating `:focus-within`/`:has()` rule on the wrapping `.palette-search`/`.quick-switcher-search` container, unlike every other search-input pattern in the app (`.search-field`, `.graph-search-input`, `.recovery-toolbar`, `.plugin-index-search`, `.plugin-search-field` all define one). Both dialogs auto-focus this input on open and it is the primary control of two of the app's most-used surfaces, so a keyboard user gets no visible confirmation the field is focused, on open or when tabbing back to it. | Add `.palette-search:focus-within` and `.quick-switcher-search:focus-within` rules mirroring `.search-field:focus-within` (`styles.css:589-592`). | 2.4.7 Focus Visible (AA) |
| 4 | P2 | Document view switch (Live / Source / Read / Plugin) | `src/renderer/styles.css:1377-1379` (`.document-view-switch button { min-width: 34px; min-height: 21px; }`) | The primary mode switcher for every open note is 21px tall, below the WCAG 2.2 24px minimum target size. | Raise `min-height` to at least 24px; 28-32px is more comfortable given the buttons already carry text labels. | 2.5.8 Target Size Minimum (AA) |
| 5 | P2 | Note tab close button | `src/renderer/styles.css:1223-1229` and `:1296-1301` (`.note-tab-close`) | `padding: 0` with no explicit `min-width`/`min-height`; the effective hit box is close to the 15px glyph's own rendered bounds, well under the 24px minimum, on the most frequently repeated per-row control in the tab strip. | Give `.note-tab-close` an explicit `min-width`/`min-height` of at least 24px; the visible glyph can stay small inside a larger padded box. | 2.5.8 Target Size Minimum (AA) |
| 6 | P2 | Live Preview task-list checkbox | `src/renderer/live-preview.ts:2159-2166` (`TaskWidget.toDOM`) | `aria-label` is a generic `"Completed task"`/`"Open task"` rather than including the task's own text. A note with several task items is indistinguishable to a screen-reader user moving between checkboxes; every one announces the same two possible names. | Include the adjacent task text in the accessible name, for example by slicing the source line after the `[ ]`/`[x]` marker, or point `aria-describedby` at the rendered task text node. | 2.4.6 Headings and Labels (AA), 4.1.2 Name, Role, Value (A) |
| 7 | P3 | Document view switch, graph mode switch | `index.html:171-174` (Live/Source/Read/Plugin), `:477-478` (All notes/Local) | Both are groups of `aria-pressed` toggle buttons standing in for a mutually-exclusive choice, rather than `role="radiogroup"`/`radio` or `role="tablist"`/`tab`. Operable today via Tab and Enter/Space, but `aria-pressed` does not communicate "exactly one of these is selected" as directly as the alternative, and does not get arrow-key navigation for free. | Low priority; consider migrating to `radiogroup` or `tablist` semantics if these surfaces are next revisited for another reason. Not worth a standalone pass. | 4.1.2 Name, Role, Value (A), minor |
| 8 | P3 | Canvas zoom controls | `src/renderer/canvas-view.ts:20-27` (`button()` helper), used at `:108-125` | The shared button helper sets `aria-label` to the same glyph used as the visible label (e.g. `"−"`), so the descriptive text only exists in the `title` tooltip, which loses precedence to `aria-label` for the accessible name. Screen readers announce "minus, button" rather than "Zoom out, button." The graph dialog's equivalent controls get this right (`index.html:521-524`, `aria-label="Zoom graph out"` distinct from the visible glyph). | Pass a separate descriptive `aria-label` into the canvas toolbar's zoom buttons the way the graph dialog's zoom buttons already do; keep the glyph as the visible label only. | 2.5.3 Label in Name (A) is technically satisfied since the visible label is a literal substring of itself; this is a clarity gap, not a violation |
| 9 | P3 | Renderer-wide CSS | `src/renderer/styles.css`, 148 occurrences of physical `left`/`right`/`margin-left`/`margin-right`/`padding-left`/`padding-right`/`text-align: left|right`/`float`, 0 occurrences of logical equivalents (`inset-inline-*`, `margin-inline-*`, `text-align: start|end`) | Not a defect today: the UI ships English-only, `<html>` has no `dir` toggle, and there is no RTL locale switch. It is debt that would need a systematic pass before any RTL UI localization is attempted. Distinct from finding 2, which is about bidi handling of arbitrary user *content*, not the direction of the UI chrome itself. | Track as forward-looking debt only; do not schedule unless RTL UI localization is actually planned. | No applicable SC; localization readiness note |
| 10 | P3 | Markdown preview heading structure | `src/renderer/markdown-preview.ts:30-60` (`allowedTags`, includes real `h1`-`h6`) | Informational, not an app defect: markdown-it plus the DOMPurify allowlist renders user `# Heading` markdown as genuine semantic `<h1>`-`<h6>` elements, which is correct. A note's own top-level `# Title` can produce an `<h1>` inside the document while the app chrome already has its own `<h1 id="files-heading">Notes</h1>` in the sidebar (`index.html:71`), and heading-level skipping inside a note is the user's authoring choice, same as any Markdown tool, and out of the app's control. Logged so it is not mistaken for an unexamined gap. | None needed; no action recommended. | N/A, informational |

## Suggested lane batching

Grouped by file ownership so lanes do not collide on the same file.

1. **Live Preview keyboard parity** (`src/renderer/live-preview.ts` only): findings 1 and 6.
   Both are widget-level fixes inside the same file, narrow in scope, and each has a working
   sibling widget in the same file to copy the pattern from.
2. **Search-input focus visibility and touch targets** (`src/renderer/styles.css` only):
   findings 3, 4, 5. Pure CSS, no logic changes, easy to verify together with one visual pass
   across the command palette, quick switcher, document view switch, and note tab strip.
3. **Bidirectional text isolation for user content** (cross-cutting: `renderer.ts`,
   `markdown-preview.ts`, `live-preview.ts`, `index.html`): finding 2 alone. Kept separate
   because it touches every render site that outputs user-supplied strings (note title, file
   list, tabs, search results, preview body) and each site needs its own verification pass with
   right-to-left sample content; bundling it with the CSS-only lane would blur that verification.
4. **ARIA pattern and accessible-name polish** (`canvas-view.ts`, `index.html`; optional,
   purely additive): findings 7 and 8. Neither is a functional break, so this lane is safe to
   defer behind the first three.
5. **CSS logical-properties migration** (`styles.css`; deferred): finding 9. Do not schedule
   unless RTL UI localization is actually planned; flagged here only so the debt is visible.

Finding 10 needs no lane; it is informational only.

## Explicit limitations

- **Static analysis only.** This audit read source, markup, and stylesheets; it did not run
  Electron. The heavy-gate lock for this repo was saturated for the duration of this lane, and
  the task scope excludes Electron/Xvfb runs regardless. Every finding above is grounded in
  reading the actual code path (not inferred from naming or comments), but none of it has been
  confirmed against a real screen reader (NVDA, JAWS, VoiceOver, Orca), real OS zoom at 200%/400%,
  or real high-contrast/forced-colors mode.
- **A follow-up runtime lane should verify, in this order of value:** (a) the note graph's
  `role="application"` region under NVDA/JAWS with Chrome, since nested focusable `role="button"`
  SVG descendants of an `role="img"` ancestor (`index.html:551-557` containing `:539-546`) are
  spec-permitted but worth confirming render correctly in practice; (b) actual screen-reader
  output for finding 2's bidi content once fixed; (c) `prefers-reduced-motion` and the in-app
  override actually suppressing motion in the live app, not just in the stylesheet; (d) the
  Accessibility settings panel's font-scale sliders (`index.html:871-937`) under 400% OS zoom for
  reflow/clipping.
- **Files not read in full.** `renderer.ts` (11,695 lines) and `styles.css` (8,446 lines) were
  covered through systematic grep sweeps across every relevant pattern (click/keydown listeners,
  `aria-*`, `role`, `tabindex`, `:focus-visible`, `outline`, `dir`/rtl/bidi,
  `cursor: pointer`) plus full reads of every section a sweep surfaced, rather than linearly
  read start to end; both files are large enough that a second sweep with different search terms
  could still surface something this pass did not target. `markdown-extensions.ts`,
  `editor-text.ts`, `editor-text-history.ts`, `publish-export.ts`, `migration-review-identity.ts`,
  `attachment-move-status.ts`, `command-palette-model.ts`, `quick-switcher-model.ts`,
  `vault-search-model.ts`, `plugin-view-model.ts`, `workspace-tab-dnd.ts`, and `recovery-view.ts`
  were checked only through targeted grep and the HTML/CSS surface they render, not read
  line-by-line. `workspace-tab-dnd.ts` in particular implements the tab drag-and-drop mechanic
  directly; this pass confirmed a keyboard alternative exists for tab reordering
  (`renderer.ts:9009`) but did not fully audit `workspace-tab-dnd.ts` itself for additional
  pointer-only affordances, which is exactly the shape of surface most likely to hide another
  finding.
- **Contrast was not measured.** No color-contrast ratios were computed against the light or
  dark theme's actual computed styles; that requires a rendered page and a real contrast checker,
  not source reading. The Accessibility settings panel's "High contrast" option and constrained
  accent palette (`index.html:846-869`) suggest deliberate attention to this, but the claim is
  unverified by this pass.
- **Zoom robustness was checked structurally, not visually.** The canvas view's absolute
  pixel-positioned nodes (`canvas-view.ts:301-304`) are architecturally normal for a spatial
  whiteboard (the same pattern any node-graph editor uses) and were not flagged as a defect, but
  whether text reflows or clips inside those fixed-width node cards at high zoom was not checked
  against a live render.
