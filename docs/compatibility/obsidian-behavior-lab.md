# Obsidian behavior lab

The behavior lab is a clean-room, Linux-only observer harness for the declared Obsidian Flatpak
release `md.obsidian.Obsidian` version `1.13.6`. Each run records the installed Flatpak commit and
runtime reference (`org.freedesktop.Platform/x86_64/25.08` at the current baseline) and refuses to
observe a different app version or an unresolved runtime. It is a benchmark and compatibility
input, not a claim that Threadleaf reproduces private implementation details.

## Run contract

The harness creates a fresh mode `0700` run root under
`/home/maher/.cache/threadleaf-agent-tmp/obsidian-lab`, generates the independently authored
`obsidian-lab-vault-v1` fixture, and passes only run-root paths to the reference launch. The fixture
manifest is `compatibility/obsidian-lab-fixture.v1.json`; generation and verification live in
`scripts/obsidian-behavior-lab/fixture.mjs`.

The reference launch is accepted only when all of these controls are present:

- Flatpak `--sandbox`, `--nofilesystem=home`, and a run-root-only filesystem grant;
- Flatpak `--unshare=network`, with a distinct network namespace proved through `/proc`;
- an in-sandbox supervisor (host PID sharing is prohibited) that binds the installed Flatpak
  version, commit, app PID/start/cmdline, renderer argv, and profile/vault realpaths and hashes;
- `xvfb-run` with a `1440x840x24` X11 display and explicit `--ozone-platform=x11`;
- an inherited run marker, a quiet post-exit scan, and marker-based descendant cleanup;
- a fresh `--user-data-dir` under the run root and an exact synthetic-vault manifest;
- a unique loopback CDP port and a surface-only screenshot (`fromSurface: true`,
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

`HARNESS-00` proves fixture integrity, Xvfb, marker cleanup, and the process supervisor. `FILE-01`
records exact before and after synthetic-vault bytes plus the bounded fresh-profile allowlist.
`UI-01` records a bounded visible-state projection, normalized accessibility nodes, viewport
surface geometry, and one private screenshot when CDP is reachable. `CLI-01` records the explicit
access gap without guessing a command grammar.

The observer never reads bundled application code, source maps, private modules or assets; dumps
unbounded DOM or framework state; enumerates globals; accesses a real vault/profile; or permits
external egress. The fixture probe package is present for later public-plugin cells but is not
executed by this tranche.

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
that a seeded fixture-byte mutation is rejected. `--cleanup` does not delete receipts: sealing and
retention are deliberately separate from the observer process.
