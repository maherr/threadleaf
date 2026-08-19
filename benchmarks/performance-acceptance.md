# Performance acceptance harness

## Scope and safety

This harness measures a synthetic filesystem corpus only. It never opens, reads, or mutates the
daily-driver vault. The generated corpus lives under the ignored `.bench-corpus/` directory; only
the generator, the checked-in summary manifest, and machine-written result JSON belong in Git.

`pnpm benchmark:performance-acceptance` first requires `MemAvailable >= 8,388,608 KiB`, then holds
the foreground primary-heavy gate at `/tmp/threadleaf-heavy-gate.lock` for up to six hours. Inside
that lock, each measured leg has an independent hard timeout of at most 25 minutes (20 minutes by
default). The result is
written atomically even when a leg aborts. A nonzero command exit after a written result means that
at least one required leg aborted; it does not discard partial samples.

The runner never overlaps legs. It generates or verifies the corpus, measures a cold Electron
workspace open and a second restart against the same persisted profile, then runs one fresh kernel
process for cold startup plus sequential 100-file touch, add, and delete mutations. Each Electron
observer runs in its own detached process group
and atomically rewrites the schema-valid result after every surface observation, search probe, and
RSS sample. The runner writes an initial aborted record before launching that observer, so an
Electron coredump or runner death still leaves the last honest checkpoint on disk. Each mutation
is index-observed and reversed before the next one, leaving the corpus's bytes as it found them.
The warm-persisted-index leg is a real second process opening the cold launch's on-disk derived
index cache. It is required: if the cold launch or restart aborts, the suite aborts.

## Deterministic full corpus

The full profile uses generator version `1.0.0` and seed `0x54485244` (`1414025796`). It contains
exactly **207,726 files**, matching the observed real-vault file count while deliberately keeping
the content synthetic.

| Shape | Deterministic choice |
| --- | --- |
| Markdown notes | 21,145 notes, with frontmatter, aliases, tags, headings, links, unresolved links, and a stable link fan-out. |
| Path depth | Repeating eight-way layered branches plus a shard directory; the full profile records the exact min/p50/p90/max depth in its manifest. |
| Note sizes | 11,200 notes at 10 KiB, 7,900 at 37 KiB, 1,834 at 153 KiB, a 210-note ramp from 170 KiB to 1.2 MiB, and one 1.2 MiB maximum note. |
| Non-note files | 186,581 visible extension-distributed ballast files: JavaScript, TypeScript, source maps, JSON, extensionless files, MDX, MJS, PNG, CSS, SVG, Canvas, HTML, and binary. |
| Hidden files | 1,024 `.hidden-cache/` files, so visible-file policy is measured separately from raw file count. |
| Attachments/canvases | 4,300 PNG-like attachments, 900 SVG files, 900 `.canvas` files, and 481 binary files. |
| Mutations | 100 fixed Markdown paths, starting at synthetic note 32. The kernel separately touches, adds, and deletes 100 notes, index-observes each delta, then reverses it. |

`benchmarks/vault-scale-manifest.json` carries the checked-in distribution summary. The generated
manifest now includes both a deterministic summary `manifestHash` and an independently sampled
content `sampleHash`; the acceptance result copies both values. Regeneration with this seed must
produce the same values and fails before any timing is accepted if its corpus shape differs.

## Legs and recorded evidence

| Leg | Instrument | Result evidence |
| --- | --- | --- |
| Cold start | New Node process, empty private state root | Kernel-open, bootstrap scan, metadata-index, projection, and ready timings; Node RSS and event-loop heartbeat. |
| Warm persisted index | Second Electron process, same private profile and on-disk derived index | Shell, ready, search-probe, and RSS evidence from the real restart. |
| Incremental N=100 | Cold kernel's watcher/index after restore-safe external edits | Separate touch, add, and delete convergence counts, generation numbers, and timings for 100 files per mutation kind. |
| Usable shell | Electron process start to renderer `threadleaf:shell-ready` mark | Shell timing, surface state, and the Electron process RSS samples. |
| Background completion | Usable shell to the matching ready snapshot | Ready timing, exact Markdown count, last surface, and an abort record if the timeout wins. |
| Memory | `/proc` Electron browser/renderer VmRSS plus Node process RSS | Full sampled Electron RSS series and kernel peak/settled RSS. |
| Responsiveness | Renderer search invocation at three scheduled points while background work is ongoing; kernel 5 ms heartbeat | Per-probe latency/outcome and per-stage Node blocking pauses. |

The Electron leg uses the existing product Electron/Xvfb mechanics: isolated X11 display, a
dedicated temporary profile shared only by the cold/warm pair, remote-debugging observation, GPU disabled, and explicit process
reaping. The isolated observer closes the renderer window through CDP so Electron runs the app's
`window-all-closed` and `before-quit` persistence lifecycle; only a
nonresponsive observer falls back to a process-group kill. The temporary profile is deleted only
after both Electron legs finish; the deterministic kernel records the lower-level startup mechanics.

`--variant smoke` creates a deterministic 1,536-file synthetic corpus for lifecycle validation.
`--force-electron-timeout` deliberately keeps its Electron observer open until the configured
timeout even if the workspace becomes ready. It exists only to prove that an abort checkpoint
lands and that the following kernel leg still runs; it is not a performance measurement mode.

## Acceptance budgets, proposal only

These are **PROPOSED**, not current product assertions. They need orchestrator and Maher
ratification before becoming a CI gate. The reference observation is Obsidian 1.13.7 opening the
real vault in 14,081 ms: 11,966 ms of vault reading/metadata and 193 ms in four community plugins.
That one observation provides no warm-start, RSS, query-latency, or shell/background split, so
those rows are deliberately explicit policy proposals rather than claimed comparisons.

| Required measure | Obsidian reference | PROPOSED Threadleaf acceptance budget | Basis / status |
| --- | ---: | ---: | --- |
| Cold kernel readiness | 14,081 ms total open | p90 <= 14,081 ms | Direct whole-open comparator. **PROPOSED.** |
| Cold metadata build | 11,966 ms reading + metadata | p90 <= 11,966 ms | Closest comparable component. **PROPOSED.** |
| Time to usable shell | No split measurement | p90 <= 5,000 ms | Product responsiveness target. **PROPOSED.** |
| Background completion | 14,081 ms total open | p90 <= 14,081 ms | Whole-open comparator. **PROPOSED.** |
| Warm persisted-index start | Not measured | p90 <= 5,000 ms | Product target measured by the required restart leg. **PROPOSED.** |
| Incremental 100-file convergence, each mutation kind | Not measured | p90 <= 2,000 ms | Interaction safety target for each touch/add/delete run. **PROPOSED.** |
| Peak RSS | Not measured | <= 4 GiB kernel, <= 4 GiB Electron main | Host-capacity guard, not an Obsidian comparison. **PROPOSED.** |
| Background search probe | Not measured | each <= 250 ms | Responsiveness target, not a reference comparison. **PROPOSED.** |

An abort never becomes a pass by comparison omission. It remains an abort in the result and makes
the acceptance command exit nonzero after the JSON is deposited.
