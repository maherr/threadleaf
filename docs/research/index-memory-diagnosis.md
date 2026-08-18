# Index memory diagnosis: why a 21,145 note vault exhausts the V8 heap

Observed on 2026-08-14 on the `lane/index-memory-diagnosis` branch, based on
`lane/vault-scale-benchmark` at `87855a1`. This is a diagnosis, not a fix. No index code was
changed on this branch; every instrument was temporary and is not committed.

## Verdict

The failure is a live set problem in the full-text search index, not a leak, not superlinear
retention, and not an Electron problem. Indexing the 21,145 note corpus needs about 5.5 GiB of
retained JavaScript heap. The default V8 old-space ceiling on this host is 4,144 MiB, so the
process dies at roughly 65 percent of the corpus.

The single dominant consumer is `IndexedSearchDocument.lines`: one JavaScript object plus a sliced
string for every line of every note. The corpus has 31,452,212 lines averaging 27.0 bytes, and each
line costs about 104 bytes of index. That one field accounts for about 3.1 GiB, roughly 55 percent
of the entire heap, to describe 810 MiB of source text.

Raising the heap ceiling completes the run and is a valid stopgap, but it is not an acceptable fix
for a daily driver: the same corpus then settles at about 6.1 GiB of RSS.

## Reproduction

Both the Electron path and the headless kernel path were already recorded as dying at about 4 GiB
in `benchmarks/results/threadleaf-vault-scale-notes-only.json`. The headless path reproduces
exactly.

Corpus integrity was verified before any run. All seven `sampleFiles` in
`<home>/worktrees/.bench-corpus/threadleaf-vault-scale-v1/notes-only/manifest.json` match by
SHA-256 and size, the on-disk byte total is 849,343,388, and the manifest `sampleHash`
`25c3266e...85830d` matches the value recorded in the failing benchmark result.

| Run | Command | Outcome |
| --- | --- | --- |
| Unmodified kernel harness | `node .bench-dist/vault-scale-kernel.cjs --variant notes-only` | Aborted, rc 134, after 322 s. Peak RSS 4,244 MiB |
| Instrumented probe, same code path | `captureVaultBootstrap` then `VaultIndexReactor.fromSnapshotsAsync` | Aborted, rc 134, after 363 s. Peak RSS 4,207 MiB |

The V8 exit is `FatalProcessOutOfMemory` from `Heap::ReportIneffectiveMarkCompactIfNeeded`. The
final collections prove retention rather than garbage pressure:

```
297470 ms: Scavenge     4023.8 (4125.4) -> 4007.6 (4124.3) MB  average mu = 0.267
298166 ms: Mark-Compact 4027.2 (4128.7) -> 4002.9 (4121.6) MB  average mu = 0.255
```

A full mark-compact reclaimed 24 MB out of 4,027 MB and mutator utilisation had fallen to 0.255, so
three quarters of the remaining wall clock was garbage collection over a live set that the heap
could not hold.

Instrumenting the per-document hook gives the death point precisely.

| Checkpoint | Files indexed | Heap used | RSS |
| --- | ---: | ---: | ---: |
| After bootstrap scan, before indexing | 0 of 21,145 | 826.7 MiB | 953.6 MiB |
| Last sample before abort | **13,750 of 21,145 (65.0 percent)** | 3,986 MiB | 4,207 MiB |
| Reported V8 heap ceiling | | 4,144 MiB | |

The bootstrap scan reads all 21,145 notes in 11.4 s and retains 827.3 MiB, an exact 1.00x of the
source bytes. Everything above that is index.

## Attribution

Measured three independent ways that agree: staged retention experiments, a full completion at a
raised ceiling, and two V8 heap snapshots taken during indexing (at 2,000 and 8,000 documents,
`v8.writeHeapSnapshot` from inside the build loop so the live set is intact).

At a 12 GiB ceiling the run completes and settles at **5,650.5 MiB of heap** and **6,175.6 MiB of
peak RSS**. That total decomposes as follows.

| Rank | Structure | Where | Per note | At 21,145 notes | Share |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | Per-line index objects and sliced strings (`IndexedSearchDocument.lines`) | `src/kernel/full-text-search.ts` | 151.6 KiB | **3,131 MiB** | 55.4 percent |
| 2 | Metadata index (`ParsedDocument` per note) | `src/kernel/metadata-index.ts` | 41.1 KiB | **849 MiB** | 15.0 percent |
| 3 | Whole-note folded search key (`normalizedContent`) | `src/kernel/full-text-search.ts` | 39.8 KiB | **822 MiB** | 14.6 percent |
| 4 | Raw note text, retained jointly by the bootstrap array, the line slices, and the `canonicalContent` alias | kernel and search | 40.1 KiB | **827 MiB** | 14.6 percent |
| | Sum of attributed rows | | 272.6 KiB | 5,629 MiB | 99.6 percent |

