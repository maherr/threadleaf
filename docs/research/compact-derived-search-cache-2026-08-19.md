# Compact derived search cache

**Decision date:** 2026-08-19  
**Scope:** Threadleaf's same-host, disposable SQLite metadata and full-text accelerator.  
**Decision gate:** remove the first-build 1.7 GiB cache and 42.8-second close tail without changing
search results, vault authority, warm-start reconciliation, or interruption behavior.

## Decision

Keep one SQLite database under Threadleaf's private per-vault state, but store each note body only
once. Use a contentless-delete FTS5 trigram table with `detail=none` as a candidate index. Convert a
query term to the conjunction of its distinct three-code-point windows, then run Threadleaf's
existing grapheme-aware matcher and scorer over the loaded source candidates. Terms shorter than
three code points take the existing exact linear fallback over the one retained content table.

The FTS table is not a search-result authority. It is allowed to return a superset. The current
Threadleaf matcher still decides inclusion, context, counts, ranking, case sensitivity, diacritic
behavior, folders, tags, and the final page. Vault files remain authoritative for open and write
operations, and the current filesystem fingerprint reconciliation still decides which cached rows
must be refreshed.

An unfinished whole-cache replacement is cancelable. Closing Threadleaf aborts and rolls back that
transaction instead of keeping a hidden Electron process alive. A prior complete generation
survives rollback. Schema 5 uses a new filename; the schema 4 database is removed only after a
complete schema 5 commit.

## Local evidence and invariants

The measured schema 4 cache for the 20,968-note MEGA corpus was 1.7 GiB:

| Storage seam | Size |
| --- | ---: |
| FTS trigram postings with positions | 789.5 MiB |
| Canonical note body table | 364.7 MiB |
| FTS private content copy | 364.3 MiB |
| Parsed document payloads | 77.9 MiB |
| Saved projection | 47.5 MiB |
| Path receipts and indexes | 11.8 MiB |

The non-negotiable local invariants are:

1. Markdown and attachment files remain canonical.
2. Search behavior is fixed by `fixtures/search-golden/full-text-search-golden.json` and the cold
   versus warm parity suite, not by FTS query semantics.
3. A cache hit is only a revalidation candidate. The current path receipt and disk reconciliation
   must still run on every warm launch.
4. A partial or corrupt cache must select rebuild, never partial publication.
5. App close must not wait for a large optional derived write.
6. No cache file or WAL is placed in or synchronized with the vault.

## Primary evidence

