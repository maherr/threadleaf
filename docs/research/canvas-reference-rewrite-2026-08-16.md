# Byte-local JSON Canvas attachment reference rewriting

**Last updated:** 2026-08-16 12:32:31 EDT

## Outcome

Threadleaf will rewrite valid local JSON Canvas `file` node paths and group `background` paths
during an explicit source-removing attachment **Rename or move**. The operation remains one
revision-bound, recoverable `moveWithWrites` transaction with the existing Markdown rewrites.

Only the exact JSON string token that carries a proven reference may change. A whole-document
parse-and-serialize pass is prohibited: UTF-8 BOM, line endings, whitespace, property order,
unknown fields, number spellings, and all unrelated bytes must remain exact. Comments, trailing
commas, duplicate object keys, malformed JSON, invalid UTF-8, oversized input, scanner/domain
disagreement, or an unsupported target spelling remain fail-closed.

This slice applies only to source-removing rename/move under the `ask` and `always` automatic-link
policies. The `never` policy still moves the attachment without rewriting references. The
source-retaining **Publish copy** behavior is unchanged.

## Decision gate

The previous attachment-rename slice already provides the complete reference corpus, exact Canvas
revisions, revision-bound confirmation digest, arbitrary UTF-8 child writes, journal recovery, and
source-removing rename. Its only intentional gap is replacing a Canvas reference without
normalizing unrelated JSON.

The decision question was:

> What is the smallest auditable parser seam that can identify effective JSON Canvas path values
> and replace only their source string tokens while preserving all other bytes?

## Primary evidence and disposition

| Seam | Primary evidence | Claim and rights boundary | Disposition |
| --- | --- | --- | --- |
| Canvas fields | [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) | File nodes carry a string `file`; group nodes may carry a string `background`. The open format defines fields, not a byte-editing implementation. | **Depend.** Rewrite only those two fields on domain-valid nodes. |
| JSON syntax and duplicate names | [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) | JSON strings have exact lexical spans; insignificant whitespace may appear around tokens. Object names should be unique because duplicate-name behavior is not interoperable. | **Depend** on strict JSON syntax. **Reject** duplicate keys for mutation rather than choosing a parser-specific winner. |
| Token offsets | [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser), MIT, pinned `3.3.1` | Its scanner and visitor expose token offsets and JSON paths without requiring document reserialization. JSON-with-comments support is broader than this contract. | **Depend** only on strict visitor/scanner offsets with comments and trailing commas disabled. Cross-check every candidate against Threadleaf's domain parser. |
| Source maps | [`json-source-map`](https://github.com/epoberezkin/json-source-map), MIT | It exposes JSON Pointer positions for parsed values. | **Reject for this slice.** It is viable, but the visitor/token API is a smaller fit for duplicate detection and exact literal replacement. |
| Lossless numeric JSON | [`lossless-json`](https://github.com/josdejong/lossless-json), MIT | It preserves numeric information across parse/stringify. | **Reject.** The required invariant is preserving every unrelated byte, not only numeric value fidelity. |

Package metadata was checked against the official npm registry: `jsonc-parser` version `3.3.1`, MIT
license, official Microsoft repository, and integrity
`sha512-HUgH65KyejrUFPvHFPbqOY0rsFip3Bo5wb4ngvdi1EpCYWUQDC5V+Y7mZws+DLkr4M//zQJoanu1SP+87Dv1oQ==`.

No proprietary application code, decompiled resource, bundled asset, or behavior observation is an
input to this decision.

## Saturation

Pass 1 covered the open JSON Canvas specification and RFC 8259. It fixed the authority boundary:
only `nodes[i].file` on a `type: "file"` node and `nodes[i].background` on a `type: "group"` node
are candidates, and duplicate keys must fail closed.

Pass 2 compared three permissively licensed parsing approaches. `jsonc-parser` is the only
candidate that directly supplies strict token offsets and paths without requiring full output
serialization. The alternatives did not change authority, risk, proof, or implementation order.
The decision gate is closed for this slice.

## Chosen contract

1. Parse the bounded bytes through Threadleaf's existing strict JSON Canvas domain parser.
2. Decode valid UTF-8, retain a leading BOM separately, and visit the strict JSON body with comments
   and trailing commas disabled.
3. Reject every duplicate property name within an object and every scanner or path mismatch.
4. Collect only string literal spans for the effective `nodes[i].file` and
   `nodes[i].background` fields, then cross-check their decoded values with the domain document.
5. Resolve each raw target through the existing Canvas attachment resolver. Standard vault-rooted,
   leading-slash, and explicit `./` or `../` forms may be rewritten. Query and fragment suffixes
   remain exact. Angle-bracket, backslash, invalidly encoded, or otherwise unproved forms block when
   they may name the source.
6. Encode the destination path segment-by-segment, replace complete JSON string tokens from the end
   of the document, and reattach the exact BOM.
7. Add the resulting Canvas content and revision to the existing `moveWithWrites` request. The
   confirmation digest and reference-corpus receipt therefore bind the exact proposal without a new
   kernel primitive.
8. A committed Canvas child write advances the active-payload epoch before the next workspace
   snapshot can publish.

## Required proof

- Red-green planner tests for file nodes and group backgrounds, root and explicit relative targets,
  suffix retention, exact preview locations, `ask`, `always`, `never`, and unchanged Publish copy.
- Exact-byte tests with BOM, CRLF, unusual whitespace, unknown fields, escaped strings, unrelated
  path-like values, and noncanonical number spellings.
- Fail-closed tests for duplicates, malformed or oversized Canvas, invalid URL encoding, unsupported
  spellings, domain/scanner disagreement, and concurrent corpus changes.
- Journal interruption and restart proof with Markdown and Canvas writes in the same parent
  transaction.
- Runtime proof that a pre-commit active Canvas payload cannot publish after the attachment write.
- Packaged X11 proof with real pointer and keyboard confirmation, visible Canvas location and exact
  before/after targets, byte manifest, truthful source-removal receipt, and light/dark screenshots.
- Full repository, public-content, and staged-scope gates before commit.
