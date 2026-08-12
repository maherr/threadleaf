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

A manual production-path probe on 2026-08-12 pointed Threadleaf at a 54 GB mixed-content workspace
used as a vault root. No application window became ready within 60 seconds. The current startup path
recursively builds the complete in-memory vault index before creating the first window, so unrelated
files and deep trees block first paint.

This is an open performance defect, not a benchmark result and not a migration-preview failure. A
small copied vault containing the same `.obsidian` metadata and active notes rendered the preview
normally. The required fix is to decouple first window creation from complete indexing, publish
progress, prioritize visible Markdown, and move the remaining crawl behind a cancellable bounded
startup task. The public large-vault corpus and regression budget remain pending.