| Source | Status and provenance | Claim boundary | Disposition |
| --- | --- | --- | --- |
| [SQLite FTS5](https://www.sqlite.org/fts5.html) | Normative SQLite documentation, public domain, accessed 2026-08-19 | Contentless tables omit the private content copy. `detail=none` stores row IDs without columns or offsets. SQLite's published email-corpus example reduced a 743 MiB full-detail index to 134 MiB. Trigram queries under reduced detail are limited to three-code-point tokens. This does not prove Threadleaf parity or its actual size. | Adapt |
| [SQLite 3.43.0 release](https://www.sqlite.org/releaselog/3_43_0.html) | First-party release record, 2023-08-24 | Establishes when contentless-delete support entered SQLite. It does not establish support in an arbitrary Electron binary. | Benchmark and verify locally |
| [Node SQLite API](https://nodejs.org/api/sqlite.html) | Normative Node API documentation, current page accessed 2026-08-19 | `DatabaseSync` is synchronous and transaction calls block its JavaScript thread. It does not prescribe Threadleaf scheduling or schema. | Depend on the already selected runtime API |
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html) | Normative SQLite documentation | One writer and atomic commit/rollback semantics support a complete-generation cache. It does not make derived bytes authoritative. | Adapt |
| [SQLite WAL](https://www.sqlite.org/wal.html) | Normative SQLite documentation | WAL is a same-host concurrency mechanism and is unsuitable as a network or sync protocol. | Retain host-local WAL only |
| [SQLite FTS5 integrity-check](https://www.sqlite.org/fts5.html#the_integrity_check_command) | Normative SQLite documentation | FTS can check its internal structure. For contentless tables it cannot prove agreement with canonical vault files. | Keep schema and parity checks; rebuild on any database error |

The shipped Electron 43.3.0 runtime reports Node 24.18.1 and SQLite 3.53.1. A local executable
preflight created `contentless_delete=1, detail=none, tokenize='trigram'` successfully. The
development Node path also created it on SQLite 3.51.2. This establishes the exact local seam; it
does not promise compatibility with an untested older runtime.

## Seam synthesis

| Seam | Chosen pattern | Rejected alternative | Proof |
| --- | --- | --- | --- |
| Source storage | One `note_content(id, path, content)` row per note | Normal FTS content storage, which duplicated the full corpus | `search_content_content` must be absent and note row count must equal the cache header |
| Candidate index | Contentless-delete trigram FTS with `detail=none` | Full position lists, because Threadleaf does not consume positions, snippets, NEAR, or BM25 from SQLite | Cold versus warm golden search pages must be byte-equivalent |
| Long term query | Distinct three-code-point windows joined with `AND` | A long phrase token, which reduced-detail FTS explicitly rejects | Candidate false positives are accepted; the existing matcher verifies every final result |
| Short term query | One streaming scan over retained content for all short terms | A second normalized content table | One- and two-code-point golden cases must remain equal |
| Incremental update | Delete contentless row by integer row ID, update the ordinary rows, insert the new candidate row in one transaction | External-content triggers, which add a second consistency mechanism and documented ordering pitfalls | Changed, moved, and deleted row fixture plus full reload |
| Whole replacement | One transaction with an abort check after each bounded batch | Waiting indefinitely on app close or publishing a partial generation | Cancellation fixture must retain the prior generation |
| Version transition | New schema 5 file, delete schema 4 only after schema 5 commit | In-place migration of a large derived file | A failed first schema 5 build leaves files authoritative and the prior cache recoverable |

## Saturation ledger

The initial map covered local authority, current search semantics, current cache layout, SQLite
content modes, reduced-detail limitations, transaction behavior, and runtime availability.

- **Expansion pass 1, storage and query contract:** official FTS5 contentless, external-content,
  trigram, `detail`, `columnsize`, delete, and integrity sections. Result: **NO-CHANGE** against the
  synthesized baseline. It added the required three-code-point query decomposition and confirmed
  that external-content consistency would add a failure seam.
- **Expansion pass 2, runtime and failure history:** Node `DatabaseSync`, SQLite 3.43.0 release
  history, WAL/transaction constraints, and SQLite's contentless-delete maintenance history.
  Result: **NO-CHANGE**. It added two guardrails: verify the packaged runtime version directly, and
  treat any FTS error as disposable-cache failure rather than attempting repair in place.
- **Adjacent-system pass:** the existing code-context FTS decision stores only compact symbol
  metadata, and VS Code's documented text search uses on-demand ripgrep for ordinary files. These
  do not preserve Threadleaf's current contextual search contract without a larger asynchronous
  search redesign. Result: **NO-CHANGE**; both remain contrasts, not dependencies.

No pass introduced a new priority-0 primitive, authority, dependency, implementation order, or
license issue. Discovery is closed for this repair.

## Executable result

The same real MEGA corpus produced a 577,425,408-byte schema 5 database, about 553 MiB. FTS postings
fell to 45.4 MiB and the duplicate FTS content table disappeared. The total cache shrank by about
67 percent. After a deliberate 30-second post-ready settlement, process close took 639 ms instead
of 42.8 seconds.

Three reused-profile launches measured:

| Metric | Samples | Median |
| --- | --- | ---: |
| Usable workspace | 5,722 ms, 5,585 ms, 5,549 ms | 5,585 ms |
| Fully reconciled warm index | 7,722 ms, 7,545 ms, 7,493 ms | 7,545 ms |
| Process close | 686 ms, 655 ms, 708 ms | 686 ms |

These are one-host observations over one live corpus, not universal performance claims. The cache
unit suite separately proves exact search parity, transactional incremental updates, incompatible
vault refusal, compact schema shape, and interrupted replacement rollback.
