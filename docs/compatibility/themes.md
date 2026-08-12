# Theme and CSS compatibility

Threadleaf reads the standard Obsidian vault layout so an existing theme or CSS snippet can be
tested without conversion:

```text
.obsidian/
  themes/<folder>/theme.css
  themes/<folder>/manifest.json
  snippets/<name>.css
```

These paths are compatibility input only. Threadleaf does not install into, rewrite, enable, or
disable files under `.obsidian/` in the current phase.

## Discovery and identity

A theme exists when a contained theme folder has a regular `theme.css`. `manifest.json` is optional
and contributes a bounded display name, version, and author. A snippet is one contained regular
file whose name ends in `.css`, case insensitively. Catalogs are locale-stable and naturally sorted.

Threadleaf derives opaque IDs from the exact folder or filename:

```text
obsidian-theme:<encoded folder>
obsidian-snippet:<encoded filename>
```

The selected theme, ordered enabled snippets, and base scheme are keyed by vault identity in
Threadleaf's private application settings. Opening the same vault later restores that selection.
Moving settings between unrelated vaults cannot activate a package by basename alone.

## Cascade order

The renderer applies appearance layers in this order:

1. Threadleaf's light or dark baseline variables and components.
2. The selected community `theme.css`.
3. Enabled snippets in the persisted order shown by Settings.

The root and body carry `theme-light` or `theme-dark`. Current compatibility aliases cover the app
container, title bar, workspace splits, tabs and leaves, file navigation, Markdown source and
reading views, inline title, and status bar. The baseline also publishes commonly used Obsidian
background, text, accent, icon, font, radius, and file-margin variables.

This is a measured subset, not a claim that every existing selector is already supported. A theme
reaches compatibility only when named views pass a rendered workflow. Unsupported selectors remain
inert CSS and do not block the rest of the theme.

## Loader boundaries

- Realpath containment prevents a symlink from escaping its expected appearance directory.
- Theme CSS is limited to 2 MiB, each snippet to 512 KiB, and each manifest to 64 KiB.
- Combined active custom CSS is limited to 4 MiB. Theme and snippet catalogs are limited to 256
  entries each.
- Files must be valid UTF-8.
- `@import`, direct external URLs, and legacy executable CSS constructs are rejected.
- Embedded data and fragment URLs are accepted. Variable URLs remain constrained by the renderer
  content-security policy, which blocks network loads.
- The active vault identity is checked again after asynchronous loading so a late result cannot
  cross a vault switch.

An unavailable, oversized, malformed, or rejected selection produces a visible warning and falls
back only for that asset. One invalid snippet does not discard a valid selected theme or other
snippets.

## Recovery

Ctrl/Cmd+Alt+L invokes the default recovery action. It clears the selected community theme and all
enabled snippets for the current vault, persists that state, and leaves the chosen base scheme
unchanged. The shortcut is remappable.

For a startup problem, launch with either boundary:

```sh
THREADLEAF_SAFE_APPEARANCE=1 pnpm start
pnpm start -- --safe-appearance
```

Safe mode suppresses custom CSS for that process without deleting the saved selection. Settings
still lists the discovered catalog, selected values, and diagnostic warning so the user can inspect
or permanently clear them.

## Remaining work

- Preview a theme or snippet before persisting it.
- Watch appearance files and reapply them without manual reload.
- Install, update, roll back, uninstall, and export packages through an open index.
- Generate selector and token coverage from representative open community themes.
- Add high-contrast, zoom, high-DPI, localization, and committed screenshot matrices.
- Extend compatibility to every future workspace view, pop-out, Canvas surface, and plugin-provided
  component.
