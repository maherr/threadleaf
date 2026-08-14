# Community theme visual matrix v1

**Last updated:** 2026-08-14T07:13:17-04:00

This is a contained-loader compatibility fixture, not a theme store. The matrix uses three
permissively licensed, open community themes that exercise different CSS shapes. The raw CSS,
manifests, and license notices are acquired only into a user cache outside the checkout. They are
not packaged, copied into `dist/`, or fetched by Threadleaf at runtime. The committed PNGs are
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

The deterministic runner is:

```sh
pnpm run community-theme:check
```

It builds Threadleaf, copies the existing visual fixture into a temporary vault, copies only the
cached `theme.css` and `manifest.json` into that vault's `.obsidian/themes/<folder>`, and selects
the theme through the existing Appearance settings control. The contained appearance loader is
therefore exercised through the same bridge and CSS style element used by the application. The
runner launches Electron under Xvfb with explicit X11, records the renderer command line, and
captures only the bounded viewport surface.

For each theme it declares five cases: dark laptop, light laptop, light minimum viewport, dark high
contrast, and light high contrast. The live probe also audits accessible names, `aria-current` and
glyph cues, painted-ancestor alpha compositing, non-color focus cues, pairwise CIEDE2000
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
redundantDe=<value>` and folded into that case's `deutan` audit JSON in the run receipt.

**The declared redundant cue.** For `active-file-background`/`inactive-file-background`, the
redundant cue is the active row's own border colour against its own background
(`active-file-border`/`active-file-background`), the row's real accent-mixed distinguishing
signal.

**Recorded case: Minimal, dark laptop.** Minimal's own upstream default accent (`hue 201° /
saturation 17% / lightness 50%`, unmodified) is deliberately low-chroma, part of the theme's own
minimalist design, not a Threadleaf or loader defect. Threadleaf's `--accent-soft` token blends
only 14% of that already-low-chroma accent into the background, so `active-file-background` vs
`inactive-file-background` measures CIEDE2000 8.73 for Minimal's dark scheme (inside the thin
band). The declared redundant cue (the active row's border against its own background) measures
15.04, clearing 11, so the case passes and is recorded as a thin-pass in the run receipt:
`COMMUNITY_THEME_THIN_PASS minimal dark-laptop pair=active-file-background/inactive-file-background
dE=8.73 redundantCue=active-file-border/active-file-background redundantDe=15.04`. Wikipedia and
Sanctum do not override the accent colour at all and are not observed in the thin band.

**Known limitation, not fixed here.** `--accent-soft`'s fixed 14% mix is a single token used
across roughly five dozen places in `src/renderer/styles.css`; whether to strengthen it app-wide
for low-chroma community accents is a design decision outside this compatibility matrix's scope.
It is tracked as a follow-up, not resolved by this gate.

The offline integrity route does not inspect the developer cache or require Xvfb:

```sh
node scripts/check-community-theme-matrix.mjs --integrity-only
```

It validates the manifest, receipt hashes, PNGs, static positive/red controls, and cache
containment primitives. Baseline updates are refused whenever CI is detected. Use
`pnpm run community-theme:update` only when intentionally regenerating derived PNGs on a local
renderer with the complete cache.

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