Sum of rows lands 0.4 percent under the measured 5,650.5 MiB, so nothing material is unaccounted
for. Grouped by subsystem, the full-text search structures own about 4.8 GiB of the 5.65 GiB, the
metadata index owns 849 MiB, and the link graph owns effectively none of it: `links` is a small
array inside `ParsedDocument`, and backlinks are computed on demand inside `snapshot()` rather than
retained during the build.

### Where the 104 bytes per line go

From the 2,000 document heap snapshot, which contains 3,024,105 line objects (1,512 lines per note):

| Component | Bytes | Per line |
| --- | ---: | ---: |
| `IndexedLine` objects (5 fields: `line`, `text`, `canonical`, `normalized`, `simple`) | 184.6 MiB | 64.0 B |
| Line strings reached from those objects | 93.3 MiB | 30.9 B |
| `lines` array backing stores | 23.2 MiB | 7.7 B |
| Total `lines` subtree | 301.1 MiB | 104.4 B |

The average source line is 27.0 bytes. The index therefore spends about 3.9 bytes of JavaScript
object overhead for every byte of line text, and it does this 31.45 million times.

### Two findings that are invisible in the type definitions

**The folded case variants are mostly free, and the duplication people would expect is not the
problem.** `foldSearchText(value, true)` returns `value.normalize("NFC")`, and V8 returns the
receiver unchanged when a string is already in NFC form. Measured on real corpus lines, adding
`canonical` to each line object costs 8 bytes per line, which is exactly one object slot and no
string. `toLowerCase()` behaves the same way when no character changes. In the heap snapshot,
`canonicalContent` appears as only 24 distinct string references across 2,000 documents, and the
per-line `normalized` field holds distinct strings for only 14,106 of 3,024,105 lines, that is 0.5
percent. Only `normalizedContent`, the lowercased whole-note key, is a genuine second copy, because
a whole note almost always contains at least one uppercase character.

**The index retains every note's full text through substring parents, without ever declaring a
content field.** `IndexedSearchDocument` has no `content` property, yet the raw text stays alive:
`document.content.split(/\r?\n/)` produces V8 `SlicedString` values, 32 bytes each, that reference
the original string. The heap snapshot shows 3,020,646 sliced strings holding 96.7 MiB of headers.
Any one surviving line slice pins the whole note. The same mechanism appears in the metadata index,
where heading text, link targets, and property values are all substrings of the note or of the
`stripFencedCode` and `maskMarkdownCodeAndComments` copies. A live metadata index retains 83.3 KiB
per note while the same metadata, forced through a flattening JSON round trip, is 7.4 KiB per note,
an 11x difference.

This is why the working set cannot be reduced by changing when notes are read.

## Hypothesis results

### A. Does indexing complete with the full-text search structures disabled?

**Yes, comfortably.** With `FullTextSearchIndex.prototype.upsert` stubbed and everything else
unchanged, all 21,145 notes index successfully at the default heap ceiling.

| Metric | Value |
| --- | ---: |
| Notes indexed | 21,145 of 21,145 |
| Peak RSS | 2,753.3 MiB |
| Heap after index | about 1,676 MiB |
| Bootstrap scan | 55.2 s |
| Index build | 321.4 s |

This isolates the defect to the full-text search structures. It also produces a second, separate
finding: with full-text search removed the index build still takes 321.4 s of the 359.5 s the full
build takes, so about 90 percent of indexing **time** is `parseDocument`, not search indexing. The
memory problem and the speed problem are in different places.

### B. Linearity: is this constant-factor bloat or superlinear retention?

**Flat, therefore linear.** Bytes per note is constant to within 0.3 percent across a fourfold
range, and drifts slightly downward rather than upward.

| Subset | Index heap delta | Per note | Index time |
| ---: | ---: | ---: | ---: |
| 5,000 | 1,143.5 MiB | 234.2 KiB | 69.5 s |
| 10,000 | 2,283.5 MiB | 233.8 KiB | 143.4 s |
| 15,000 | 3,423.0 MiB | 233.7 KiB | 217.9 s |
| 21,145 | 4,823.2 MiB | 233.6 KiB | 359.5 s |

There is no quadratic term and no accumulating leak. The corpus is simply about 5.5 times too
expensive per byte.

### C. Does a raised ceiling complete the 21k set, and at what peak?

**Yes, and the peak is a fixed live set rather than a function of available headroom.**

