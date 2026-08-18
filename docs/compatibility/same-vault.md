# Same-vault behavior corpus

The same-vault corpus is a deterministic, license-clean fixture for behavior that must survive
when the same files move between Markdown applications. It is a compatibility measurement, not a
claim that every application implements every case.

## Consume the corpus

The checked-in vault is at `fixtures/corpus/same-vault-v1/vault/`. `manifest.json` contains the
schema version, canonical relative paths, byte sizes, and SHA-256 digests. `cases.json` contains
the source paths, operation descriptor, expected result, allowed variance, public surface, and
`supported` or `unsupported` status for each case. `PROVENANCE.md` records that the fixture is
synthetic and contains no private vault or proprietary application data.

Copy `vault/` to a disposable directory before running a mutating case. A consumer should verify
the manifest first, treat Markdown and attachments as authoritative bytes, and leave `.obsidian/`
untouched. Case IDs are stable; transaction IDs, revisions, temporary paths, and diagnostic prose
are compared only where the case does not list them in `allowedVariance`.

Threadleaf's executable gate is:

```sh
pnpm run corpus:check
```

It checks every canonical digest and inventory entry, rejects stale case references, runs the
supported cases through the public kernel, application services, and CLI, compares full file bytes
for round trips, tests no-write and external-edit boundaries, and reports unsupported cases
separately. It uses temporary vault and state roots, so it never writes the checked-in fixture.

The canonical manifest includes a deliberate same-directory case collision. On a case-insensitive
checkout, the gate first proves that both names alias one filesystem object, validates the surviving
bytes against the collision group, reports only the ambiguity case as `platform-unrepresentable`,
and continues every independent case. The Linux lane materializes both names and executes the full
ambiguity behavior, so a native filesystem limitation is never mislabeled as a pass.

## Contribute a case

Add original bytes under the fixture vault, add a manifest entry with the deterministic SHA-256
digest and byte size, then add one case object with:

- a stable `id`, category, public `surface`, and `source.files` list;
- an explicit operation and expected resolution, mutation, or result;
- an `allowedVariance` list for values that cannot be stable across runs; and
- `support: "unsupported"` plus a reason when the behavior is not executable or not yet
  implemented. Unsupported evidence must never be presented as a pass.

Add a handler to `src/corpus/same-vault-corpus.ts`, run the targeted gate, `pnpm check`, and the
full corpus gate, and explain independent provenance in `PROVENANCE.md` when adding any non-code
source. Do not add proprietary fixtures, decompiled output, private vault material, generated
application state, or network-dependent observations. External-product observations may be added
as manual evidence in a separate provenance record, but must contain only independently recorded
behavior and no copied product output or assets.
