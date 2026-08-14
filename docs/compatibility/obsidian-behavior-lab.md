# Obsidian behavior lab

The behavior lab is a clean-room, Linux-only observer harness for the declared Obsidian Flatpak
release `md.obsidian.Obsidian` version `1.13.7`. Each run records the installed Flatpak commit and
runtime reference (`org.freedesktop.Platform/x86_64/25.08` at the current baseline) and refuses to
observe a different app version or an unresolved runtime. It is a benchmark and compatibility
input, not a claim that Threadleaf reproduces private implementation details.

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

## Cells in the first tranche

`HARNESS-00` proves fixture integrity, Xvfb, marker cleanup, probe quiescence, and the process
supervisor. `FILE-01` opens the fixture-specific note predicate, performs a synthetic edit/save,
exits, reopens, and requires an exact-byte round trip while allowing only that one note delta plus
the bounded fresh-profile allowlist. Obsidian's first-run app state may also create or rewrite only
`.obsidian/app.json`, `.obsidian/appearance.json`, `.obsidian/core-plugins.json`, and
`.obsidian/workspace.json`, each under a bounded size and mode policy. `UI-01` records the measured visible-state projection,
normalized accessibility nodes, viewport surface geometry, and one private screenshot after reopen.
`CLI-01` records the explicit access gap without guessing a command grammar. Every run also emits
the candidate Git SHA/tree when available, a deterministic source tree hash, and exact hashes for
the runner, all lab modules, fixture manifest, and package script.

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

The command prints the private temporary `runRoot` and cell statuses. Use `--red-control` to prove
that a seeded fixture-byte mutation is rejected. By default the run root is retained after sealing,
for independent verification. `--cleanup` prints the sealed manifest (all cell receipts) to stdout
and then removes this run's root; it never touches another run's root.