| Ceiling | Result | Heap after index | Peak RSS | Index time |
| --- | --- | ---: | ---: | ---: |
| Default (4,144 MiB) | Abort at 13,750 notes | n/a | 4,207 MiB | died at 322 s |
| 8 GiB | Completes | 5,650.0 MiB | 6,115 MiB | 371.9 s |
| 12 GiB | Completes | 5,650.5 MiB | 6,175.6 MiB | 359.5 s |

Giving V8 50 percent more headroom changed the settled heap by 0.5 MiB. This is bounded
constant-factor bloat, about 1.4x over the ceiling, not unbounded retention.

### D. Extra control: what does the 207,726 file `full` variant add?

**Nothing to the heap.** Running the same path against the `full` corpus, which wraps the identical
21,145 notes in 186,581 non-note ballast files, settles at exactly the same heap.

| Variant | Files | Bootstrap scan | Index build | Heap after index | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| `notes-only` | 21,145 | 11.4 s | 359.5 s | 5,650.5 MiB | 6,175.6 MiB |
| `full` | 207,726 | 43.4 s | 314.0 s | 5,650.5 MiB | 6,201.4 MiB |

The ballast costs about 32 s of extra path enumeration and 26 MiB of RSS, and zero retained heap,
because `listMarkdownPaths` filters it out before any content is read. Index memory is a function of
the Markdown payload alone, which is why both variants died at the same ceiling in the original
benchmark.

### E. Extra control: does streaming ingestion help?

**No, and this rules out a whole class of fix.** Rebuilding the index one note at a time through
`MetadataIndex.refresh`, so the 21,145 element bootstrap array is never materialised at all, ends at
a heap of 5,646.7 MiB against 5,650.5 MiB for the batch path, a difference of 0.07 percent.

The bootstrap array looks like 827 MiB of avoidable peak, but its strings are the same objects the
index pins through line slices, so releasing the array frees nothing. Chunked or streaming indexing
is worth doing for time to first search, but it is not a memory fix.

## Recommendation

Reduce what the search index retains. The measurements say this is achievable in plain JavaScript,
in a contained area, without new storage, a new format, or native code.

`lines` is consumed in exactly two places, both in `src/kernel/full-text-search.ts`, and both are
per query rather than per index: the "all terms on one line" scoring bonus in `scoreDocument`, and
content snippet production in `contextCandidates`. Neither needs line data for documents that did
not match, and contexts are only ever produced for at most `limit` returned results, capped at 100.
There is no reason to hold 31.45 million line objects for the life of the process.

Proposed changes, in priority order.

1. **Stop materialising `lines` at index time. Derive them per query, for matched documents only.**
   Removes the entire 3,131 MiB row. Contexts need the exact saved source line, so the matched
   documents, at most 100 per query, should be re-read from disk at query time. Scope: one field on
   `IndexedSearchDocument`, `indexDocument`, and the two call sites, plus a read port on the query
   path. Small, and it is deletion rather than new machinery.
2. **Keep exactly one whole-note comparable key instead of two.** `canonicalContent` currently
   aliases the raw note text, so together with `normalizedContent` the pair pins 1,649 MiB. Retain
   the case-folded key only and serve `caseSensitive: true` queries by verifying candidates against
   the re-read source. Removes about 827 MiB.
3. **Flatten short metadata strings at parse time.** Heading text, link targets, aliases, property
   values, and tag names should be forced to fresh flat strings so that a two-word heading stops
   pinning a 40 KiB note body. Measured headroom is 83.3 KiB per note down to about 7.4 KiB, so
   roughly 700 MiB. Cheap: a copy of a handful of short strings per note.

Together these project to roughly 1.0 to 1.2 GiB of heap, which clears the default ceiling with
more than 3x headroom.

### Options considered and not recommended now

| Option | Judgement |
| --- | --- |
| Compact typed-array or interned structures in JS | Real, but aimed at the wrong row. The big win is not storing line data at all, not storing it more densely. Worth revisiting for the folded key afterwards, where a byte array plus per-note offsets would roughly halve the remaining 822 MiB and remove millions of GC-scanned pointers. Follow-up, not first. |
| Streaming or chunked indexing with a bounded working set | **Measured to save nothing** (item D). Reject as a memory fix. Still worth doing for progressive availability and time to first search, which is a different goal. |
| On-disk index spill, for example SQLite FTS5 | The right long-term architecture for very large vaults, and it would also address the 6 minute index time. But it changes search semantics: the current engine is a grapheme-aware substring matcher with case-fold projections, not a tokeniser, so an inverted index would not preserve current behaviour. Large scope, and not needed to clear the ceiling. Defer. |
| Raise Electron's heap ceiling as a stopgap | Works, and is the only option that needs no code change, but it is **not acceptable as the fix** for the daily driver. It would make an 850 MB vault cost about 6.1 GiB of RSS, which is hostile on a 16 GB laptop running a browser, and it only moves the wall: a vault 1.5x larger breaks again. Acceptable only as a temporary guard rail if a release must ship before the structural fix, and then only alongside a vault-size warning. |
| The narrow native seam reserved by the roadmap | **Not justified by these measurements.** The problem is quantity of retained JavaScript objects, not the speed of a hot loop, and the fix is to stop allocating them. Keep the seam reserved for the separate `parseDocument` time cost if profiling later justifies it. |

