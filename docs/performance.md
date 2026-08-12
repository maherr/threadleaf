# Performance baselines

Threadleaf treats performance as a reproducible contract, not a claim about proprietary magic.
These measurements guide implementation choices but are not release budgets yet. They vary by CPU,
runtime version, file sizes, and corpus shape, so the normal correctness gate does not fail on a
machine-dependent time threshold.

## Full-text search

Run:

```sh
pnpm benchmark:search
```

The benchmark generates the same 10,000-note corpus in memory on every run. The final note contains
a unique term; all notes contain a common two-term phrase. The current normalized-scan
implementation produced these means on the Linux development host on 2026-08-11:

| Operation | Mean |
| --- | ---: |
| Rebuild all derived search state | about 29 ms |
| Find the unique term in the final note | about 0.68 ms |
| Rank all common matches and return the first 50 | about 29 ms |

The interpretation is deliberately narrow: a simple in-memory index is already interactive for
this synthetic 10,000-note workload. Threadleaf should adopt a more complex inverted index or
SQLite FTS layer only when representative vault fixtures or regression budgets demonstrate a real
need. Any replacement remains disposable and exactly rebuildable from canonical vault files.

Phase 3 expands this microbenchmark into public filesystem-backed corpora covering cold startup,
index rebuilds, watcher bursts, attachments, memory pressure, plugin activation, and representative
query distributions across supported desktop platforms.

## Large mixed-workspace cold-start observation

The original production-path probe on 2026-08-12 pointed Threadleaf at a 54 GB mixed-content
workspace used as a vault root. Its visible Markdown corpus was 20,621 files and about 363.1 MB. No
application window became ready within 60 seconds because the complete watcher snapshot and
metadata index both ran before window creation. A direct profile of the old double-read activation
path took about 85.1 seconds.

Threadleaf now renders a plugin-free bootstrap workspace before opening the configured or restored
vault in the background. Initial activation reads every visible Markdown file once, seeds watcher
state and the metadata index from the same stable byte snapshots, reuses generation-bound snapshot
projections, and virtualizes the file navigator. On the same host and workspace, the final passing
production probe reached the interactive opening surface in 3.98 seconds, all 20,621 notes were
ready in 33.61 seconds, and Electron then exited cleanly. The measured full activation is about 2.5
times faster than the original direct profile. A stricter 3,000 ms first-window run failed before
the renderer target appeared, so 3 seconds is not a supported budget. The opening surface names the
target, shows index progress, disables writes and search against the bootstrap vault, and leaves
Open vault available to supersede a slow or wrong target.

Run the isolated production check with any representative vault:

```sh
THREADLEAF_STARTUP_PROBE_VAULT=/absolute/path/to/vault \
  THREADLEAF_STARTUP_BUDGET_MS=5000 \
  THREADLEAF_STARTUP_READY_BUDGET_MS=60000 \
  pnpm test:startup-readiness
```

Set `THREADLEAF_STARTUP_SCREENSHOT_DIR` to retain dark and light captures. The two budgets separately
gate first-window and full-target readiness, and the probe also requires a clean application exit.
Peak main-process resident memory remained about 2.6 GB during the traced large-workspace run.
Progress counts, visible-note prioritization, lower memory use, cancellation, and public
cross-platform regression corpora remain required before this observation becomes a release budget.

## Representative copied-vault desktop trial

The broader production-path trial on 2026-08-12 copied a private working vault into mode-0700
temporary storage and exercised only the copy. The source held 20,623 visible Markdown notes,
363,118,069 note bytes, a 1,181,533-byte largest note, and four sampled raster attachments totaling
26,747,878 bytes. The harness does not print source note names, content, paths, or hashes.

| Operation | Observed time |
| --- | ---: |
| Render interactive opening workspace | 4.37 s |
| Complete initial index and reach ready | 32.05 s |
| Open the largest copied note | 343 ms |
| Edit and save that note | 1.34 s |
| Render sampled PNG, JPEG, GIF, and WebP wiki embeds | 599 ms |
| Converge after an external atomic replacement | 2.59 s |
| Converge after 200 creates, 100 updates, 50 renames, and 50 deletes | 9.87 s |
| Preview and commit a link-updating note rename | 6.30 s |
| Restart, reindex, and restore the active tab | 30.12 s |

The final copied vault contained the exact expected 20,777 notes. The watcher remained healthy,
the restored tab was correct, the source corpus and sampled source attachments retained their exact
pre-trial hashes, and Electron exited cleanly. The move planner completed without the earlier
multi-index memory exhaustion by reusing the current metadata snapshot and reading full bytes only
for affected notes. These are one-host observations, not release budgets.

Run the same aggregate-only gate with:

```sh
pnpm run test:representative-vault -- --source /absolute/path/to/vault
```
