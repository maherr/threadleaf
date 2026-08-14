# Threadleaf and Obsidian

Threadleaf is not affiliated with or endorsed by Obsidian. This document compares the two projects
for people who already use Obsidian and are deciding whether Threadleaf is worth a try. It is
written to be checked, not taken on faith.

Every claim about Threadleaf below cites the exact file, script, or generated artifact in this
repository that backs it up, so a reader can open the cited path and confirm it directly. Claims
about Obsidian describe widely known, stable facts about its product; Obsidian's source is not
public, so those statements are general knowledge rather than citations into a repository, and are
kept intentionally general rather than pinned to specific numbers that could go stale.

This is written against Threadleaf 0.1.0-beta.3, commit `e460e83695b7fc970de89edf6004c8dcb3d675d4`.
Threadleaf is a young beta. Read this alongside the [project charter](../charter.md) and
[roadmap](../roadmap.md), which are more current than any snapshot comparison can stay.

## Where Threadleaf is ahead today

### Fully open source

Threadleaf's application core is licensed `AGPL-3.0-or-later` (see [`LICENSE`](../../LICENSE) and
the `license` field in [`package.json`](../../package.json)). The full source, including the vault
kernel, the compatibility host, and the release tooling, is in this repository. Obsidian's
application is closed source: it is free to use, including for commercial use, and has a plugin
API, but its own core is not published.

### Interruption-tested, recoverable vault writes

Every write to a user's notes and attachments goes through a durable, no-clobber writer with a
crash-recovery journal (plugin-package installs are a separate, staged-rename path and are out of
scope for this claim). An external edit becomes an explicit, labeled conflict copy instead of a
silent overwrite. This is a stated project invariant, not an incidental property: see
[`AGENTS.md`](../../AGENTS.md) ("User-vault mutations must be explicit, atomic, recoverable, and
tested under interruption"), the [project charter](../charter.md)'s invariant 6 ("Every write path
is tested under interruption before it reaches user vaults"), and its "what better means" list,
which names "atomic writes, recovery, snapshots, and explicit conflict handling" outright. The
[roadmap's Phase 1 exit gate](../roadmap.md) records "58 automated tests cover the interruption
matrix, external races, single and multi-file recovery, live watcher delivery and fallbacks,
operation attribution, and index equivalence through the real writer-to-watcher seam." The same
behavior is reachable from the CLI, though not uniformly: `create`, `append`, `prepend`,
`property:set`, and `task` all return a `CONFLICT` exit code and preserve the losing write as a
conflict copy when an external edit wins a revision race; `move` and `rename` do the same
specifically when link rewrites are part of the transaction; `delete` returns `CONFLICT` and
changes nothing rather than writing a second copy, because a prior trash entry at that path simply
blocks the operation instead of racing one. See [`docs/cli.md`](../cli.md).

### Measured, per-plugin, per-exact-version compatibility

Threadleaf does not claim broad plugin compatibility as a single number. Its
[compatibility contract](../compatibility/contract.md) defines five evidence levels, from
"discovered" to "workflow verified," and states plainly that "a plugin may pass one workflow and
fail another." The [generated compatibility registry](../compatibility/registry.md) is produced
from [`compatibility/plugin-evidence.v1.json`](../../compatibility/plugin-evidence.v1.json) by
`pnpm compatibility:generate`, and `pnpm compatibility:check` verifies it has not drifted from that
source. Today the registry lists two entries, each bound to an exact plugin version and an exact
Threadleaf version, each with a bundle SHA-256 digest and named test files per workflow: Excalidraw
2.25.3 at level 4, and Threadleaf's own compatibility fixture at level 4. The registry is
intentionally short right now; the discipline is that nothing enters it without a named, executable
workflow behind it; see the contract's evidence-sources section, which excludes "third-party
directories, feature tables, stars, and README claims" as compatibility evidence on their own.

### Reproducible builds

`pnpm run test:package-reproducible` builds the unpacked Linux application twice, in independent
temporary directories, and compares every file, symlink, mode, size, and SHA-256 hash between the
two builds, then produces two normalized `tar.xz` archives and requires those to be byte-identical
too (see [`docs/releases.md`](../releases.md), "Linux artifacts"). `pnpm run release:linux` runs
this as part of the clean-tree release path. This is stated honestly as a partial result:
[`docs/releases.md`](../releases.md) is explicit that it "proves reproducibility of the unpacked
application and normalized archive. It does not yet claim bit-for-bit reproducibility of the
AppImage or RPM containers," whose native packaging toolchains still need dedicated deterministic
build work.

### No account, no network requirement

Working fully offline is a core commitment for Threadleaf. The charter lists "no account or network
requirement" under "what better means" and "offline operation remains complete" as invariant 9 (see
[`docs/charter.md`](../charter.md)). The Settings "About and updates" page performs no startup or
background network check; checking, downloading, and installing an update are three separate,
explicit user actions, and unsigned or development builds never initialize the update provider at
all (see [`docs/releases.md`](../releases.md), "Manual signed updates"). The privacy-safe support
bundle described in [`docs/beta-feedback.md`](../beta-feedback.md) is saved locally, and "nothing is
uploaded."

### Three smaller things worth knowing about

- **An executable, implementation-neutral same-vault behavior corpus.** The fixture at
  [`fixtures/corpus/same-vault-v1/`](../../fixtures/corpus/same-vault-v1/) is a deterministic,
  license-clean vault plus a `cases.json` describing expected behavior for links, aliases, heading
  and block anchors, embeds, attachments, frontmatter, and rename rewrites. `pnpm run corpus:check`
  runs the supported cases against Threadleaf and compares full file bytes. It is designed so any
  Markdown application, not just Threadleaf, could be checked against the same corpus; see
  [`docs/compatibility/same-vault.md`](../compatibility/same-vault.md).
- **A machine-readable, drift-checked public compatibility spec.** `pnpm public-spec:build`
  generates versioned JSON datasets and a static offline site from repository evidence;
  `pnpm public-spec:check` verifies the generated output has not drifted from that evidence. See
  [`public-spec/README.md`](../../public-spec/README.md) and
  [`public-spec/SPECIFICATION.md`](../../public-spec/SPECIFICATION.md).
- **An executable deuteranomaly compatibility gate.**
  [`scripts/check-community-theme-matrix.mjs`](../../scripts/check-community-theme-matrix.mjs)
  simulates Machado 2009 deutan color vision at both 0.6 (moderate) and 0.8 (stress) severity and
  compares every measured color pair by CIEDE2000, sorting each into one of three tiers: failed
  below 7, a thin band from 7 up to 11 that only passes when the same case also carries an
  independently measured, actually painted redundant cue that itself clears 11, and a clear pass at
  11 or above. Four adversarial red controls, one per failure tier the gate can produce plus a
  check that an unpainted redundant cue cannot rescue a thin pair, prove the gate can actually
  fail. The offline check, `pnpm run community-theme:integrity`, runs inside `pnpm check` and
  inside all six CI and release jobs that build a package; the live capture, `pnpm run
  community-theme:check`, renders four real subjects under Xvfb, three permissively licensed
  community themes (Minimal, Wikipedia, Sanctum) plus Threadleaf's own default appearance, and
  compares the result against committed baselines. All four are fully live-verified with every
  measured color pair clearing the gate's clear tier, and reading-view body copy holds WCAG AA
  contrast across all four. Two findings that once sat under the gate's floor, on Threadleaf's own
  default styling rather than the third-party themes, are both closed. See
  [`docs/compatibility/community-themes-v1.md`](../compatibility/community-themes-v1.md).

## Where Obsidian is ahead today

### Plugin ecosystem breadth

Obsidian's community plugin ecosystem has been growing since 2020 and today covers thousands of
workflows: task managers, spaced repetition, citation tools, calendars, database-style views, and
more. Threadleaf's generated registry currently lists exactly two evidence-backed entries (see
[`docs/compatibility/registry.md`](../compatibility/registry.md)), by design: a plugin is added
only after a named workflow passes against a real fixture, not merely because it is discovered in a
vault. That discipline, not a lack of effort, is why the number is small today.

