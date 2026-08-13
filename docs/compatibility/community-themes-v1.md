# Community theme visual matrix v1

**Last updated:** 2026-08-13T04:07:33-04:00

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

For each theme it proves four cases: dark laptop, light laptop, light minimum viewport, and dark
high contrast. It also proves the file-navigation `aria-current` and glyph cues, a non-color focus
outline, direct CSS validation, zero HTTP(S) renderer requests, and two Machado deuteranomaly
transforms (moderate and stress) against the app-owned focus cue. Baselines live under
`visual/community-baselines/` and are checked with dimensions, hashes, and bounded pixel drift.
Use `pnpm run community-theme:update` only when intentionally regenerating those derived PNGs.

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
