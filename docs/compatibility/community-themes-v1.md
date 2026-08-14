# Community theme visual matrix v1

**Last updated:** 2026-08-14T11:33:08-04:00

This is a contained-loader compatibility fixture, not a theme store. The matrix uses three
permissively licensed, open community themes that exercise different CSS shapes, plus a fourth,
built-in subject: Threadleaf's own unthemed baseline with no community `theme.css` applied. The raw
CSS, manifests, and license notices are acquired only into a user cache outside the checkout. They
are not packaged, copied into `dist/`, or fetched by Threadleaf at runtime. The committed PNGs are
derived visual baselines, not third-party theme packages.

## Pinned provenance

`visual/community-themes.v1.json` is the machine-readable source of truth. Each receipt below is
the SHA-256 of the exact file fetched from the pinned commit URL.

| Theme | Release in manifest | Exact commit | License | Repository |
| --- | --- | --- | --- | --- |
| Minimal | 9.0.2 | [`dc4ebf2`](https://github.com/kepano/obsidian-minimal/commit/dc4ebf23b3183ff7aa661ea452d26f5bbe909b17) | MIT | [kepano/obsidian-minimal](https://github.com/kepano/obsidian-minimal) |
| Wikipedia | 2.0.4 | [`b3187a1`](https://github.com/Bluemoondragon07/Wikipedia-Theme/commit/b3187a105ebc4c28693777d228fd1707d3c01c06) | MIT | [Bluemoondragon07/Wikipedia-Theme](https://github.com/Bluemoondragon07/Wikipedia-Theme) |
| Sanctum | 1.2.0 | [`ac69e59`](https://github.com/jdanielmourao/obsidian-sanctum/commit/ac69e5992a66d2aeabb30d8c2d90c636d155fc25) | MIT | [jdanielmourao/obsidian-sanctum](https://github.com/jdanielmourao/obsidian-sanctum) |

| Theme | `theme.css` | `manifest.json` | License notice |
| --- | --- | --- | --- |
| Minimal | `4b7e6f55d017465f69ec2a145c11a171cd308e6b7c3a0fba65314f6e2f83fe7b` | `22ca939102aa2eae4ad57b4d77933572bc055d4fee096b9bc00fd8e890680536` | `5439c5837626f72e932960a7500064d0c27a290955c47ba73073f37dd09fd73d` |
| Wikipedia | `91258f1f23bc7d6fa9173d76d131a061e1c6ff05cd9cfd9c1b09110715ae4f2a` | `1e147c2099cc30e3bc294cd2063e85827593aecd257d53323e4262ed60485fd6` | `7ee45903067effb13f1b1d6ca4dbd4cf69e9ad84722e3654622238bf1335da11` |
| Sanctum | `368643f25c6700d4aaee2b5fbac1a5e1f88ed6dcf55ebe0104d3165bfad20cbc` | `a89eb62ea17aedc4453d537a5b9f856d6bec77246030b2d8fc0d9e11c4dcfb09` | `e47f41c970543cabb188965952eecb4050719352912c77131a0f9fd9d96f47e3` |

License notices remain in the cache even though the application never redistributes these raw
files. A future redistribution feature would need its own license review and notice placement.

**The fourth subject, `default`, has no download and no receipts.** It is declared in
`community-themes.v1.json` with `"builtin": true` and every acquisition field (`folder`, `release`,
`repository`, `commit`, `commitUrl`, `license`, `licenseUrl`) explicitly `null`, plus an empty
`files` array, checked structurally so a merely-omitted field can never silently pass as an
intentional built-in declaration. It applies no `theme.css`; the live runner instead asserts that
no community theme ended up selected for that subject's vault before capturing.

## Acquisition and proof

Acquisition is an explicit, networked developer action:

```sh
pnpm run community-theme:acquire
```

The default cache is `~/.cache/threadleaf/community-themes-v1`; set
`THREADLEAF_COMMUNITY_THEME_CACHE` to another directory outside the checkout when needed. The
acquirer follows only the raw URLs in the manifest, verifies every receipt, and atomically writes
the bounded files. Running the visual command without a complete cache prints
`COMMUNITY_THEME_VISUAL_SKIP`; `THREADLEAF_VISUAL_REQUIRED=1` turns that condition into a failure.
The `default` subject needs no acquired files and is never blocked by an incomplete cache.

The deterministic runner is:

```sh
pnpm run community-theme:check
```

It builds Threadleaf, copies the existing visual fixture into a temporary vault, copies only the
cached `theme.css` and `manifest.json` into that vault's `.obsidian/themes/<folder>` (skipped
entirely for the built-in `default` subject), and selects the theme through the existing Appearance
settings control. The contained appearance loader is therefore exercised through the same bridge
and CSS style element used by the application. The runner launches Electron under Xvfb with
explicit X11, records the renderer command line, and captures only the bounded viewport surface.

For each subject it declares five cases: dark laptop, light laptop, light minimum viewport, dark
high contrast, and light high contrast. The live probe also audits accessible names, `aria-current`
and glyph cues, painted-ancestor alpha compositing, non-color focus cues, pairwise CIEDE2000
separation under Machado deuteranomaly severities 0.6 and 0.8 (see
[Deuteranomaly gate tiers](#deuteranomaly-gate-tiers) below), explicit scrollbar geometry, zero
HTTP(S) renderer requests, and the exact hash of the served freshly built renderer bundle.
Baselines live under `visual/community-baselines/` and are checked against the fixture tree,
pinned renderer/environment, exact source receipts, dimensions, hashes, and bounded pixel drift.

## Deuteranomaly gate tiers

The live probe's colour checks follow the workspace's accessibility standard (root `CLAUDE.md`,
deuteranomaly section): simulate Machado 2009 deutan at both 0.6 (moderate) and 0.8 (stress)
severity, compute CIEDE2000 between the measured pair under each severity, and take the minimum
across severities. That distance sorts into exactly one of three tiers:

| CIEDE2000 | Tier | Outcome |
| --- | --- | --- |
| < 7 | Failed | The case fails outright. |
| 7 to < 11 | Thin | Neither a pass nor a fail by itself. |
| >= 11 | Clear | The case passes outright. |

Categorical roles, the workspace's "strong ink" signals (currently section heading and toast
accent), keep the plain minimum-7 pass/fail bar: a Failed measurement fails the case, anything
else passes. Thin-state roles, the "pale tint" signals (currently `active-file-background` vs
`inactive-file-background`), get the full three tiers, matching root `CLAUDE.md`'s own distinction
that pale tints need more headroom than strong inks. Roles that are already typographically
distinct from every other measured role by size, weight, or position (a file row's active-state
border, a small muted caption against a large heading) are not paired against each other here:
their real distinguishing signal is not colour, and colour-only comparison between them was never
a meaningful accessibility requirement.

A Thin thin-state measurement passes **only** when the same live case also carries an
independently-measured **redundant cue**: a second, structurally-declared colour pair that itself
clears 11. A thin measurement with no declared redundant cue, or whose redundant cue also falls
short of 11, fails closed; this is not a threshold weakening, it is calibration to a real,
documented distinct state the doctrine already names. The redundant-cue mapping is keyed by pair
label, not by theme, and applies identically to every theme that happens to measure inside the
thin band; there are no per-theme exemptions. Every thin-tier pass is written to stdout as
`COMMUNITY_THEME_THIN_PASS <theme> <case> pair=<pair> dE=<value> redundantCue=<pair>
redundantDe=<value>` and folded into that case's `deutan` audit JSON in the run receipt. As of the
current baselines, every case in the matrix clears the tier outright (>= 11) on its primary
measurement; the redundant-cue rescue path remains fully implemented and covered by its own static
positive/red controls, but has no live thin-pass currently on record.

**The declared redundant cue.** For `active-file-background`/`inactive-file-background`, the
redundant cue is the active row's own border colour against its own background
(`active-file-border`/`active-file-background`), the row's real accent-mixed distinguishing
signal. A border still computes a colour under `border-style: none` or a zero width even though
nothing is actually painted, so a cue that carries border geometry is rejected unless
`borderStyle !== "none"` and `borderWidth > 0`: an invisible border can never rescue a thin pair.

## Resolved findings

Two product findings were recorded against the light scheme in this matrix's first landed pass.
Both are now fixed and re-verified live; the original findings are kept below, unedited, as the
record of what was actually wrong, followed by how each was resolved.

### Resolved: light-scheme `--accent-soft` contrast, formerly below the hard floor

**Original finding.** Wikipedia's `light-laptop` case measured CIEDE2000 6.65 for
`active-file-background` vs `inactive-file-background`, under the 7 hard-fail floor, so no
redundant cue could rescue it. Wikipedia's `theme.css` sets neither `--interactive-accent` nor
`--background-primary`, so this was not a Wikipedia-specific quirk: it was Threadleaf's own
default, unthemed light-scheme `--accent-soft` contrast failing the workspace's own standard.
Reproduced identically (same measured colours, same CIEDE2000) across two independent live runs.

**Root cause.** `--accent-soft: color-mix(in srgb, var(--interactive-accent) 14%, var(--background-primary))`
mixed only 14% of the accent into the background, too faint to separate from `--surface-sunken`
under deuteranomaly simulation.

**Fix.** Widened the mix to 25% (`src/renderer/styles.css`). This is primarily a lightness
separation, not a chroma boost: light-scheme `--accent-soft`'s L* drops from 89.06 to 82.16 while
chroma rises only modestly (C* 3.96 to 8.46), matching the workspace's stated preference for
lightness over chroma separation under deuteranomaly. Verified against the matrix's own
CIEDE2000/Machado implementation before capture, then confirmed live: Threadleaf's own light scheme
now measures 12.38 (clears the >= 11 pass tier outright, was 6.65), dark scheme rises from 8.73 to
14.55 (no regression; the floor explicitly required staying at or above 8.73).

### Resolved: Sanctum's `--interactive` collapse, and the deeper mechanism behind it

**Original finding.** Sanctum's `light-laptop` case failed independently of the Wikipedia finding
above, on a different pair and a different root cause: `section-heading` vs `signal-accent`
measured CIEDE2000 0.00, both colours reading as `[0,0,0]`. Sanctum's `theme.css` sets
`--color-accent: var(--interactive)`, and `--interactive` was not a variable Threadleaf's
compatibility layer published, so it never resolved; every colour derived from it collapsed to
black in Threadleaf's light cascade.

**Root cause, found through live investigation (Electron + CDP), not source reasoning alone.** Two
distinct issues, not one:

1. `--interactive` itself was simply never published by Threadleaf's baseline. Sanctum's own
   `--color-accent: var(--interactive)` chain had nothing to read.
2. A deeper, unrelated mechanism was independently poisoning `--ink`, `--signal`, `--canvas`,
   `--surface*`, `--line*`, and `--mono` for every descendant of `<body>` -- which is what
   `section-heading`'s colour (via `--ink`, inherited from `body { color: var(--ink) }`) and
   `signal-accent`'s border (via `--signal`) actually depend on, not `--interactive` directly.
   Threadleaf toggles `theme-light`/`theme-dark` classes onto `:root` as well as `body` (matching
   its own baseline pattern), but a community theme's own supporting design-token constants are
   conventionally scoped to `body` only, matching real Obsidian, where `:root` never carries
   meaningful theme state. Sanctum's own `--background-primary`/`--text-normal`/`--text-error`
   overrides therefore resolve validly at `body` but invalidly at `:root` (confirmed live: Sanctum's
   base palette constants, e.g. `--gray-10`, are declared via a bare `body { }` selector that never
   reaches `:root`). Because Threadleaf's own semantic aliases were declared only once, at `:root`,
   with no re-declaration anywhere else, that invalid `:root` value silently inherited down through
   the entire document -- poisoning a perfectly healthy `body`. Confirmed live: `--ink`, `--signal`,
   and `--accent-soft` read as completely *absent* (not merely wrong) at every element under body,
   even though body's own `--background-primary`/`--text-normal` were already correct.

**Fix.** Two changes in `src/renderer/styles.css`:

1. Map `--interactive` honestly to the same real accent Threadleaf already uses everywhere else.
   At `:root` that is `--interactive: var(--interactive-accent)`; the body-level re-declaration
   (item 2 below) instead reads `var(--accent)`, for the reason given under
   [Body-level compat re-anchoring](#body-level-compat-re-anchoring-and-its-two-exclusions).
2. Add a `body { }` token block re-declaring `--icon-color`, `--canvas`, `--surface*`, `--ink*`,
   `--line*`, `--accent-soft`, `--interactive`, `--signal*`, and `--mono` with the identical
   formulas already used at `:root`, so each is re-evaluated at `body` -- where a theme's own
   tokens reliably reach -- instead of staying inherited-only from a root scope no community theme
   was ever written to support.

**Two further regressions surfaced during live verification of that fix, and how they were
resolved** (see [Body-level compat re-anchoring](#body-level-compat-re-anchoring-and-its-two-exclusions)
below for the full mechanism):

- Re-declaring `--accent`/`--accent-strong`/`--accent-soft` at `body` let Minimal's own
  low-chroma accent silently beat the accessibility "Accent" preference's `!important` pin (which
  can only ever match `:root`, never `body`), regressing Minimal's own dark-laptop redundant cue
  from 15.04 to 5.35 and its light-laptop primary from 7.02 to *6.27* (below the hard floor).
  `--accent`/`--accent-strong` were removed from the `body { }` block entirely; `--accent-soft`
  (which still needs `--background-primary` to be theme-aware) now reads `var(--accent)` instead
  of `var(--interactive-accent)` for its accent half, so it stays pinned like `--accent` itself.
- The same `body { }` block unconditionally defeated the accessibility "High contrast"
  preference's own `!important`, `:root`-only override for the same reason, failing Wikipedia's
  dark-high-contrast case (6.28, previously never part of any recorded finding since Wikipedia's
  live status was fully pending). The whole block is now gated on
  `html:not([data-threadleaf-high-contrast="true"]) body { }` so it stands down whenever high
  contrast is active.

**Verified live, post-fix.** The originally-recorded 0.00 case now measures real Sanctum colours
(`rgb(22,22,22)` vs `rgb(197,65,40)`) at dE=39.26. Sanctum's thin-state active/inactive pair --
also silently broken by the same html-vs-body mechanism via `--accent-soft`, though never
previously called out as its own finding -- now measures dE=12.96, clearing >= 11 outright. See
[Live verification status](#live-verification-status) for the full, current receipt table across
all four subjects.

## Body-level compat re-anchoring, and its two exclusions

`src/renderer/styles.css` now has three token/variable blocks instead of two: the light `:root { }`
baseline, its `:root[data-theme="dark"] { }` override, and a third,
`html:not([data-threadleaf-high-contrast="true"]) body { }` block that re-declares a subset of
Threadleaf's own semantic aliases so they resolve using `body`'s cascade -- where a community
theme's supporting tokens conventionally reach -- rather than staying inherited-only from `:root`,
where they may not (see the Sanctum finding above).

Two families of Threadleaf token are deliberately **excluded** from that re-declaration, because
each is independently pinned by an accessibility preference using `!important` on a `:root[data-threadleaf-*]`
selector, which can only ever match `:root`, never `body` -- so re-declaring the same name directly
on `body` (even without `!important`) always wins there regardless of what `:root` says, since a
direct declaration on an element always beats whatever it would otherwise have inherited from a
parent, `!important` or not:

- **`--accent`, `--accent-strong`** (and `--accent-soft`'s own accent half, which reads
  `var(--accent)` rather than `var(--interactive-accent)` at both `:root` and `body` for exactly
  this reason; the `body`-level `--interactive` does too, though `:root`'s own `--interactive`
  stays `var(--interactive-accent)`, unchanged): the accessibility "Accent" preference pins these
  with `!important` on `:root[data-threadleaf-accessibility="true"]`.
  A theme that sets `--interactive-accent` directly on `body.theme-light`/`body.theme-dark`
  (Minimal does; Sanctum and Wikipedia do not) would otherwise silently override the user's chosen
  accessibility accent the moment these are re-evaluated at `body`.
- **`--canvas`, `--surface`, `--surface-raised`, `--surface-sunken`, `--ink`, `--ink-soft`,
  `--ink-muted`, `--line`, `--line-strong`, `--signal`, `--signal-soft`**: the accessibility "High
  contrast" preference pins this same set with `!important` on
  `:root[data-threadleaf-high-contrast="true"]`, using literal, theme-independent colours. These
  values never depend on any theme's variables, so they carry no poisoning risk to begin with --
  the entire `body { }` block is gated to stand down whenever high contrast is active, letting
  `:root`'s values inherit through exactly as they did before this fix existed.

`--icon-color`, `--interactive`, `--mono`, and `--accent-soft` are not part of the high-contrast
override and remain re-declared at `body` unconditionally (subject only to the high-contrast gate
on the whole block, for consistency).

**Remaining, lower-severity gap, not fixed here.** `--font-interface`, `--font-monospace`,
`--file-margins`, `--radius-s`, `--radius-m`, and `--radius-l` are the same shape of `:root`-only
alias and share the same theoretical html-vs-body exposure, but none is colour-bearing (an invalid
fallback degrades to a browser default border-radius or font stack, not black text) and none is
part of any measured pair in this matrix. Left unfixed pending a theme that actually demonstrates
the gap.

## Live verification status

`visual/community-baselines/manifest.v1.json` carries an explicit `liveVerification` status per
theme, structurally validated (a missing or malformed declaration fails loudly, never silently
defaults). The live runner reads it before attempting a capture: a `verified` theme runs the full
live capture and compare; a `pending` theme is skipped outright, with its declared reason printed
as `COMMUNITY_THEME_LIVE_PENDING <theme>: <reason>` rather than being attempted and left to fail.
Every run ends with either `COMMUNITY_THEME_LIVE_COMPLETE verified=<themes>` or, whenever any theme
is pending, `COMMUNITY_THEME_LIVE_INCOMPLETE verified=<themes> pending=<themes>` on **exit code
2**, kept distinct from exit code 1 (an actual thrown failure) so a known, tracked gap can never
read as either a clean pass or an unexplained crash. `--integrity-only` reports the same verified
and pending lists on `COMMUNITY_THEME_LIVE_STATUS` without affecting its own exit code, since
structural validity does not depend on live-capture status.

| Theme | Status | Detail |
| --- | --- | --- |
| Minimal | **Verified** | All five cases pass against current main. |
| Wikipedia | **Verified** | All five cases pass against current main, including `light-laptop` (formerly the recorded below-floor finding) and `light-high-contrast` (formerly pending-dynamic-renderer-proof with no live capture at all). |
| Sanctum | **Verified** | All five cases pass against current main, including `light-laptop` (formerly the recorded 0.00 categorical collapse) and `light-high-contrast` (formerly pending-dynamic-renderer-proof). |
| default | **Verified** | New first-class subject: Threadleaf's own unthemed baseline, no community `theme.css` applied. All five cases pass against current main. |

All four subjects, full receipt (`dE` is the minimum CIEDE2000 across both Machado severities;
every case clears the >= 11 pass tier outright, so no redundant-cue rescue is currently live):

```
theme      case                  categorical  thinState
minimal    dark-laptop                 29.55      14.07
minimal    light-laptop                40.38      12.46
minimal    light-minimum               40.38      12.46
minimal    dark-high-contrast          27.25      14.24
minimal    light-high-contrast         28.12      12.46
wikipedia  dark-laptop                 29.76      12.90
wikipedia  light-laptop                40.86      12.38
wikipedia  light-minimum               40.86      12.38
wikipedia  dark-high-contrast          27.25      14.24
wikipedia  light-high-contrast         28.12      12.46
sanctum    dark-laptop                 40.49      14.97
sanctum    light-laptop                39.26      12.96
sanctum    light-minimum               39.26      12.96
sanctum    dark-high-contrast          27.25      14.24
sanctum    light-high-contrast         28.12      12.46
default    dark-laptop                 29.76      14.55
default    light-laptop                40.86      12.38
default    light-minimum               40.86      12.38
default    dark-high-contrast          27.25      14.24
default    light-high-contrast         28.12      12.46
```

Every subject measures identical `dark-high-contrast`/`light-high-contrast` figures, confirming the
accessibility high-contrast override is genuinely theme-independent now that the `body { }` compat
layer correctly stands down for it (see
[Body-level compat re-anchoring](#body-level-compat-re-anchoring-and-its-two-exclusions) above).
`wikipedia`/`default` pairing up exactly on non-high-contrast light figures (40.86/12.38 for both)
is coincidental convergence of this run's specific colours, not a structural guarantee -- minimal
(40.38/12.46) and sanctum (39.26/12.96) each measure their own distinct figures instead, and
dark-laptop's `thinState` genuinely differs per subject (12.90 to 14.97), reflecting each theme's
own `--surface-sunken` now correctly flowing through where it did not before this lane.

Stability evidence: `community-theme:update` (writes fresh baselines; the figures above), then a
real, non-update `community-theme:check` comparing an independent fresh capture against those
committed baselines through the actual perceptual-diff gate. Both runs passed identically.

## Deliberate limits

- This is measured coverage of the existing Threadleaf fixture, not a claim that every Obsidian
  selector, plugin surface, Canvas, graph, pop-out, or mobile surface is compatible.
- High DPI and zoom remain covered by the core synthetic matrix; they are not silently implied by
  this community set.
- `aaaaalexis/obsidian-baseline` at commit
  `7ad4e9f5dbdb5048ef73344fb1002bdb88bb680a` and `Akifyss/obsidian-border` at commit
  `6b48b45c153fda6e7468a62779b83de25753d522` were explored but not admitted to v1. Their exact
  CSS contains percent-encoded fragment URLs inside data SVGs that the current contained loader
  rejects. No visual pass is claimed for either theme. This is an explicit compatibility boundary,
  not a silent skip.
- The cache is a developer receipt and test input. It is not application state, an installer
  source, or a runtime theme registry.
- The `--font-interface`/`--font-monospace`/`--file-margins`/`--radius-*` gap noted above is a
  known, tracked, non-colour-bearing limitation, not a silent one.
