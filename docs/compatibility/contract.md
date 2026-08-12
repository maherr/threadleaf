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
then sampled through that same path. A loaded canvas is evidence only for opening an existing
Excalidraw Markdown document; it does not imply that create, edit, save, embed, reopen-after-write,
or export workflows pass.
