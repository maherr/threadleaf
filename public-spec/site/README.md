# Threadleaf public compatibility specification, version 1

Status: normative source for the versioned public contract.

This specification describes portable vault behavior, the desktop compatibility host, the
headless CLI, appearance discovery, reviewed migration preview and private-state transactions,
and exact-version plugin evidence. It is
implementation-neutral: another FOSS implementation can consume the machine-readable datasets
without importing Threadleaf internals or proprietary application code.

## Measured compatibility surfaces

The v1 contract names the current implementation surfaces rather than presenting one aggregate
compatibility score. The generated API dataset and conformance report bind each surface to an exact
Threadleaf version, source path, executable gate, and limitation.

The [current CLI contract](../../docs/cli.md) is headless and offline. Its command IDs, aliases,
syntax forms, exit codes, output formats, and authorities are regenerated from
`src/cli/command-line.ts` and the command table. A consumer must provide an explicit vault path;
the CLI does not use the desktop app's remembered vault.

The [same-vault corpus](../../docs/compatibility/same-vault.md) and the [Excalidraw corpus](../../docs/compatibility/excalidraw-roundtrip.md)
are independent CC0-1.0 synthetic corpora. Each has a license, provenance record, manifest, case
set, canonical vault files, and generated SHA-256 digests. The Excalidraw fixture also carries an
observation record for the official Obsidian protocol. Its status is `observed` for one pinned
official application, plugin release, settings pair, and corpus manifest. The record contains
exact identities, digests, isolation facts, behavior, and limitations without redistributing
official application output. It is external evidence, not an executable corpus pass.

The [migration contract](../../docs/compatibility/migration.md) covers a bounded read-only preview
and a separately reviewed apply transaction. Apply records source receipts and private-state
revisions, writes only private Threadleaf settings and workspace state, journals phases before
mutation, recovers unambiguous interruptions, and refuses newer-state rollback conflicts. Apply and
rollback do not write `.obsidian` or vault Markdown bytes and do not execute plugin code.

