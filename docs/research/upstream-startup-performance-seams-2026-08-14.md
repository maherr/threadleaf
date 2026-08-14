# Threadleaf 200K-file startup and indexing seams

**Discovery date:** 2026-08-14  
**Scope:** read-only local inspection plus public-HTTPS upstream discovery. No upstream repository was cloned, fetched, built, installed, or executed.  
**Local source inspected:** `threadleaf` at `f3f0270a3e0fc403e4ce4402769d0b740cc79963` (`main` stated by charter).  
**Decision gate:** remove the workspace/renderer-open wedge without weakening ordinary-files authority, the just-landed reconciliation/tab-race behavior, or deterministic testability.

## Decision in one screen

The first fix lane should **separate an interactive workspace snapshot from the complete vault census/index projection**. Current Threadleaf defers initial activation until the renderer says the shell is ready, which is good, but the deferred activation is still monolithic: it waits for a full Markdown bootstrap, indexing, workspace restore, and then produces a full `WorkspaceFileSummary[]` projection before a ready workspace snapshot is published.

Two local behaviors can independently turn a large vault into a multi-minute wedge:

1. `captureVaultBootstrap()` walks every Markdown path serially. Each `readWatchedFile()` performs lexical resolution, `realpath`, a pre-read `stat`, a full `readFile`, a post-read `stat`, and SHA-256 validation. It accumulates every full document in `documents[]`. `WorkspaceRuntime.open()` awaits that bootstrap and `VaultIndexReactor.fromSnapshotsAsync()` before it returns.
2. After that work, `getWorkspaceSnapshot()` materializes the full metadata/index projection and a `files[]` entry for every indexed Markdown document, rescans visible vault files to derive Canvas entries, and sends the complete snapshot through Electron IPC. The renderer virtualizes *DOM rows*, but still receives the complete list. Its quick switcher then maps and filters that complete list in the renderer.

The index OOM lane is explicitly out of scope. These are different costs: synchronous filesystem work, all-at-once metadata projection, structured-clone/IPC allocation, renderer object allocation, and work scheduling. Fixing only the index representation will not prove that the workspace-open path is fixed.

**Chosen architecture:**

- A small, versioned **interactive snapshot** contains vault identity, restored panes/tabs, active-note state, watcher/reconciliation state, an index/census generation, progress, and bounded visible file-tree/search pages. It never contains the complete file summary array.
- A background **census/index job** performs the cold scan in bounded, cancelable work units. It publishes progress and bounded deltas/pages, not one final 200K-entry snapshot.
- A persisted, explicitly versioned **derived metadata cache** is a phase-two accelerator, not authority. On warm start it can provide candidates immediately, but every edit/open/write continues to validate against disk and watcher uncertainty forces an authoritative reconcile.
- The existing `WatchSequenceGate`, `WatchOperationLedger`, rescan-on-gap behavior, and path/revision semantics remain the correctness boundary. A new scanner or watcher must feed the existing sequenced upsert/delete/move protocol; it must not publish “best effort” file-tree mutations directly to the renderer.

This is an **Adapt** decision, not a request to adopt Watchman, Parcel Watcher, SQLite, React Window, VS Code, or Zed code.

## Local architecture evidence and non-negotiable constraints

| Local area | Observed behavior at `f3f0270` | Consequence for this decision |
|---|---|---|
| `src/main/main.ts` and `src/renderer/renderer.ts` | The main process creates an opening controller, shows the shell, then renderer `requestAnimationFrame` calls `markStartupShellReady()`. Deferred vault activation begins after that signal. | Preserve shell deferral, but make the *meaningful workspace* phase incremental rather than a single awaited activation.
| `src/application/workspace-runtime.ts:~905` | `WorkspaceRuntime.open()` awaits `captureVaultBootstrap`, builds `NodeVaultWatcher.fromSnapshot`, awaits full `VaultIndexReactor.fromSnapshotsAsync`, restores workspace state, and starts the watcher. | No final ready snapshot should depend on all Markdown contents or on a complete index unless a feature explicitly asks for it.
| `src/kernel/node-vault-watcher.ts` | Bootstrap and snapshot collection iterate paths serially. `readWatchedFile()` validates a full-file SHA-256 around a read. Runtime `fs.watch` events are debounced, then `scanNow()` performs a whole-vault `captureVaultSnapshot()` and diffs it. | Measure the repeated metadata/read/hash work separately from renderer costs. Do not use unlimited `Promise.all`; use a bounded walker and preserve a coherent scan/event boundary.
| `src/kernel/watch-protocol.ts` | Batches have `(streamId, sequence)`. Gaps, stream change, and first-non-1 events force `rescan`. `WatchOperationLedger` normalizes known operation pairs into moves. | This is the authority-preserving anti-resurrection mechanism. Keep it; change only how scan results are produced, checkpointed, and transported.
| `src/application/workspace-runtime.ts:~2839,~2877` | Any published watch batch clears the visible-file cache. `getWorkspaceSnapshot()` asks `index.snapshot()`, calls `visibleVaultFiles()`, maps all index documents to `files[]`, and builds Canvas entries from all visible paths. | A snapshot publish cannot require an O(vault) filesystem list or O(index) renderer payload. Move tree enumeration behind a query/page API or a separately cached kernel model.
| `src/kernel/metadata-index.ts` | `fromSnapshotsAsync()` yields every 32 documents, but the caller awaits the entire operation; `snapshot()` sorts all documents and derives link/backlink snapshots. | Event-loop yielding is not time-to-usability. Treat it as cooperative throughput only, and put user-visible readiness before completion.
| `src/renderer/renderer.ts`, `src/renderer/virtual-list.ts` | File-list DOM rows are windowed by `virtualListWindow()`, so the renderer already avoids mount-all. `quickSwitcherNotesFromFiles()` nevertheless maps every `workspace.files` item, and `filterQuickSwitcherNotes()` walks/sorts that array. | Do not replace virtualized DOM with another virtual list library. Remove the all-files IPC/data-model dependency and make title/path lookup kernel-side or paged.

