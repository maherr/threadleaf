# Obsidian behavior lab

The behavior lab is a clean-room, Linux-only external oracle for the declared Obsidian Flatpak
release `md.obsidian.Obsidian` version `1.13.7`. Each run records the installed Flatpak commit and
runtime reference (`org.freedesktop.Platform/x86_64/25.08` at the current baseline) and refuses to
observe a different app version or an unresolved runtime. It asserts one specific Threadleaf
compatibility behavior without reading either application's private implementation details:
open the fixture note, append synthetic UTF-8 text, save, exit, and reopen with the exact bytes
intact.

## Run contract

The harness creates a fresh mode `0700` run root under
`/tmp/threadleaf-obsidian-lab`, generates the independently authored
`obsidian-lab-vault-v1` fixture, and passes only run-root paths to the reference launch. The fixture
manifest is `compatibility/obsidian-lab-fixture.v1.json`; generation and verification live in
`scripts/obsidian-behavior-lab/fixture.mjs`.

The reference launch is accepted only when all of these controls are present:

- Flatpak `--sandbox`, `--nofilesystem=home`, and a run-root-only filesystem grant;
- per-invocation `HOME` and XDG config/cache/data directories rooted in that randomized run root;
- Flatpak `--unshare=network`, with a distinct network namespace proved through `/proc`;
- an in-sandbox supervisor (host PID sharing is prohibited) that binds the installed Flatpak
  version, runtime, commit, app PID/start/argv, and the supervisor -> `/app/obsidian` -> renderer
  lineage, plus exact profile/vault realpaths and hashes;
- `xvfb-run` with a `1440x840x24` X11 display, explicit `--ozone-platform=x11`, and a measured
  `800x650` renderer viewport;
- a bounded probe-quiescence wait and the conjunction of zero marker and zero Obsidian Flatpak
  instances before and after the reference run; the marker is cleanup aid, not process identity;
- a fresh randomized `--user-data-dir`, fixture-vault path, exact CDP arguments, and direct
  `obsidian://open` fixture-note argument inside Flatpak, without a host URI handler;
- a unique private loopback CDP port reused across edit/reopen and a surface-only screenshot (`fromSurface: true`,
  `captureBeyondViewport: false`).

The launcher runs `free -k` immediately before each Flatpak, Xvfb, or Electron launch and records
the complete memory-gate receipt. If `MemAvailable` is below 8 GiB, every dynamic cell is recorded
as `blocked` and no dynamic process is started. Profile, vault, and all mounted paths must remain
strict descendants of the dedicated temporary run root; known live Obsidian and workspace paths
are red controls.

If a required containment or observation primitive is absent, the affected cell is `blocked` and
the harness does not switch to the live desktop, loosen the sandbox, or infer a result. CLI-01 is
currently recorded as blocked when no separately isolatable public Obsidian CLI entrypoint is
available. Raw screenshots, process streams, profile receipts, and manifests remain mode `0600`
under the temporary run root and are never copied into the repository.

The Threadleaf candidate is also a fresh production Electron process, never a renderer fixture or
an internal `window.threadleaf` shortcut. It receives a dedicated run-root profile, HOME, XDG
directories, and TMPDIR; runs under Xvfb with explicit X11 and loopback-only CDP; disables Electron
background networking and component updates; and enables Threadleaf safe-plugin mode. Its fixture
note is selected through the visible navigation target, then real CDP pointer, keyboard, and text
input exercise the rendered CodeMirror editor. The candidate must preserve every fixture path except
the single note byte delta and must not write `.obsidian`.

## Cells in the first tranche

`HARNESS-00` proves fixture integrity, Xvfb, marker cleanup, probe quiescence, and the process
supervisor. `FILE-01` opens the fixture-specific note predicate, performs a synthetic edit, waits for
the reference app's autosave, exits, reopens, and requires an exact-byte round trip while allowing
only that one note delta plus the bounded fresh-profile allowlist. Obsidian's first-run app state may
also create or rewrite only
`.obsidian/app.json`, `.obsidian/appearance.json`, `.obsidian/core-plugins.json`, and
`.obsidian/workspace.json`, each under a bounded size and mode policy. `UI-01` records the measured visible-state projection,
normalized accessibility nodes, viewport surface geometry, and one private screenshot after reopen.
`CLI-01` records the explicit access gap without guessing a command grammar. Every run also emits
the candidate Git SHA/tree when available, a deterministic source tree hash, and exact hashes for
the runner, all lab modules, fixture manifest, and package script.

`THREADLEAF-01` runs the current built Threadleaf production app against an independently generated
copy of the same fixture. It opens `00 Overview.md` through visible navigation, appends
`THREADLEAF_OBSIDIAN_LAB_CANDIDATE_EDIT_V1`, saves, closes the process, launches a fresh process,
and proves the reopened on-disk bytes and visible text are exact. Its private screenshot must match
Threadleaf's measured renderer viewport. That screenshot is rendered-surface evidence, not a claim
that Threadleaf's minimum window geometry matches Obsidian's fixed `800x650` reference capture.

`MATCH-01` is the compatibility assertion. It is observed only when `FILE-01` and
`THREADLEAF-01` both complete the same open, edit, save, exit, reopen behavior with exact persisted
bytes, and Threadleaf changed no other fixture path. The reference-only containment and UI cells
remain evidence about the oracle, not hidden Threadleaf-equivalence claims.

The observer never reads bundled application code, source maps, private modules or assets; dumps
unbounded DOM or framework state; enumerates globals; accesses a real vault/profile; or permits
external egress. The fixture probe package is present but disabled in this tranche; it is not an
authority or an executed cell.

## Checks

Run deterministic harness and red-control tests with:

```sh
pnpm run test:obsidian-behavior-lab
```

Run the isolated first tranche with:

```sh
pnpm run obsidian:behavior-lab
```

The command builds Threadleaf first, then prints the private temporary `runRoot` and cell statuses.
Use `--red-control` to prove that a seeded fixture-byte mutation is rejected. Use
`--threadleaf-red-control` to remove the live disposable production CodeMirror editor after the
fixture has rendered. The real focus/input path must then block `THREADLEAF-01`, block
`MATCH-01`, and make the command exit nonzero. That is a passing red control only when its receipt
names `mutation-caught`: the editor remained absent and the production focus/input boundary itself
blocked. If the production edit, save, exit, and reopen path completes after the mutation,
`THREADLEAF-01` and `MATCH-01` are `failed`, with the reason `mutation unexpectedly completed the
production path`; that is a failed control, never an expected-looking red. The
`--threadleaf-red-control-reinsert-editor` variant deliberately removes and then reinserts the
disposable editor before focus/input to exercise that failed-control outcome. A following
unmodified run must restore both cells to `observed`. CLI-01 remains the documented exempt
`blocked` cell and is never silently counted as a pass. These mutations change no source or
persisted test fixture.

By default the run root is retained after sealing, for independent verification. `--cleanup` prints
the sealed manifest (all cell receipts) to stdout and then removes this run's root; it never touches
another run's root.
