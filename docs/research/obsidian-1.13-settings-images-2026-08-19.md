# Obsidian 1.13 settings and image interaction mining

**Last updated:** 2026-08-19

## Decision gate

Threadleaf needed current primary-source evidence for three product seams: searchable settings,
plugin-authored settings, and full-screen image interaction. The goal was behavioral direction and
an executable local contract, not source-code parity or reuse of proprietary implementation.

## Primary sources

- [Obsidian 1.13.0 Desktop](https://obsidian.md/changelog/2026-05-28-desktop-v1.13.0/)
- [Obsidian 1.13.1 Desktop](https://obsidian.md/changelog/2026-06-09-desktop-v1.13.1/)
- [Obsidian 1.13.2 Desktop](https://obsidian.md/changelog/2026-07-14-desktop-v1.13.2/)
- [Obsidian 1.13.3 Desktop](https://obsidian.md/changelog/2026-07-21-desktop-v1.13.3/)
- [Obsidian 1.13.4 Desktop](https://obsidian.md/changelog/2026-07-27-desktop-v1.13.4/)
- [Obsidian 1.13.5 Desktop](https://obsidian.md/changelog/2026-08-05-desktop-v1.13.5/)
- [Declarative settings migration guide](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings)
- Public MIT type declarations in Obsidian's published developer package, locally pinned for
  interface inspection only.

The official web changelog search returned no indexed Desktop 1.13.6 or 1.13.7 page on 2026-08-19.
Threadleaf therefore makes no feature claim for those point releases from filenames or a locally
installed version number.

## Findings by seam

### Searchable settings

The 1.13 line treats settings as a navigable information surface rather than a stack of unrelated
forms. The primary behavior includes name and description search, keyboard navigation, search
refocus, stable focus after back navigation, and ordinary Tab traversal. Later point releases fixed
validation cleanup and rapid page-navigation races, showing that focus and state lifetime are part
of the feature rather than optional polish.

Disposition: **Adapt**. Threadleaf uses its own window, structure, styles, state, and renderer. It
implements searchable core and compatible plugin rows, nested result filtering, keyboard focus,
and explicit validation state. The live visual matrix and unit tests are the acceptance authority.

### Declarative plugin settings

The public migration guide defines `getSettingDefinitions()` as an opt-in host-rendered path. The
host renders, indexes, validates, binds, and persists ordinary controls. A plugin that supports older
hosts can retain `display()` as a fallback, while a non-empty declarative result takes precedence on
the newer host. Definitions can include conditional visibility or disabled state, lists, nested
pages, validation, and custom rendering or actions.

Disposition: **Adapt** for the compatibility host and **Extract** for public type shape only.
Threadleaf independently renders the supported definition grammar and persists through its existing
plugin data boundary. It does not copy Obsidian implementation code or assets. A definition outside
the tested grammar remains unsupported rather than being guessed.

### Image interaction

The 1.13.2 to 1.13.4 sequence establishes a coherent image-viewer baseline: open from the document,
navigate the current note's images, zoom, reset, pan, close by keyboard, and show the current file
name. Live Preview image selection and source editing are a related but larger editor seam.

Disposition: **Adapt** for the reading-view lightbox and **Benchmark** for the still-broader Live
Preview image-editing surface. Threadleaf's lightbox consumes only already authorized bounded raster
data, adds no filesystem or network authority, restores focus on close, and has unit plus rendered
Electron evidence. Source-level image resizing remains outside this repair.

## Rights and claim boundary

The changelogs, developer guide, and permissively licensed type declarations establish public API
and visible behavior. They do not authorize copying proprietary source, implementation text, or
assets. Threadleaf's implementation, tests, CSS, fixtures, and interaction state are independently
authored. Compatibility claims are exact to executable Threadleaf evidence, not inferred from the
reference product's release notes.

## Saturation result

Two bounded passes over the official desktop changelog sequence and the official migration guide
found no additional candidate that changed authority, implementation order, or acceptance proof.
The decision gate is closed for this repair. Future point releases reopen it only when a published
behavior or API change affects a supported Threadleaf seam.