### Local invariants to preserve exactly

1. **Files are authority.** No cache or UI state may make a deleted, moved, or externally modified ordinary file look committed. A persisted index is disposable derived state.
2. **No resurrection/loss.** Keep sequence/stream validation, expected-operation reconciliation, stale-vault guards, expected revisions, and the existing full-rescan fallback. A cache hit is never proof that an old path still exists.
3. **The renderer is a consumer, not a vault mirror.** It may hold a bounded view, active documents, and generation-tagged pages. It must not become the only place that knows all paths or the authority for moves.
4. **Determinism.** Clock, filesystem traversal order, watcher events, batching, persistence invalidation, and cancellation must be injectable or fixture-driven. No performance correctness test should need wall-clock sleeps.

## Source handling and confidence

`Normative` means an upstream platform/database contract. `Primary engineering` means first-party implementation or first-party engineering writing. `Advisory` means product documentation, forum report, or issue report; it can shape a fixture but cannot establish Threadleaf causation.

The browser gateway rejected public GitHub API commit endpoints as unsafe to open, so immutable source SHAs for remote `main`/`master` branches are a named **GAP**, not silently guessed. Where a released package/document version was visible, it is pinned below. No upstream code is proposed for copy/extraction, so mutable implementation references inform behavior only.

## 1. Cold-start architecture of large-workspace editors

### Chosen pattern and fit

**Adopt a two-clock startup:** (1) first interactive workspace and (2) background whole-vault completion. The first clock blocks only on the smallest state needed to draw and operate the shell safely: vault identity/root policy, durable workspace layout, active-tab candidate, tab-race/reconciliation recovery state, and a watcher/census session identifier. The second clock performs broad discovery, parsing, graph completion, and file-tree census under a visible progress contract.

The implementation is not “show a spinner sooner.” The first interactive snapshot must be a real state with generation and availability semantics. A restored tab can be opened on demand from disk, and a tree/search request can report `warming` plus a bounded page. What it must not do is send a final-looking full file list that later silently changes.

VS Code’s documented tree design separates virtual rendering from its collection model; Sublime explicitly runs project index workers in the background; Zed’s post-mortem shows that user-observed first result can be catastrophically delayed despite comparable aggregate throughput when work priority is wrong. Together they support staged readiness, but none proves an Obsidian-compatible Electron app should copy their specific implementation.