The [Live Preview contract](../../docs/compatibility/live-preview.md) keeps one canonical Markdown
document and a disposable source-to-rendered mapping. Live, Source, and Read modes preserve source
bytes and draft identity; ambiguous syntax becomes a source-visible fallback. [JSON Canvas](../../docs/compatibility/contract.md#same-vault-behavior-corpus)
has a separate byte-preservation and editing boundary. The workspace surface covers panes, pinned
tabs, docks, plugin pop-outs, application settings, and key bindings in private per-vault state,
with recovery and rollback checks in the [architecture](../../docs/architecture.md).

The [Markdown processor contract](../../docs/compatibility/open-plugin-api.md) measures fenced-code
replacement, ordered post-processing, source context, render-child lifecycle, and explicit failure
behavior in the trusted desktop compatibility runtime. The [package inspection contract](../../docs/compatibility/package-inspection.md)
checks exact assets, manifests, static authority evidence, bounded activation, registration,
cleanup, timeouts, and disposable-root diffs. It is not an OS sandbox.

The [native extension foundation](../../docs/compatibility/native-extensions.md) provides versioned
manifests, bundle and authority digests, per-vault grants, typed ports, revocation, safe mode,
deadlines, and teardown. The first host is in-process and reports `sandboxed: false`; production
bundle evaluation and OS process isolation are not wired into this foundation. Desktop navigation,
subprocess, secrets, and dynamic-code ports are trusted desktop escapes, not portable sandboxed
capabilities.

Excalidraw evidence is exact-release and workflow-scoped. The registry records the unchanged
Excalidraw release, its bundle digest, the Threadleaf version, and named open, create, save,
export, unload, reload, and settings workflows. This evidence does not imply universal plugin
parity, inline wiki-embed rendering, every export format, or a successful official Obsidian
round-trip.

## Version and URI policy

The specification identifier is `urn:threadleaf:spec:v1`. A consumer MUST select one specification
version and MUST NOT silently interpret a newer major version as this version. Dataset objects carry
both `schemaVersion` and the exact `threadleafVersion` used to generate the measured evidence.

The versioned source tree is the durable contract. A release may publish a rendered copy at any
static URL, but publication is a maintainer-authorized step and is not required to consume the
offline datasets. A patch release may correct wording or generated presentation without changing
the v1 schema. A change to field meaning, conformance levels, or byte semantics requires a new
specification version and a changelog entry.

## Conformance vocabulary

`MUST` and `MUST NOT` are normative requirements. `SHOULD` identifies a strong interoperability
recommendation that an implementation may document an explicit reason to omit. `MAY` is optional.

Normative claims are marked `normative` and must link to an executable gate, a fixture or evidence
source, and an exact Threadleaf version. Informative claims are marked `informative`; they explain
scope, provenance, or a known gap and never raise a conformance level.

Plugin compatibility levels are measured behavior, not a universal score:

| Level | Meaning | Minimum evidence |
| ---: | --- | --- |
| 0 | Discovered | A valid manifest and bounded bundle were found. |
| 1 | Loaded | The bundle evaluated and an instance was constructed. |
| 2 | Activated | `onload` completed without an uncaught error. |
| 3 | Integrated | Named commands, events, views, or processors registered. |
| 4 | Workflow verified | A named representative workflow passed end to end. |

An exact plugin release that has no production-path fixture remains level 0, even when another
release of the same plugin has evidence. A platform marked unverified remains unverified; packaged
smoke coverage does not become a workflow claim.

## Datasets and schemas

The generated [dataset index](data/index.v1.json) lists every machine-readable dataset and its
schema. The datasets are generated from the existing executable contracts and evidence sources:

- [API vocabulary](data/api.v1.json) describes classifications, compatibility levels, and the
  measured plugin authority vocabulary.
- [CLI contract](data/cli.v1.json) lists the versioned command IDs, native forms, exit codes,
  output formats, and source gates.
- [Theme contract](data/themes.v1.json) lists color-scheme choices, the versioned semantic token
  and non-color state-cue contract, asset identifiers, bounds, cascade order, and loader gates.
- [Fixture manifest](data/fixtures.v1.json) links both CC0 corpora to every canonical byte,
  license and provenance digest, and the explicit official Obsidian observation status.
- [Conformance report](data/conformance.v1.json) joins passing claims, gates, exact versions,
  and visible gaps.
- [Plugin registry](data/registry.v1.json) is the existing generated exact-version registry,
  copied without hand-written compatibility rows.

Schemas use local `urn:threadleaf:spec:v1:*` identifiers so validation works offline. A consumer
MUST resolve only the schema files named by the index and MUST fail closed on an unknown required
field or schema version.

## Evidence and provenance

Evidence that supports a compatibility claim comes from public API definitions, open file formats,
independently written fixtures, open-source plugin bundles, and executable behavior tests. Copied
proprietary application code or assets, redistributed extracted material, private vault bytes, and
network-only observations are excluded from this specification and its fixtures. Private study of
application internals may inform an independently authored architecture or product design, but it is
not compatibility evidence and cannot replace an executable behavior test. No extracted
implementation details are published through this specification. Every fixture contribution MUST
include a provenance statement and a license. The contribution workflow is documented in
[contributing.md](CONTRIBUTING.md).

The [conformance report](data/conformance.v1.json) keeps unsupported and not-verified behavior
visible. A gap is not a roadmap commitment and must not be rendered as a normative requirement.

## Consumer workflow

An implementation can consume v1 with no network access:

1. Read `data/index.v1.json` and confirm `uri`, `schemaVersion`, and the exact Threadleaf version.
2. Validate the datasets against the adjacent schemas.
3. Verify fixture paths and SHA-256 values before running a case.
4. Run only claims whose gates and source inputs are available, and report the exact scope.
5. Preserve `unsupported`, `not-verified`, and platform-limited results rather than converting them
   into passes.

The rendered site is a convenience view over these files. It does not add behavior that is absent
from a dataset or executable gate.
