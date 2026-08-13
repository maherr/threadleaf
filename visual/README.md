# Committed visual regression matrix

`visual/matrix.v1.json` is the versioned list of supported surfaces, synthetic fixture inputs,
themes, and viewport profiles. `visual/regions.v1.json` pairs every supported capture with visible
DOM selectors and small normalized screenshot regions. The harness rejects missing, blank, stale, or
dimensionally different captures before it computes region-level perceptual thresholds.

Run the integrity gate on every platform:

```sh
pnpm visual:integrity
```

On Linux with `xvfb-run` and the pinned Electron dependency, run the visual gate:

```sh
pnpm visual:check
```

The runner launches Electron in a fresh temporary profile and copied fixture, under an explicit X11
Xvfb display and unique CDP port. It proves renderer argv contains `--ozone-platform=x11` and does
not contain Wayland. If the rendering environment is absent it prints `VISUAL_SKIP` and still runs
the integrity checks; set `THREADLEAF_VISUAL_REQUIRED=1` in a rendering job to make that skip fail.

Baseline updates are intentional and local only:

```sh
pnpm visual:update
```

Review the changed PNGs and `visual/baselines/manifest.v1.json` together. The command refuses to
run in CI. A tampered known region is exercised with `pnpm visual:check -- --positive-control`; the
judge must reject it. `--red-control` runs the full visual path and exits non-zero when the expected
failure is observed, for use in targeted gate tests.

The matrix covers explicit high-contrast, reduced-motion, and reduced-transparency preferences.
The exact public Excalidraw workflow remains in its dedicated `pnpm test:excalidraw-roundtrip`
gate so this hermetic matrix never bundles or records a third-party plugin package or asset. The
local synthetic compatibility plugin settings page remains covered here.
