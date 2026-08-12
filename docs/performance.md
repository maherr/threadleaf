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
| Rebuild all derived search state | about 154 ms |
| Find the unique term in the final note | about 0.76 ms |
| Rank all common matches and return the first 50 | about 19 ms |

The interpretation is deliberately narrow: a simple in-memory index is already interactive for
this synthetic 10,000-note workload. Threadleaf should adopt a more complex inverted index or
SQLite FTS layer only when representative vault fixtures or regression budgets demonstrate a real
need. Any replacement remains disposable and exactly rebuildable from canonical vault files.

Phase 3 expands this microbenchmark into public filesystem-backed corpora covering cold startup,
index rebuilds, watcher bursts, attachments, memory pressure, plugin activation, and representative
query distributions across supported desktop platforms.

## Large mixed-workspace cold-start observation

The original production-path probe on 2026-08-12 pointed Threadleaf at a 54 GB mixed-content
workspace used as a vault root. No application window became ready within 60 seconds because the
complete watcher snapshot and metadata index both ran before window creation.

Threadleaf now renders a plugin-free bootstrap workspace before opening the configured or restored
vault in the background. The same host and workspace reached a rendered, interactive opening state
in 3.99 to 4.11 seconds across two passing runs. A stricter 3,000 ms run failed before the renderer
target appeared, so 3 seconds is not a supported budget. The opening surface names the target,
shows index progress, disables writes and search against the bootstrap vault, and leaves Open vault
available to supersede a slow or wrong target.

Run the isolated production check with any representative vault:

```sh
THREADLEAF_STARTUP_PROBE_VAULT=/absolute/path/to/vault \
  THREADLEAF_STARTUP_BUDGET_MS=5000 \
  pnpm test:startup-readiness
```

Set `THREADLEAF_STARTUP_SCREENSHOT_DIR` to retain dark and light captures. The current result proves
bounded first-window readiness only. Full target activation still performs two corpus passes and
needs cancellation, progress counts, visible-note prioritization, traversal exclusions, and a
public cross-platform regression corpus before it can claim a complete large-vault budget.
