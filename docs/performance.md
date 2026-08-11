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