### Target numbers the fix should hit

Measured against the same corpus, the same host, and the same headless kernel path.

| Set | Metric | Today | Target after fix |
| --- | --- | ---: | ---: |
| `notes-only`, 21,145 notes, 849 MB | Peak RSS | 6,175.6 MiB at a 12 GiB ceiling, OOM at default | **1.6 GiB or less** |
| | Heap after index | 5,650.5 MiB | **1.2 GiB or less** |
| | Completes at the default 4,144 MiB ceiling | No | **Yes, with 2x headroom or better** |
| `full`, 207,726 files, 21,145 notes | Peak RSS | 6,201.4 MiB at a 12 GiB ceiling, OOM at default | **1.8 GiB or less** |
| | Heap after index | 5,650.5 MiB, identical to `notes-only` | **1.2 GiB or less** |

Index time is deliberately not a target of this fix. The measured baseline at a raised ceiling is
11.4 s of bootstrap scan plus 359.5 s of index build for `notes-only`, and 43.4 s plus 314.0 s for
`full`. Hypothesis A shows about 90 percent of the build is `parseDocument` rather than search
indexing. Memory work should hold time at parity; reaching an interactive figure needs its own lane
against the parser. Note that indexing currently takes about six minutes at a raised ceiling, so
clearing the memory ceiling turns an unusable crash into a slow success, not into a fast one.

## Limitations

- Diagnosis only. No index code was modified on this branch, and no fix was attempted or measured.
  Every projected saving is an extrapolation from measured retention of the structure being removed,
  not an observation of a working fix.
- All figures are Linux, Node v22.22.2, single host, `AMD Ryzen 7 5800X3D`, and the headless kernel
  path. Electron adds a renderer process and its own heap; the recorded Electron failure matches the
  headless one, but nothing in this lane was measured through Electron, so the target numbers above
  are headless targets and the Electron path should be re-measured after the fix.
- Runs were serialised behind the shared heavy-run lock, but the host was not otherwise quiesced.
  Wall-clock timings vary between runs by a noticeable margin: the same bootstrap scan measured
  11.4 s, 43.4 s with ballast, and 55.2 s during the search-stubbed run. Treat the timing figures as
  approximate and the memory figures, which were stable to a fraction of a percent across ceilings
  and ingestion strategies, as the reliable ones.
- The corpus is synthetic. Its notes average 27.0 byte lines and 1,487 lines per note, which drives
  the per-line result directly. A real vault with longer lines would show a smaller multiplier from
  the same defect, and a vault with shorter lines a larger one. The defect is structural either way,
  but the exact 55 percent share is corpus-specific.
- The per-note attribution for row 1 comes from a heap snapshot at 2,000 indexed documents and is
  scaled to the full corpus by the measured corpus line count of 31,452,212, not by that subset's
  own line density, which is about 1.7 percent higher than the corpus average. Row 2 comes from an
  end-to-end run with search stubbed, row 4 from the bootstrap scan measured alone. Only the
  5,650.5 MiB total is a single direct end-to-end observation; the rows are independent measurements
  that sum to it within 0.4 percent rather than a single decomposition.
- Two heap snapshots were captured, at 2,000 and 8,000 indexed documents. Only the 2,000 document
  snapshot was parsed and attributed. The 8,000 document snapshot was captured as a scaling control
  but not analysed, because the linearity result in hypothesis B already measures per-note cost
  directly at 5,000, 10,000, 15,000, and 21,145 notes and finds it flat. Both snapshot files were
  deleted after analysis; they totalled 3.1 GB.
- The metadata flattening figure, 83.3 KiB per note against 7.4 KiB, comes from comparing a live
  metadata index against a JSON round trip of its own snapshot. The attempt to release the live
  index inside the same process did not free the expected memory, so that number is a comparison of
  two retained states rather than a clean before and after, and the 700 MiB estimate for item 3
  should be re-measured against a real change.
- `v8.getHeapStatistics().heap_size_limit` on this host is 4,345,298,944 bytes. Hosts with different
  memory or different Electron flags will move the cliff, so "65 percent of the corpus" is specific
  to this ceiling, not a universal figure.