| Source | Identity / version / license | Status | Claim boundary |
|---|---|---|---|
| [VS Code Lists and Trees wiki](https://github.com/microsoft/vscode/wiki/Lists-And-Trees) | First-party VS Code wiki, last edited 2025-09-05; Code-OSS repository is MIT. Wiki revision is mutable, exact source SHA GAP. | Primary engineering | VS Code’s `List` virtualizes DOM and documents 100K elements; it does **not** establish Threadleaf startup behavior or IPC shape. |
| [VS Code performance issues wiki](https://github.com/microsoft/vscode/wiki/performance-issues) | First-party operational documentation, mutable wiki; Code-OSS MIT. | Primary engineering | Provides an explicit startup-profiling culture and the `--prof-startup` route, not a large-vault solution. |
| [Zed: Nerd-sniped Project Search](https://zed.dev/blog/nerd-sniped-project-search) | First-party engineering post, 2025-11-26, describes Zed 214.4. Source implementation license/revision not extracted, GAP; no code reuse proposed. | Primary engineering | Shows delayed first result despite near-ripgrep throughput, caused by worker starvation; it is a search case, not a startup measurement. |
| [Sublime Text indexing documentation](https://www.sublimetext.com/docs/indexing.html) and [Sublime engineering note](https://www.sublimetext.com/blog/articles/file-indexing) | Official product docs; current docs identify build 4050. Proprietary implementation, no reusable source license, GAP. | Advisory, compatibility pattern | States indexing is background/low priority and progress-visible. It does not specify an Electron IPC or persistence contract. |
| [Obsidian large-vault workspace incident](https://forum.obsidian.md/t/large-vault-on-desktop-loading-workspace-takes-a-long-time/81721?page=2) | Forum report, 2024; proprietary implementation and source/license unavailable, GAP. | Advisory, compatibility relevant | Reports 30K+ notes changing from roughly half an hour to seconds after a version change. It confirms a user-visible failure class, not its root cause or a fix commit. |

### Disposition, invariant, and required proof

**Disposition:** Adapt the staged-startup pattern now. Do not depend on VS Code/Zed/Sublime/Obsidian.

**Invariant:** the initial interactive snapshot has a real `censusState` such as `not-started | warming | current | rebuilding | degraded`, a monotonic `indexGeneration`, and an explicit bounded-data contract. It must not assert complete file-tree or graph knowledge while warming.

**Required local proof:**

- Add a performance span diagram around shell paint, deferred activation begin, watcher usable, restored-note readable, first interactive command accepted, first file-tree page, index usable, and background completion. Record structured timing and memory instead of only one total.
- With a deterministic synthetic 207K-entry vault and an injected slow read port, prove that first interaction is accepted before the complete census/index promise resolves. A test that merely observes the shell spinner is insufficient.
- Prove the active restored file is read from and revision-validated against disk, not blindly served from cached index content.
- Prove the same result when no workspace layout exists, when the restored tab has been deleted while the app was closed, and when recovery state is present.

### Conflict and rejected alternatives

- **Rejected:** “await full index but yield every 32 files.” This improves fairness but preserves the all-or-nothing readiness gate.
- **Rejected:** “render the workspace before loading any state.” It can lose tab/recovery authority and make a stale layout look final.
- **Conflict:** Zed’s example makes completion-confirmation tasks higher priority than broad candidate scans. For Threadleaf, foreground user operations and watcher/reconciliation work must outrank background census work, but a watcher overflow/reconcile must outrank cosmetic progress.

## 2. Filesystem scan and event batching

### Chosen pattern and fit

Use a **bounded initial walker plus an explicit event-cursor boundary**:

1. Establish a watcher/session boundary before or atomically with the crawl. Queue raw events while the initial census runs.
2. Crawl directories with bounded concurrency and a deterministic ordering policy. Use directory-entry names/path classification first; only stat/read/hash a Markdown file when the tier requires it. Do not create one promise per file.
3. Fold raw events by path inside a bounded debounce/settle window, then translate them to the existing `VaultChangeBatch` protocol. Do not invent moves from a generic delete/create pair; let the existing operation ledger and stable identity rules decide.
4. Reconcile the queued tail against the census generation. Any overflow, backend error, cursor discontinuity, ambiguous rename, or queue bound breach produces the current explicit `rescan` route, never an optimistic state patch.

Watchman is the clearest model for *semantics*: clients keep a last clock, subscribe using `since`, receive post-settle changes, and treat the cursor as part of correctness. Parcel Watcher independently supports saved snapshots plus `getEventsSince()` and coalesces before JavaScript. Neither is a drop-in choice yet: on Linux Parcel’s historical query defaults to a brute-force backend without Watchman, and Threadleaf currently uses Node’s `fs.watch`.

| Source | Identity / version / license | Status | Claim boundary |
|---|---|---|---|
| [Watchman subscriptions](https://facebook.github.io/watchman/docs/cmd/subscribe) | First-party Watchman docs; subscriptions since 1.6, settling behavior described since 3.2, advanced state controls since 4.4. Watchman repository is MIT; exact remote revision GAP. | Primary engineering | Documents clock/since/settle semantics. It does not guarantee Node `fs.watch` has an equivalent persistent journal. |
| [Parcel Watcher README](https://github.com/parcel-bundler/watcher) | `@parcel/watcher` 2.6.0 (npm release visible 2026-08-08), MIT; repository `master` mutable, exact SHA GAP. | Primary engineering | Documents coalescing, saved snapshots, and historical query. It states Linux/Windows historical queries can be brute-force, so it is not evidence of constant-time warm starts on this host. |
| [Node `fs.watch` documentation](https://nodejs.org/api/fs.html#fswatchfilename-options-listener) | Node.js v26.5.1 docs, current public API. Node license MIT. | Normative for current wrapper behavior | Recursive support exists on Linux from Node 19.1; backend depends on OS and can be unreliable on network/virtualized filesystems. It does not document a durable event cursor. |
| [Linux `inotify(7)`](https://man7.org/linux/man-pages/man7/inotify.7.html) | Linux man-pages, public platform contract; current page accessed 2026-08-14, exact man-pages release GAP. | Normative on Linux | Queue overflow drops events and emits `IN_Q_OVERFLOW`; robust applications must allow cache inconsistency and rebuild. It does not specify Threadleaf’s protocol. |
| [Chokidar README](https://github.com/paulmillr/chokidar) | Chokidar v5.0.0, MIT; exact commit SHA GAP. | Primary engineering, advisory for selection | Shows watcher normalization and atomic-write/stability choices, not a persistent cursor. |
| [notify-rs/notify](https://github.com/notify-rs/notify) | Current `main`; core `notify` CC0-1.0, debouncer crates MIT or Apache-2.0; no semver extracted, GAP. | Bounded N/A | Useful contrast for backend/debouncer separation, but Threadleaf is TypeScript/Electron and no Rust rewrite is proposed. |

### Disposition, invariant, and required proof

**Disposition:** Adapt Watchman/Parcel semantic shape. Keep `fs.watch` initially unless the measurement harness attributes a material portion of the wedge or a real reliability defect to it. Treat introducing `@parcel/watcher` as a separately benchmarked dependency decision, not as a presumed performance fix.

**Invariant:** every published scan result has a scan/session generation. Every external change becomes exactly one of: sequenced incremental batch, explicit ordered rescan, or no logical change. Overflow, lost history, and ambiguous rename are visible invalidation reasons.

**Required local proof:**

- Deterministic initial-crawl race fixture: create, modify, delete, and rename files while the walker is paused between directory pages. The final kernel snapshot must equal a fresh authoritative scan, including current tab state and no resurrected path.
- Deterministic overflow/gap fixture: inject backend `overflow`, stream change, sequence gap, and error separately. Assert one rescan reason, no false move, and no direct partial snapshot accepted by the renderer.
- Bulk fixture: 207K entries with realistic deep fan-out plus a few large Markdown files. Count `readdir`, `stat`, `realpath`, reads, hashes, raw events, logical changes, and max queued work. Assert work queues are bounded.
- Rename fixture: external delete/create with matching content but no known transaction must remain delete+upsert or force reconcile; known application move must retain current `WatchOperationLedger` behavior.

### Conflicts and rejected alternatives

- **Conflict:** Parcel coalescing deliberately emits only one final event per path and represents a rename as delete plus create. That is correct for its API but insufficient alone to preserve Threadleaf’s move/tab-race semantics. Normalize behind the existing ledger, not in a generic watcher callback.
- **Rejected:** a fresh full `captureVaultSnapshot()` on every debounced event. It gives simple correctness but makes ordinary burst activity O(vault) and can repeatedly re-enter the wedge.
- **Rejected:** a pure event-based cache with no reconcile. `inotify(7)` explicitly requires recovery from races and overflow.
- **Rejected:** unlimited parallel `realpath/stat/read/hash`. It can move the wedge into I/O contention, queue memory, and user-operation starvation. Concurrency must be measured and bounded.

## 3. Incremental and persistent index bulk-load

### Chosen pattern and fit

Make persistence a **replaceable derived manifest/index** with a conservative validity header. It may be implemented later with SQLite, but the first fix does not require adding a database. The contract matters first:

- Header fields: vault root identity/policy version, Threadleaf metadata parser/index schema version, ignore/visibility policy version, canonicalization/symlink policy version, and scan completion/cursor information when a durable journal is available.
- Per-path cheap validation tier: normalized path plus file identity, size, `mtimeNs`, `ctimeNs`, and other currently used revision identity. A changed tuple schedules a read/parse/hash. A direct open/edit/write always reads/validates the actual file even if the tuple is unchanged.
- Content hash tier: retain/use the SHA-256 only after a candidate is changed, during a required conflict check, or for a sampled/full audit. Do not read every file merely to prove an otherwise current warm cache.
- Invalidity: incompatible schema/policy, unclean cache transaction, unusable watcher cursor, explicit overflow, root identity mismatch, or a sampled validation failure. These select a rebuild/reconcile state, not silent acceptance.
- Commit: write a new fully formed cache state in one transaction and expose it only after commit. If interrupted, discard/rebuild the cache; ordinary files stay authoritative.

SQLite is appropriate only as a local, same-host derived-state store. WAL must not live in the synced vault or be treated as a cross-host protocol. It has one writer, so bulk rebuild/checkpoint scheduling must not block foreground cache readers indefinitely.

| Source | Identity / version / license | Status | Claim boundary |
|---|---|---|---|
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html) | Official SQLite docs, updated 2026-02-18; SQLite is public domain. | Normative | Explains implicit transaction boundaries and one simultaneous writer. It does not prescribe a Threadleaf schema. |
| [SQLite WAL](https://www.sqlite.org/wal.html) | Official SQLite docs, current page accessed 2026-08-14; public domain. | Normative | WAL gives same-host reader/writer concurrency, needs checkpoint management, and does not work over network filesystems. It does not make a synced vault index safe. |
| [SQLite `synchronous` pragma](https://www.sqlite.org/pragma.html#pragma_synchronous) | Official SQLite docs, current page accessed 2026-08-14; public domain. | Normative | WAL + `NORMAL` remains consistent but can lose latest transactions on power loss; `OFF` is suitable only for a from-scratch recreatable database. It does not authorize unsafe use for durable user data. |
| [VS Code storage service source](https://github.com/microsoft/vscode/blob/main/src/vs/platform/storage/common/storage.ts) | Code-OSS MIT; branch is mutable, exact SHA GAP. | Primary implementation contrast | Shows distinct workspace-scoped storage and flush/optimization concepts. No public upstream evidence found in this pass for a single core VS Code file-index warm-start invalidation contract. |
| [ripgrep guide: automatic filtering](https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md#automatic-filtering) | ripgrep current guide, MIT or Unlicense; mutable `master`, exact SHA GAP. | Primary implementation contrast | Shows one-shot traversal that prunes ignored/hidden/binary inputs rather than maintaining an editor index. It is a contrast, not a persistent-index design. |
| [Sublime indexing article](https://www.sublimetext.com/blog/articles/file-indexing) | First-party article, 2015; proprietary implementation and cache format/license unavailable, GAP. | Advisory | Confirms a persistent index can corrupt/repeat and needs diagnosability. It does not document its invalidation algorithm. |

### Disposition, invariant, and required proof

**Disposition:** Adapt the derived-cache contract now; defer a SQLite dependency decision until the measurement harness shows cold scan/index cost remains material after bounded snapshots and staged activation. If SQLite is selected, place it under Threadleaf application state, never inside the vault, and use a single bulk `BEGIN … COMMIT` import with cancellation/rollback semantics.

**Invariant:** a cache is never a source of truth. Cache metadata selects what to revalidate; actual file reads/revisions decide open, save, move, delete, and conflict outcomes. A failed cache build never makes an ordinary file disappear.

**Required local proof:**

- Cache hit fixture: build a cache, close, mutate one file, delete one, rename one, add one, and change the visibility/config schema. Reopen and assert every actual disk state wins, old paths do not resurrect, and the cache eventually reaches the same canonical index as a clean scan.
- False-negative metadata fixture: simulate same size and timestamp tuple with changed bytes. Opening or editing that note must detect the actual revision/hash mismatch before writing; a later audit/reconcile must heal its metadata.
- Interruption fixture: abort cache creation before commit, at commit, and after commit before checkpoint. The next run either uses a complete committed generation or rebuilds; it never reads a half generation.
- If SQLite is chosen: prove WAL location is host-local, write transactions are bounded, foreground read behavior remains responsive during rebuild, and checkpoint state is observable. Test `FULL`, `NORMAL`, and only a disposable-from-scratch `OFF` build separately; do not declare them equivalent.

### Conflicts and rejected alternatives

- **Conflict:** mtime/size validation makes a useful cheap filter, not a cryptographic proof. Treat it as a tier, never the authority decision for an edit.
- **Rejected:** content-hash all 200K inputs on every warm start. It reproduces cold I/O under a different name.
- **Rejected:** syncing a SQLite/WAL index alongside ordinary vault files. SQLite’s own WAL documentation rules out cross-host shared-memory operation, and Threadleaf’s files-as-authority model does not need it.
- **Rejected:** use `synchronous=OFF` against an existing, valuable cache simply because the data is derived. A torn cache is tolerable only if it is explicitly disposable and never selected as valid before full commit.

## 4. Renderer virtualization and IPC at 200K items

### Chosen pattern and fit

Use **kernel-owned, generation-tagged, bounded views**:

- `RuntimeSnapshot` carries counts, generation/state, active/restored tabs, selected/expanded tree nodes, a bounded initial root/viewport page, and progress. It does not carry full `files`, full Canvas paths, full backlinks, or full document projections.
- Add an explicit query path for file-tree pages and title/path matching, such as a cursor or `(parentPath, sort, offset/cursor, limit, generation)` request. The response is bounded and includes `generation`; a stale cursor receives a reset/retry signal.
- File-tree mutations are delta messages or page invalidations keyed by the same generation/sequence, rather than a new entire workspace snapshot for every tab, save, or watch batch.
- Quick switcher/title-path search runs in the kernel index and returns a bounded top-k result set. It must not import every file into the renderer merely to filter 200 results.
- Keep the existing renderer virtual list for DOM work. It is a positive control: after change, render only viewport rows *and* only receive bounded source objects.

This targets three different anti-patterns that virtualization alone does not solve:

1. serializing 200K objects through Electron’s structured clone/IPC;
2. allocating, mapping, sorting, and retaining 200K JS objects in the renderer;
3. issuing a filesystem-wide visible-file/canvas enumeration every snapshot publish.

| Source | Identity / version / license | Status | Claim boundary |
|---|---|---|---|
| [VS Code Lists and Trees wiki](https://github.com/microsoft/vscode/wiki/Lists-And-Trees) | First-party design note, 2025-09-05, Code-OSS MIT; mutable wiki, exact revision SHA GAP. | Primary engineering | Documents visible-only DOM rendering and tree-as-list composition. It does not say a full serialized model is acceptable. |
| [react-window](https://github.com/bvaughn/react-window) | v2.2.7 visible in package metadata during discovery, MIT; exact commit SHA GAP. | Advisory / Benchmark only | A React virtual-list implementation. Threadleaf is not React and already virtualizes DOM, so it is not a dependency recommendation. |
| [web.dev virtualize long lists](https://web.dev/articles/virtualize-long-lists-react-window) | Google web.dev technical article, advisory; article/license not evaluated for code extraction because none is proposed. | Advisory | Explains windowing as visible-row reduction, not IPC/persistence behavior. |
| [Zed project-search post](https://zed.dev/blog/nerd-sniped-project-search) | First-party post, 2025-11-26. | Primary engineering | Explicitly warns that fast-arriving large result sets can flood UI rendering and make it unresponsive. Search-specific but directly analogous to snapshot flooding. |
| [VS Code issue #323387](https://github.com/microsoft/vscode/issues/323387) | User issue, open as of discovery, VS Code 1.126.0 report; Code-OSS MIT project. | Advisory incident | A reported large cached blob synchronously loaded into renderer crash. It is not confirmed root cause or a VS Code architectural specification, but is a strong red-fixture shape. |

### Disposition, invariant, and required proof

**Disposition:** Adapt bounded-model plus virtual-DOM pattern. Make this the first candidate fix for the known workspace/renderer-open wedge before changing watcher library or adding a persistent database.

**Invariant:** no ordinary user action, watcher batch, or workspace-state publish sends O(number of vault files) objects across main-to-renderer IPC. A user-visible page belongs to a declared generation and can be invalidated/reloaded without ambiguity.

**Required local proof:**

- Contract test captures every `threadleaf:snapshot-changed` payload and every `getSnapshot` result for a synthetic 207K-entry vault. Assert no full file list/document/backlink projection is present and payload byte/object-count ceilings stay independent of total vault cardinality.
- Positive-control test asks for successive file-tree pages and quick-switcher queries. Assert page ordering, total count, invalidation/retry on changed generation, and correct handling of a move/delete while a page is displayed.
- Renderer test asserts only viewport DOM rows mount **and** measures the complete received object count. The existing virtual-list assertion alone is insufficient.
- Add a synthetic giant cached-workspace payload rejection: a persisted state/cache record exceeding an explicit cap must be rejected/rebuilt/paged, never blindly structured-cloned to the renderer.

### Conflicts and rejected alternatives

- **Rejected:** “the renderer is virtualized already.” DOM virtualization does not cap IPC, serialized object graph size, quick-switcher mapping/sorting, or main-process filesystem work.
- **Rejected:** blindly debounce whole snapshots. It lowers frequency but leaves each payload O(N), creates stale UI, and can make the eventual burst worse.
- **Rejected:** preloading all titles/paths as a special exception. At 200K it reintroduces the same transport/allocation failure under a smaller type. Use a kernel-side top-k query or paged traversal.

## 5. Incident-derived candidate red fixtures

### Chosen pattern and fit

Use an **incident-to-local-fixture translation**, not an upstream-bug copy. An incident supplies an input shape, a visible failure, and sometimes a recovery pattern. Threadleaf retains it only after an executable local test states the authority invariant and passes against a clean canonical scan. This is the right fit for a files-authoritative app: user reports can make a missing state observable, but cannot overrule the kernel’s reconciliation contract.

Incidents below are not proof that Threadleaf has the same bug. Each is a pinned input/failure signature that should become a local regression fixture only when mapped to a specific Threadleaf seam. A closed issue is not treated as evidence of repair unless a linked fix commit was visible. Where none was visible, that is recorded.

| Candidate fixture | Upstream incident and status | Reported input/failure | Linked repair evidence | Local test adaptation |
|---|---|---|---|---|
| Watch-limit / large-tree burst | [VS Code #171435](https://github.com/microsoft/vscode/issues/171435), **closed**, 2023, labeled info-needed. | 119K + 30K + 17K nested `node_modules`; watcher warning remained until exact paths were excluded. | No PR/branch linked on issue page, so close is not repair proof. | 207K mixed tree with many ignored/non-Markdown and nested high-fanout folders. Assert exact policy pruning, bounded watches/work, and no startup all-file UI payload. Do not import VS Code’s exclusion semantics automatically. |
| Initial watcher CPU spike | [VS Code #3961](https://github.com/microsoft/vscode/issues/3961), **closed**, 2016. | Test plan names very large Chromium/TypeScript folders and an initial CPU spike; excluding folder removes it. | No PR/branch linked on issue page. | Measure watcher registration/crawl separately from index parse and IPC. Assert ignored subtree avoids crawler/watcher work only where Threadleaf policy says it is invisible. |
| Missed new-file event | [Chokidar #1361](https://github.com/paulmillr/chokidar/issues/1361), **closed as not planned**, 2024. | Electron 32, Chokidar 4.0.0, Windows 11: new file events reported missed 2/3 of the time; downgrade reported workaround. | No fix commit; explicitly not planned. | Backend event-loss injection: add an external file, withhold its event, then force sequence/error reconcile. Assert authoritative rescan finds it and renderer does not remain permanently stale. |
| Large workspace/loading freeze | [Obsidian forum upstream-bug thread](https://forum.obsidian.md/t/large-vault-on-desktop-loading-workspace-takes-a-long-time/81721?page=2), bug graveyard/upstream-bug tags. | User reports 30K+ notes opened in seconds rather than about half an hour after a version change; another report says 4-5 minutes became 6 seconds. | No source or fix commit available. Proprietary GAP. | A product-level threshold fixture: required TTUS and background completion spans must be recorded separately. Never use the anecdotal 30K numbers as a Threadleaf target. |
| Renderer cache flood | [VS Code #323387](https://github.com/microsoft/vscode/issues/323387), **open**, 2026. | User reports a roughly 140 MB workspace storage cache loaded into renderer and renderer process crash. | Open; no repair commit. User report only. | Oversized persisted `files`/workspace cache input. Assert size cap, lazy/page path, safe invalidation, and that the renderer never receives a monolithic payload. |
| Task-priority starvation | [Zed project-search post](https://zed.dev/blog/nerd-sniped-project-search), first-party, 2025. | 100K-file search with rare match: candidate scans starved confirmation task; Zed reports first match 16.8s, then 32ms after prioritization in one benchmark. | Post links an implementation core loop, but no immutable SHA captured: GAP. | Queue an active-note load, watcher reconcile, and user search behind 200K background crawl tasks. Assert foreground work wins deterministically and census throughput eventually completes. |

| Source identity / version | License | Status | Claim boundary |
|---|---|---|---|
| VS Code #171435 and #3961, Code-OSS project | MIT for Code-OSS; issue prose is factual report content, not reusable implementation. | Closed; no linked repair PR/commit on page. | Establish large-tree/watch fixture shapes only. Neither specifies Threadleaf visibility policy or proves a cause. |
| Chokidar #1361, Chokidar 4.0.0 report | MIT project; issue prose not implementation. | Closed as not planned; no repair. | Establish an event-loss recovery fixture only. It does not prove Threadleaf or Node misses the same event. |
| Obsidian forum thread, 2024 | Proprietary implementation; source/license for internals unavailable, GAP. | Forum page categorizes it upstream-bug/bug graveyard. | Establish product-level workspace-loading and progress instrumentation fixture only. No causation or implementation inference. |
| Zed project-search engineering post, 2025-11-26 | No source extraction; implementation revision/license GAP for this report. | First-party engineering account. | Establish scheduler-starvation fixture. It is search, not workspace startup. |
| VS Code #323387, VS Code 1.126.0 user report | MIT Code-OSS project; user report has no implementation license relevance. | Open during discovery. | Establish oversized persisted-payload guard; it is not confirmed renderer root cause. |

### Disposition, invariant, and required local proof

**Disposition:** Adapt every row above as a deterministic local red fixture only. Do not depend on an issue workaround, product-specific ignore semantics, or a claimed repair.

**Invariant:** a fixture fails on an observable Threadleaf contract, such as canonical file state, bounded IPC payload, foreground scheduling, or truthful progress. It never fails merely because Threadleaf has not copied another product’s exact timing, wording, or watcher option.

**Required local proof:** introduce each fixture with a positive control that proves the injected condition actually occurred, then assert both (a) the expected immediate state transition and (b) final equality with a fresh authoritative scan. Pair performance fixtures with a deterministic counter/trace rather than a flaky wall-clock threshold.

### Conflicts and rejected alternatives

- **Rejected:** treating a closed tracker issue as a verified repair or as source-level proof. Several source pages have no linked fix commit.
- **Rejected:** importing VS Code’s `files.watcherExclude` or Chokidar version workaround as Threadleaf policy. Threadleaf must preserve its own ordinary-file visibility and compatibility rules.
- **Conflict:** incidents mix macOS, Windows, Remote-SSH, Electron, and proprietary builds. Their shared value is the regression shape, not a claim of identical backend behavior on this Fedora Electron path.

## Ranked hypotheses for Threadleaf’s roughly 17-minute workspace-open wedge

These are hypotheses, not a diagnosis. The measurement harness should falsify them in order; do not stack implementation changes before separating spans.

1. **Full workspace snapshot and IPC flood after successful bootstrap.**  
   **Mechanism:** `getWorkspaceSnapshot()` creates full document/backlink/file projections, invokes `visibleVaultFiles()`, then `main.ts` sends that snapshot to renderer. The renderer retains/maps all files and the quick switcher can sort them. This is exactly the anti-pattern DOM virtualization does not address.  
   **Mined pattern/fixture:** VS Code virtual list contract plus the VS Code #323387 oversized renderer-cache incident.  
   **Test first:** record payload bytes/object counts and main/renderer heap around first ready publication; substitute a bounded snapshot while holding the same kernel index result. If the 17-minute leg collapses, this is primary.

2. **Serial bootstrap read/stat/hash cost, amplified by full content retention.**  
   **Mechanism:** `captureVaultBootstrap()` does per-Markdown `realpath → stat → read → stat → hash` serially and retains document text for index construction. Even without OOM, 207K filesystem round trips can dominate.  
   **Mined pattern/fixture:** bounded scanner plus foreground priority from Watchman/Parcel/Zed; VS Code large-tree watcher incidents.  
   **Test first:** isolate list, metadata, content-read, hash, parse, and index timings/counters. Replay a statless path fixture versus real reads, then bounded-concurrency read with the same output. The acceptance condition is identical canonical index, not raw throughput alone.

3. **Whole-vault rescan caused by watcher startup or event activity during open.**  
   **Mechanism:** `NodeVaultWatcher.start()` plus debounced events can call `scanNow()`, which recaptures the complete vault snapshot. Initial sync/tool activity can add another O(vault) pass before the first ready workspace.  
   **Mined pattern/fixture:** Watchman `since`/settle and inotify overflow/rebuild semantics.  
   **Test first:** instrument every `captureVaultSnapshot` reason/count during activation. Inject a burst during bootstrap and assert no repeated complete scan occurs unless a documented explicit-rescan condition fires.

4. **Metadata snapshot and link/backlink resolution all-at-once.**  
   **Mechanism:** `MetadataIndex.snapshot()` sorts every document, resolves links, and builds backlinks before the workspace projection. `fromSnapshotsAsync()` yields but does not give an operational workspace until it returns.  
   **Mined pattern/fixture:** Sublime background indexed capability and Zed task hierarchy.  
   **Test first:** hold filesystem and IPC constant, time parse/index/link resolution separately, and offer an active-note + incremental metadata path. Verify exact final golden search/link results against the existing deterministic corpus.

5. **Background task starvation of a user-critical continuation.**  
   **Mechanism:** even after task slicing, a flood of scan/parse jobs can occupy all workers/turns and delay active-note load, reconcile, or the first page.  
   **Mined pattern/fixture:** Zed’s 100K rare-match starvation analysis.  
   **Test first:** deterministic scheduler test with 200K low-priority work items and a late foreground task. Assert latency bound by number of priority queues, not number of files.

6. **Watcher backend limit or loss causes pathological repair work.**  
   **Mechanism:** a watch limit, overflow, or unreliable backend can continually invalidate/rebuild rather than settle.  
   **Mined pattern/fixture:** `inotify` overflow contract, Node caveats, VS Code/Chokidar incidents.  
   **Test first:** log backend choice, watch count/limits, overflow/error count, and rescan reasons. Only consider a watcher replacement if this span is material or a correctness fault is reproduced.

## Recommended deferral contract and acceptance legs

The existing shell-ready gate is useful but too weak as success evidence. “First interaction” means an action that reaches the real workspace control path, not clicking a disabled chrome shell.

| Acceptance leg | Blocks before this point | Explicitly background after this point | Required state and proof |
|---|---|---|---|
| **Cold** | Process/app settings recovery, vault root policy/identity, workspace-state parse/reconciliation, opening watcher/census session, and a bounded first active-note/path operation. | Complete directory census, full Markdown reads, hashes, parse/index/graph completion, full tree expansion. | Synthetic cold 207K vault. Record shell-ready, workspace-interactive, active-note-ready, first tree page, index-ready, and completion. Assert no complete `files[]` IPC payload before interaction. |
| **Warm** | Cache header/schema/policy compatibility and active/restored note direct disk validation. | Cheap-cache audit/reconcile, full scan if no usable journal, index refresh for unrelated files. | Close/mutate/delete/move/add while app is closed. The UI may say `warming`, but must not resurrect stale paths; target note read/write checks actual revision. |
| **Incremental** | Applying a bounded sequenced batch necessary to current user action; a detected gap/overflow must select explicit reconcile state. | Coalesced processing of unrelated changes, background index detail rebuild, cache checkpoint. | Inject create/change/delete/move/burst/gap. Final kernel state equals clean authoritative scan, and tab-race/reconciliation golden tests remain unchanged. |
| **TTUS** (time to usable state) | A meaningful command: open restored note, create a note, use a bounded tree page, or run bounded title/path search. It must be safe to reject unavailable full-text results as warming. | Full tree and full-text completeness. | Instrument a real IPC request/response and UI update, not a spinner or first paint. Foreground command wins over the census queue in deterministic scheduling. |
| **Background completion** | Nothing in the interactive surface besides accurate progress/state. | Complete scan, parse/index/link/backlink rebuild, cache commit/checkpoint, and bounded UI invalidations. | A terminal `current` generation publishes only after canonical index equality. Cancellation/restart/error leaves prior committed generation or explicit rebuilding state, never half-complete final UI. |

### Suggested state machine

`opening-shell → interactive-warming → reconciling | indexing → current`, with `degraded` only for observed watcher/cache failure and `rebuilding` for an authoritative fallback. Every state change includes `(vaultId, censusGeneration, indexGeneration, watcher stream/sequence status)`. The user-facing wording can stay simple; the protocol must not.

## Gap ledger

| Gap | Why it remains a gap | Impact / resolution needed before implementation |
|---|---|---|
| Exact remote Git source SHAs | Public GitHub API URLs were rejected by the browser gateway, and no clone/fetch is allowed. | If code extraction or line-level dependency attribution is proposed later, fetch a release tarball/revision through an allowed public-HTTPS discovery route and record the immutable SHA. This pass only adapts concepts. |
| Obsidian’s actual large-vault deferral implementation | Obsidian is proprietary; public forum reports are user/staff discussion, not source or an architecture spec. | Keep its 1.13.7 14,081 ms / 11,966 ms measurement as a compatibility baseline supplied by the charter, not an inferred internal design target. |
| Actual Threadleaf span attribution on the 207K vault | The measurement harness is being built by another lane and was not run in this read-only discovery pass. | Do not declare any ranked hypothesis proved until its spans and memory/IPC counters are captured on the real vault. |
| Markdown count, size distribution, directory fan-out, ignored file policy | Charter provides total vault files, not corpus shape. | Synthetic fixture must cover total entries, Markdown/non-Markdown mix, directory fan-out, symlinks/hidden/ignored policy, large files, and a rare-match/search case. |
| Current Linux watcher capacity and backend behavior | No host probe was run in this discovery report. | Harness should emit Node version, watcher backend evidence where available, system inotify limits, watch count, overflow/error count, and any scan reasons. Avoid premature dependency change. |
| SQLite driver/version/licensing/runtime compatibility | Threadleaf current source was inspected as TypeScript kernel; no dependency inventory or package execution was permitted. | A later dependency lane must select a pinned driver, verify its native/Electron compatibility and SQLite version, then decide `FULL`/`NORMAL` policy. No SQLite adoption is authorized by this report. |
| VS Code core file-index persistence contract | Source shows workspace-scoped storage but this pass found no authoritative public core index warm-start contract matching Threadleaf metadata index. | Do not attribute a particular cache invalidation design to VS Code. Use the explicit Threadleaf derived-cache contract above and test it locally. |
| Exact upstream fixes for incidents | VS Code #171435/#3961, Chokidar #1361, and the Obsidian forum thread show no linked repair commit on their pages. | Treat them as input-shape fixtures only. Closed status is not repair evidence. |

## Exhaustiveness statement

### Covered

This pass covered both requested tracks per seam where a usable public source existed:

- **Editor architecture / UI:** VS Code’s first-party tree architecture, Zed’s first-party performance post, Sublime’s official indexing material, Obsidian’s compatibility-relevant forum incident, and an existing Threadleaf renderer/kernel inspection.
- **Filesystem/event design:** Watchman subscription/cursor/settling semantics, Parcel Watcher coalescing and historical query contract, Chokidar/notify as bounded alternatives, Node `fs.watch` caveats, and Linux `inotify` overflow/rebuild rules.
- **Persistence/bulk load:** SQLite transaction, WAL, and synchronous durability contracts; VS Code storage contrast; ripgrep’s deliberately non-persistent, aggressively filtered traversal; Sublime’s persistent-index failure behavior.
- **Virtualization:** VS Code virtual tree, react-window/web.dev contrast, Zed’s UI-flood warning, and a local proof that Threadleaf already virtualizes DOM but not its all-files transfer/model.
- **Failure fixtures:** VS Code large watcher trees, Chokidar missed events, Obsidian workspace loading, Zed scheduling starvation, and a renderer-cache flood report.

### Two independent expansion passes and close condition

1. **Pass 1, product/incident direction:** VS Code, Zed, Sublime, Obsidian, Chokidar, and virtual-list prior art established two priority-0 candidate mechanisms: full-model renderer transport and monolithic completion before user work.
2. **Pass 2, platform/durability direction:** Watchman, Parcel Watcher, Node, `inotify`, SQLite, notify, and ripgrep tested whether a different watcher/index primitive changed the authority, disposition, risk, proof, or implementation order. It did **not** change the priority-0 result. It added hard constraints: no event stream is sufficient without reconcile, Parcel historical query is not uniformly cheap on Linux, and a persistent cache must be same-host/derived/transactional.

The decision gate is therefore closed: **first remove the all-vault workspace snapshot/IPC coupling and instrument the existing bootstrap; then decide whether bounded scan and persistent cache work are still required.**

### Deferred pass-2 families

- macOS FSEvents and Windows USN/ReadDirectoryChangesW backend-specific cursor contracts, because the chartered reproduction is local Electron on this host and no cross-platform watcher replacement is selected.
- Electron/Chromium structured-clone internal implementation sources, because the local IPC payload counter and renderer heap span are the executable proof needed before an engine-level hypothesis matters.
- Proprietary Obsidian internals and any exact release-fix provenance, unavailable through the permitted public source set.
- SQLite driver benchmarks and crash-recovery testing, because dependency selection/execution is explicitly outside this discovery worker’s authorization.

These are not silent omissions: none has been shown by two passes to alter the chosen authority boundary, first proof order, or the no-full-snapshot disposition.

## Fix-lane handoff order

1. Build/run the harness to partition the current 17-minute leg into bootstrap filesystem, parse/index, watcher-rescan, snapshot construction, IPC transfer, and renderer allocation/render spans.
2. Add a bounded interactive snapshot plus page/query contract, while retaining current authoritative kernel/reconciliation behavior. Land deterministic red fixtures for giant payload and stale page generation first.
3. Re-run cold/warm/incremental/TTUS/background completion on the real vault and synthetic 207K corpus. Compare against the chartered Obsidian reference as an external baseline, not a copied implementation target.
4. Only if cold filesystem/index spans remain material, implement bounded scanner scheduling and then evaluate a host-local derived cache. Only if watcher spans/reliability fail, evaluate a watcher backend change.

No code change is made by this report.