### Mobile

Obsidian ships official iOS and Android apps. Threadleaf has no mobile client. The project charter
lists "mobile clients" as an explicit initial non-goal, and the roadmap places mobile clients under
"Later phases," after desktop data safety and compatibility stabilize, using "a deliberately
capability-limited extension tier" (see [`docs/charter.md`](../charter.md) and
[`docs/roadmap.md`](../roadmap.md)).

### Years of product polish

Obsidian has been in continuous public development since 2020, with correspondingly deep UI and
workflow refinement. Threadleaf is an early-stage beta. Its own roadmap lists open work for tables,
math, diagrams, and large-document editing in Live Preview beyond current partial support, JSON
Canvas editing, high-contrast and localization support, and accessibility audits across every
reachable control (see [`docs/roadmap.md`](../roadmap.md), Phase 5). Its
[security policy](../../SECURITY.md) says it plainly: "Threadleaf is an early-stage beta. Keep an
ordinary external backup of any vault you use with it, and do not rely on it as your only copy of
important notes yet."

### A working hosted sync service

Obsidian Sync is a real, shipping, paid product that keeps a vault current across devices.
Threadleaf has not built a sync feature. The roadmap tracks it as a separate "Future lane: encrypted
sync service" with every item unchecked, and states plainly that "this lane does not gate the
desktop alpha. The local application must remain complete without an account or network connection"
(see [`docs/roadmap.md`](../roadmap.md)).

## Explicitly out of scope

Threadleaf's own charter lists what the project is deliberately not trying to do yet, under
"Initial non-goals" (see [`docs/charter.md`](../charter.md)):

- Supporting every published plugin.
- Reproducing another application's pixels.
- Mobile clients.
- Multiplayer collaboration.
- A privileged, proprietary sync service.
- Reimplementing every core feature before an alpha.
- Inventing a new note format.
- Requiring AI for ordinary knowledge work.

The compatibility evidence itself has a stated boundary too. Per the
[compatibility contract](../compatibility/contract.md), "proprietary application code, copied
assets, and decompiled bundled resources are out of scope" for how Threadleaf builds its
compatibility evidence. Only public API documentation and permissively licensed type definitions,
open file-format specifications, open-source plugin code, independently written fixtures, and
user-submitted failure reports that have been reduced to reproducible fixtures count as evidence.

## Checking this yourself

None of the Threadleaf-side claims above should be taken on the strength of this document. Clone
the repository, read the cited files, and run:

```sh
pnpm install
pnpm run corpus:check
pnpm run compatibility:check
pnpm run test:package-reproducible
pnpm public-spec:check
pnpm run community-theme:integrity
```

These are the same commands this document cites, not a separate marketing demo.

The repository also ships a small, original demo vault for exactly this kind of hands-on check;
open it with the same CLI cited throughout this document instead of taking any of its behavior on
faith:

```sh
pnpm run build:main && node dist/main/cli.cjs --vault fixtures/vaults/demo vault info
```
