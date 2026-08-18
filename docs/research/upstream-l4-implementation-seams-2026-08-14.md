# Threadleaf Level-4 plugin-bridge upstream mining

**Scope:** read-only discovery for `main` at the user-supplied baseline `f3f0270`. The local decision gate was read first: [Level 4 plugin bridges](../architecture/level-4-plugin-bridges.md), [native-extension compatibility](../compatibility/native-extensions.md), and `src/native-extension/marketplace-trust.ts`. Public HTTPS sources only; no source was cloned, fetched, installed, or executed. This report is the sole write.

## Executive decision

**No frozen-spec delta is warranted.** The local architecture has already made the authority decisions that matter: complete exact package identity selects a fixed reviewed profile, the static scan only denies, exactly one main-process resolver runs before any plugin bytes are resolved or evaluated, and a receipt is an honest co-privileged convention rather than an attestation against a hostile Node plugin.

Upstream materially improves three implementation details: use strict RFC 8785 canonicalization rather than the native-extension helper alone; borrow DSSE's type-confusion and verified-bytes discipline without changing receipt v2 into DSSE; and borrow TUF's names and regression fixtures for rollback, freeze, fast-forward, and mix-and-match. Platform extension systems confirm the process/provisioning shape, but none supplies an authority-profile model strong enough to replace the local exact-identity model.

### Local invariants preserved throughout

1. A static scan may deny only. It may never select a profile or grant reduced authority.
2. A checked-in, reviewed profile binds the **complete** exact package identity, including the sealed dependency tree; required and granted authorities are equal exactly.
3. `resolveConstructionPolicy()` is the one main-process construction-policy resolver on every load path, before module resolution/evaluation and without cached allows.
4. Receipts defend against drift, accident, and replay among co-privileged components. They do not attest against a hostile granted plugin.
5. Receipt v2 retains its frozen payload / issuer / signature schema, domain-separated JCS signing preimage, rotation and publication-race controls, honest-absence labels, and two-region layout.

**Disposition vocabulary:** Depend = pinned external implementation; Extract = copy a bounded behavior with attribution, no runtime dependency; Adapt = retain local interface while applying the pattern; Benchmark = test/failure fixture only; Reject = deliberately not used. `N` = normative standard, `I` = version-pinned implementation, `P` = official product documentation, `F` = first-party incident/account. “License N/A” means specification/prose, not code to incorporate.

## 1. Receipt envelope and signing

### Decision

**Keep the frozen receipt v2 envelope and signature preimage. Adapt DSSE verification discipline; reject a DSSE or in-toto envelope migration.** DSSE's useful insight is not its JSON wrapper. It is the fact that a verifier authenticates a typed sequence of opaque bytes, then hands the *same verified bytes* to the consumer. Threadleaf already has an explicit domain-separated preimage and a declared v2 schema. Replacing it with `payloadType`, base64 `payload`, and a signatures array would alter the frozen wire format, duplicate fields already carried in the local payload, and create no new protection in the stated co-privileged model.

Do not model a receipt as SLSA provenance: a receipt records one controlled compatibility run and registry publication, not an independently auditable software build. Do not adopt a Sigstore bundle: keyless certificates, transparency-log inclusion proofs, and a public witness model are all outside the local trust root. Its one-signature DSSE restriction is relevant only as a reminder that multi-signature semantics must never be improvised.

### Sources

| Source and track | Pin, license, status | Claim boundary |
|---|---|---|
| [DSSE protocol](https://raw.githubusercontent.com/secure-systems-lab/dsse/master/protocol.md) | v1.0.2, 2024-05-10; Apache-2.0 repository; N | Defines `Sign(PAE(UTF8(payloadType), serializedBody))`; `keyid` is an unauthenticated lookup hint; verifier must validate the type and provide the identical verified body to the application. The branch URL is not immutable, see gaps. |
| [DSSE envelope](https://raw.githubusercontent.com/secure-systems-lab/dsse/master/envelope.md) | v1.0.2, 2024-05-10; Apache-2.0 repository; N | JSON `payloadType`, base64 payload, and signatures. It is a transport convention, not a requirement to use JSON canonicalization. |
| [in-toto Statement v1](https://raw.githubusercontent.com/in-toto/attestation/main/spec/v1/statement.md) and [attestation spec](https://raw.githubusercontent.com/in-toto/attestation/main/spec/v1/README.md) | v1.2; Apache-2.0; N | Separates subject digest from a typed predicate and requires versioned type URIs. Unknown-field handling must never convert deny to allow. Useful vocabulary, not a receipt schema mandate. |
| [SLSA provenance v1.0](https://slsa.dev/spec/v1.0/provenance) / [v1.2](https://slsa.dev/spec/v1.2/provenance) | v1.0 retired; v1.2 current, Community Specification License 1.0; N | Defines builder/build-definition/run-details provenance. It does not define an authority decision for a locally loaded plugin. |
| [Sigstore bundle docs](https://docs.sigstore.dev/about/bundle/) and [Bundle proto](https://raw.githubusercontent.com/sigstore/protobuf-specs/main/protos/sigstore_bundle.proto) | Bundle v0.3; Apache-2.0 proto; N/I | Couples DSSE/in-toto payloads to certificates, timestamp/transparency evidence, and one DSSE signature. It is a public verification-material bundle, not a local receipt store. |

### Disposition, invariant, proof

- **Adapt:** DSSE's explicit type binding and “verify bytes once, consume those bytes” discipline. The local verifier should parse strictly, reject non-canonical raw bytes, calculate the payload and envelope hashes from those exact bytes, and never verify one parsed representation then act on a reparsed or reconstructed one.
- **Reject:** DSSE envelope, in-toto statement/predicate, SLSA provenance, and Sigstore bundle as receipt v2's wire format. **Invariant:** frozen v2 fields and domain-separated JCS preimage remain authoritative; key selection comes only from the local issuer trust policy, not a receipt `keyId` hint.
- **Required local proof:** byte-for-byte tamper, payload-type/domain confusion, untrusted-keyId, duplicate-key, signature-over-one-bytes/execute-another-bytes, and stale-signature tests. Verify the old/new issuer race and atomic non-replacing publication tests already required by the architecture. The receipt must still say `unavailable`, `not-verified`, or the specified honest absence state when evidence is absent, never imply hostile-plugin containment.

**Rejected alternative:** “DSSE is a standard, so receipt v2 should become DSSE.” This averages away a conflict. DSSE authenticates bytes elegantly but does not supply the local policy epochs, plugin identity, verifier recomputation, controller/harness identities, replay index, or publication transaction. A wrapper migration costs a frozen-protocol reopening and does not close a local threat-model gap.

## 2. Canonical serialization

### Decision

**Depend conditionally on `canonicalize@2.1.0`, behind a Threadleaf strict-JCS boundary. Do not hand-roll number and Unicode serialization; do not use `marketplace-trust.ts`'s generic `canonicalJson()` directly as the receipt boundary.** RFC 8785 makes the serialization rules unusually precise: ECMAScript number serialization, UTF-16 code-unit key ordering, UTF-8 output, no Unicode normalization, and rejection of non-finite values/lone surrogates. Its core warning is that a normal JSON parse may already lose information relevant to verification, especially duplicate members and oversized integers.

`canonicalize@2.1.0` is a small Apache-2.0 implementation with no runtime dependencies and implements the key sort and finite-number behavior. It is suitable only after an adapter admits **plain parsed JSON data**: it honors `toJSON`, serializes `undefined` / symbols permissively in arrays or objects, and cannot detect duplicate names once parsing has happened. Those properties are acceptable for general JSON output but unsafe as an unguarded receipt verifier input.

The local receipt restriction to strings, booleans, null, arrays, objects, and safe integers is stronger than generic JCS and should remain. In particular, reject floats even though JCS can represent them, and treat numeric values outside the safe-integer rule as strings before receipt construction.

### Phase 0 named residual

`receipt-strict-jcs` remains intentionally open. The authority-profile canonicalizers now reject `undefined`, but they are not an RFC 8785 receipt boundary: native `Date` and `Map` values collapse to empty objects, while non-finite numbers serialize as `null`. No receipt relies on these helpers in Phase 0. Before receipt implementation, add the strict plain-JSON and JCS adapter specified below and route signing and verification through that single boundary.

### Sources

| Source and track | Pin, license, status | Claim boundary |
|---|---|---|
| [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.txt) | RFC 8785, June 2020, Informational; IETF I-D / license N/A; N | Normative JCS algorithm: I-JSON constraints, no duplicate names, ECMAScript numbers, UTF-16 key sorting, no normalization, UTF-8. It explicitly requires rejecting invalid input rather than repairing it. |
| [`canonicalize` package manifest](https://raw.githubusercontent.com/erdtman/canonicalize/v2.1.0/package.json), [implementation](https://raw.githubusercontent.com/erdtman/canonicalize/v2.1.0/lib/canonicalize.js), [license](https://raw.githubusercontent.com/erdtman/canonicalize/v2.1.0/LICENSE) | `canonicalize` 2.1.0, Apache-2.0, no dependencies; I | Concrete short JS implementation: recursive sorting / `JSON.stringify`; rejects NaN/Infinity. Its `toJSON` and undefined behavior define its boundary, not the whole RFC validation problem. |
| Local `marketplace-trust.ts` | repository baseline `f3f0270`; local implementation; I | Existing Ed25519 native-extension signing pattern is the one to reuse for key ownership/rotation plumbing. Its generic canonical JSON helper is not itself a complete strict-receipt parser/validator. |

### Disposition, invariant, proof

- **Depend:** pin `canonicalize@2.1.0` with lockfile integrity, wrapped by a local `canonicalizeReceiptJson` / strict decoder that accepts only recursively plain JSON values allowed by receipt v2. The wrapper, rather than the dependency, owns duplicate detection, safe-integer enforcement, lone-surrogate rejection, schema validation, and `rawBytes === UTF8(canonicalize(parsed))` comparison.
- **Extract:** RFC 8785's conformance cases into local fixtures, including its number/key-order cases. Do not write a second serializer from memory.
- **Invariant:** receipt signing remains `UTF-8 JCS(payload)` and the existing domain-separated unsigned-envelope preimage. Existing native-extension signing key custody/rotation is reused; this finding does not create a second signing authority.
- **Required local proof:** fixture matrix covering non-BMP and astral keys, UTF-16 ordering, escaped control characters, lone surrogates, `-0`, finite/infinite/NaN, unsafe numbers, duplicate textual keys, `toJSON`, prototype-bearing input, undefined/symbol values, whitespace/order variants, and raw non-canonical but semantically equal JSON. Only canonical bytes sign or verify. A positive-control signature over a non-BMP-key payload and a negative control with the same object reordered on the wire are required.

**Rejected alternatives:** a bespoke serializer has a large invisible correctness surface; generic `JSON.stringify` has no key ordering; reusing the existing helper unmodified leaves permissive runtime-object paths and lacks strict parsing. The recommendation is conditional because package integrity / lock provenance must be verified during implementation, not inferred from this read-only pass.

## 3. Trust root, rotation, and replay

### Decision

**Adapt TUF's attack taxonomy and monotonic trusted-state pattern, not its full delegated-update system.** The checked-in `level4-trust-policy.v1.json`, issuer-trust identity, controller manifest identity, pre-publication re-read, receipt tuple, and replay index are the right single-user, co-privileged equivalent of a small trusted state machine. Treat old but valid evidence as a **rollback**; a receipt/policy combination from different coherent states as **mix-and-match**; and an attacker forcing absurdly high local epochs as a **fast-forward** case. “Freeze” means evidence/registry freshness has stopped advancing, but it does not need a TUF online timestamp role while Threadleaf does not consume remotely published, expiring metadata.

### Sources

| Source and track | Pin, license, status | Claim boundary |
|---|---|---|
| [TUF specification](https://github.com/theupdateframework/specification/blob/master/tuf-spec.md) | v1.0.35, 2026-07-15; Community Specification License; N | Names rollback, freeze, fast-forward, and mix-and-match attacks. Root/targets/snapshot/timestamp roles, version monotonicity, expiration, and hash/length binding protect a remote update channel. |
| [python-tuf updater](https://raw.githubusercontent.com/theupdateframework/python-tuf/v7.0.0/tuf/ngclient/updater.py) and [license](https://raw.githubusercontent.com/theupdateframework/python-tuf/v7.0.0/LICENSE) | `python-tuf` v7.0.0; source files MIT OR Apache-2.0; I | Concrete root -> timestamp -> snapshot -> targets ordering and locally trusted metadata handling. It is a benchmark, not a Node dependency or a suitable local authority resolver. |

### Mapping and boundary

| TUF concept | Threadleaf mapping | Disposition / boundary |
|---|---|---|
| Root role and root rotation | checked-in policy plus issuer/controller trust identities and explicit rotation/revocation | **Adapt.** One reviewed local root, no threshold/delegation machinery. |
| Targets metadata | exact reviewed package identity, authority profile, sealed tree, and receipt assertions | **Adapt vocabulary only.** The receipt is not a remote target file. |
| Snapshot consistency | coherent policy/profile/scanner/build/receipt snapshot; re-read immediately before registry publish | **Adapt.** Add explicit mix-and-match fixture coverage. |
| Timestamp expiry / freeze protection | current policy and receipt freshness controls | **N/A by scope.** No online metadata channel or remote freshness promise exists. Adding timestamp fetch/expiry would broaden the frozen model. |
| Rollback | older valid policy/profile/issuer/receipt/registry cannot become current | **Adapt.** Replay index and generation/epoch checks must be monotonic. |
| Fast-forward | forged or accidentally excessive generation/epoch forces later valid state to look old | **Adapt as a local sanity fixture.** Bound / validate transitions; do not use untrusted receipt values as the current counter. |

### Disposition, invariant, proof

- **Adapt:** TUF names and fixtures: rollback, freeze, fast-forward, and mix-and-match. **Invariant:** local current policy is authoritative, and a rotation/revocation between verification and publication produces no accepted registry row.
- **Benchmark:** `python-tuf` ordering and metadata state handling, only to challenge the local transaction model. Never Depend: Python-TUF's remote roles, download metadata, delegation, and expiration semantics would be dead surface here.
- **Required local proof:** reject a correctly signed receipt under a revoked issuer; reject a valid old profile/tree/controller tuple; splice receipt A's signature/evidence with receipt B's identity/epoch; mutate policy between verification and publish; replay nonce/run ID/hash; force a large untrusted generation and prove it cannot brick later legitimate evidence; and show an unavailable receipt is excluded with an honest label rather than treated as success.

**What TUF adds to the local naming:** the spec already addresses rollback and replay-like stale state. It should name and test **mix-and-match** explicitly if not already a named fixture, and distinguish **fast-forward** from ordinary rollback. A true remote **freeze** defense is deliberately N/A, not an omission: no remote release metadata is in the local protocol.

## 4. Authority and permission profiles

### Decision

**Adapt the checked-in, schema-versioned capability-file ergonomics of Tauri and Deno, while retaining Threadleaf's much stronger exact-identity binding.** A `ReviewedAuthorityProfile` should be a versioned JSON schema and reviewed artifact, but cannot inherit Tauri's permission merging, a browser extension's update-prompt model, or VS Code workspace trust as an authorization mechanism. None binds a permission profile to the complete main + styles + sealed dependency-tree digest and scanner agreement as the local charter requires.

### Sources

| Source and track | Pin, license, status | Claim boundary |
|---|---|---|
| [Deno permissions](https://docs.deno.com/runtime/reference/permissions/) and [Deno license](https://raw.githubusercontent.com/denoland/deno/v2.6.0/LICENSE.md) | current docs accessed 2026-08-14; implementation license MIT; P | Deny by default, explicit allow/deny flags, no prompt in noninteractive contexts, scoped permissions/audit behavior. It offers invocation policy, not package-identity-bound reviewed profiles. |
| [Tauri v2 capabilities](https://v2.tauri.app/security/capabilities/) and [Tauri v2.0.0 MIT license](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.0.0/LICENSE_MIT) | v2 docs, page updated 2025-08-01; MIT; P/I | Checked-in JSON/TOML capabilities, `$schema`, window/webview selectors, permission identifiers, platform scopes. Capabilities may merge permissions: directly incompatible with fixed exact authority. |
| [Chrome Manifest V3 permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) | current official docs; prose CC-BY 4.0 / samples Apache-2.0; P | Declared, optional, and host permissions with user warnings on broadened host patterns. Update approval is user-facing, not an exact binary identity contract. |
| [Firefox WebExtension permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions) and [optional permissions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/optional_permissions) | current MDN; documentation license not independently verified here; P | Runtime grant/revoke and manifest permission model. Behavioral reference only; no code reuse. |
| [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust) | current official docs; prose license not independently verified here; P | Restricted-mode compatibility declaration can include an extension `version`, but docs state workspace trust cannot prevent a malicious extension from executing or ignoring the mode. |

### Disposition, invariant, proof

- **Adapt:** publish `ReviewedAuthorityProfile` through a local JSON Schema with `schemaVersion`, profile revision, exact package identity/digest, expected static capabilities, required authorities, execution profile, and allowed platforms. Validate it deterministically before construction. `$schema` is tooling, not authority; the content digest and exact identity remain authority.
- **Reject:** capability merging, optional runtime grants, user prompts, version-only compatibility declarations, and “workspace trusted” as evidence that a plugin is safe. **Invariant:** only complete package identity picks one fixed profile; scanner results can only produce mismatch/deny; grant set equals required set.
- **Required local proof:** missing profile, changed dependency with unchanged main, changed styles, altered distribution tag, profile revision change, stale package digest, wrong platform, scan failure, scan omission, and scan-added capability all deny before module resolution. A direct diagnostic/test loader must also deny. Assert no scan result can select a profile and no profile merge can increase authority.

**Profile-versus-binary mismatch answer:** platform systems mostly defer it to extension signing/review/update prompts or version matching. That is insufficient for Node-capable Threadleaf bridges. The local sealed-tree + complete-identity + exact-equality construction policy is the correct stricter response.

## 5. Extension-host construction, provisioning, and lifecycle

### Decision

**Adapt the structural separation of controller/main process, host process, and renderer provisioning. Benchmark Figma's escape incidents as regression fixtures. Reject any implication that a renderer, Realm, iframe, utility process, or workspace-trust label converts a granted Node plugin into an untrusted security principal.**

VS Code supports the local answer that extensions belong outside the UI process and start only on activation. Electron supports a narrow `contextBridge` data/call boundary and warns that Node-integrated code is inherently privileged. Obsidian supports lifecycle registration/disposal discipline. Figma supplies the crucial negative lesson: cross-boundary object identity, prototypes, and “small shims” produce escapes; a real sandbox transition may be necessary, but it does not cure an intentionally trusted desktop-escape profile.

### Sources

| Source and track | Pin, license, status | Claim boundary |
|---|---|---|
| [VS Code extension hosts](https://code.visualstudio.com/api/advanced-topics/extension-host) and [extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy) | current official docs; prose license not independently verified here; P | Local/remote/web host locations, extension-host isolation from workbench UI, manifest/activation model. It does not make an installed Node extension adversarially safe. |
| [VS Code commands implementation](https://raw.githubusercontent.com/microsoft/vscode/1.104.0/src/vs/platform/commands/common/commands.ts) and [license](https://raw.githubusercontent.com/microsoft/vscode/1.104.0/LICENSE.txt) | VS Code 1.104.0; MIT; I | Registry holds a per-ID linked list and resolves the newest handler. This is an implementation conflict, discussed in seam 6, not a pattern to adopt. |
| [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process), [license](https://raw.githubusercontent.com/electron/electron/v31.0.0/LICENSE) | current docs, Electron source v31.0.0 license MIT; P/I | Node code is arbitrary-code execution; context isolation / sandboxing and narrow bridges matter for untrusted renderers; `UtilityProcess` is a separate Chromium child with Node integration, not a different OS authority. |
| [Figma plugin-system history](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/) | 2019 official engineering account; prose license N/A; F | Documents iframe-to-Realms evolution, whitelisting, factory functions inside the Realm, and null-origin UI iframe/message boundary. |
| [Figma plugin-security update](https://www.figma.com/blog/an-update-on-plugin-security/) | 2019 official incident account; prose license N/A; F | Realms shim escapes led to disabled publication/update and migration to QuickJS WASM; manual review was explicitly not a security boundary. |
| [Figma current plugin runtime](https://developers.figma.com/docs/plugins/how-plugins-run/) | current official docs; prose license N/A; P | Plugin code runs in a sandbox and UI in an iframe. Useful contrast only. |
| [Obsidian load-time lifecycle](https://docs.obsidian.md/plugins/guides/load-time) and [events lifecycle](https://docs.obsidian.md/Plugins/Events) | current official docs; license / exact rendering revision gap; P | `onload`, layout readiness, and registration helpers that clean up on unload. Compatibility lifecycle reference, not a security model. |

### How this changes implementation

1. **Pre-construction policy:** it changes *how*, not *whether*. Retain one resolver before plugin module resolution/evaluation. Make every host/renderer allocation traceable to the resolver decision and coherent policy epoch. VS Code activation must not become an alternate implicit loader.
2. **Renderer provisioning:** after an allow, allocate a fresh profile-aware renderer/host for authority-bearing code. A deny gets no package path or package bytes. On revoke, stale epoch, reload, crash, or renderer death, destroy rather than reuse. A utility process may be an implementation vehicle, but it changes no authority conclusion.
3. **Capability injection:** expose typed, serializable requests/observations and narrowly proxied functions only. Never pass live objects, classes, prototypes, generic IPC, a raw Node capability, or a policy resolver to plugin code. The fixed `trusted-desktop-escape` label remains honest when Node/subprocess capability is intentionally granted.
4. **Compatibility lifecycle:** after the policy gate, arrange host registration in the documented lifecycle order and make unload/revoke disposal idempotent. This is a behavior/cleanup compatibility obligation, not evidence of confinement.

### Disposition, invariant, proof

- **Adapt:** VS Code activation and separate-host shape; Electron bridge/utility process primitives; Obsidian registration/unload lifecycle. **Invariant:** only the main resolver chooses authority and only before construction; every allowed authority-bearing instance is fresh and policy-bound.
- **Benchmark:** Figma incidents. Add fixtures attempting prototype/function/live-object leakage through the bridge, stale host reuse after deny/revoke, and a purported “reviewed” plugin executing outside its supplied authority descriptor. The expected outcome is bridge rejection / no construction, not a claim that Node is sandboxed.
- **Reject:** Realm/iframe/QuickJS as a substitute for local policy; broad `ipcRenderer` exposure; extension-host process separation as proof of different OS identity; and any runtime fallback loader that bypasses policy.
- **Required local proof:** instrument every listed load path (initial, explicit reload, recovery, renderer-death restore, restart reconstruction, diagnostics, tests) and prove one resolver invocation before any source-byte/module-resolution event. Test fresh allocation after allow, destruction on every invalidation, no package path/bytes on deny, serializable bridge-only payloads, lifecycle unload cleanup, and controller derivation of terminal state from bounded observations only.

## 6. Command identity and wedge-5 repair

### Decision

**Confirm the qualified dispatch identity design. Keep command identity as a typed qualified pair, not a globally unqualified command string, and reject ambiguous registration.** VS Code's public convention is publisher/extension-style namespacing such as `myExtension.sayHello`; its public API says command identifiers must be unique and duplicate registration errors. The pinned internal registry contradicts that public contract by storing a linked list and returning the most recently registered handler. Threadleaf must not copy that shadowing behavior.

Use the wedge-5 qualified identity already being implemented as the canonical dispatch key. Internally preserve its components `(plugin identity or stable plugin ID, command ID, applicable revision/epoch)` rather than relying only on a delimiter-concatenated string. A command descriptor created under an older identity/revision must not dispatch into a newly loaded package with a coincidentally equal human command name.

### Sources

| Source and track | Pin, license, status | Claim boundary |
|---|---|---|
| [VS Code command guide](https://code.visualstudio.com/api/extension-guides/command) and [API reference](https://code.visualstudio.com/api/references/vscode-api) | current official docs; prose license not independently verified here; P | Shows extension-qualified command IDs and says `registerCommand` requires a unique command identifier / errors on duplicate registration. |
| [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy) | current official docs; prose license not independently verified here; P | Publisher plus extension name is the unique extension identity, giving the conventional namespace source. |
| [VS Code 1.104.0 command registry](https://raw.githubusercontent.com/microsoft/vscode/1.104.0/src/vs/platform/commands/common/commands.ts) | 1.104.0, MIT; I | Concrete conflict: same raw ID registrations form a stack and lookup returns the newest. This cannot be treated as a dependable collision policy. |

### Disposition, invariant, proof

- **Adapt:** namespacing, but strengthen it to Threadleaf's exact plugin identity and policy revision semantics.
- **Reject:** raw unqualified IDs and last-registration-wins stacks. **Invariant:** qualified dispatch is bound to the reviewed identity/profile policy, and a command never supplies a separate authority path.
- **Required local proof:** two plugins expose the same human command ID and dispatch only to their qualified owner; a duplicate qualified registration fails deterministically rather than shadows; reload/revocation invalidates stale command descriptors; a changed package tree under the same plugin ID cannot retain old dispatch; and malformed delimiter-like identifiers cannot collide with another typed pair.

## Phase 0 UI residual

`catalog-settings-authority-states` remains out of scope for this repair. Phase 0 preserves typed construction refusals in the main-process log and inspection diagnostics, but it does not yet render the frozen spec's five explicit catalog/settings states: exact-package host-process permission required, stale permission, revoked permission, scan/profile mismatch, and platform unavailability from `child_process`. No current UI is claimed to satisfy that requirement.

## Ranked, spec-compatible implementation refinements

1. **Depend on `canonicalize@2.1.0` only behind a strict receipt-JCS adapter**, pinned with integrity. The adapter validates data before canonicalization and rejects raw noncanonical / duplicate / unsafe / runtime-object input. This is the highest-risk implementation seam because signature correctness depends on bytes.
2. **Add a DSSE-derived verified-bytes/type-confusion test family** to receipt verification: exact original bytes only, fixed domain/version, `keyId` never authorizes, and no parse-verify-reconstruct gap. Adapt the discipline, not the DSSE envelope.
3. **Name and fixture TUF-style mix-and-match and fast-forward cases** beside the existing rollback/replay/rotation controls. Especially prove an independently valid signature and an independently valid identity cannot be spliced into one accepted current receipt.
4. **Publish a local JSON Schema for `ReviewedAuthorityProfile` v1** and validate it as data, with deterministic digest calculation. Preserve one profile, exact required/granted equality, no merge, and complete package identity.
5. **Add Figma/Electron bridge-negative fixtures:** reject prototype-bearing values, functions outside explicit narrow bridge endpoints, raw generic IPC, and stale renderer/host reuse. Record that success means no construction or no dispatch, not “sandboxed Node.”
6. **Make qualified command collision and stale-revision tests mandatory** for wedge-5: two same-name commands, duplicate qualified registration, policy/tree change, revocation, and delimiter collision.

## Delta requiring frozen-spec reopening

**None.** The tempting deltas are rejected: changing receipt v2 to DSSE/in-toto, adding Sigstore transparency/keyless PKI, importing full TUF roles/timestamps, selecting profiles from scan output, merging permissions, or claiming renderer/process isolation contains a Node-capable plugin. Each either conflicts with the frozen authority model or adds remote/multi-party machinery with no stated threat-model benefit.

## Gaps ledger

1. DSSE's public protocol/envelope pages were version-labelled 1.0.2 but served from a moving `master` raw URL. Before vendoring/reusing prose or tests, pin the exact upstream commit / release artifact. No DSSE code dependency is recommended.
2. `canonicalize@2.1.0` source and license were inspected, but this read-only pass did not inspect Threadleaf's package-lock/integrity state or download a tarball. Integration must verify the resolved package integrity and license metadata in the actual lockfile.
3. Deno, Tauri, Electron, VS Code, Chrome, Firefox, and Obsidian documentation pages are mostly current, unversioned product docs. They support architecture/behavior claims only. Pin the actual Electron/Obsidian/API runtime version at implementation and receipt-harness time.
4. The direct Obsidian API-reference pages were not readable through the public fetch route; the public load-time and events pages supplied lifecycle evidence. Exact host API compatibility remains an implementation-time verification item.
5. Firefox/MDN prose licensing was not independently verified; it is used only as a behavior reference, not for copied implementation.
6. No formal COSE/JWS/CBOR, TPM/remote-attestation, transparency-log, package-publisher, or proprietary runtime deep dive was performed. Those families become relevant only if the local model adds remote receipt distribution, separate OS principals, hardware-backed keys, or hostile-plugin attestation.

## Exhaustiveness statement and stop gate

Two bounded independent public-HTTPS passes were completed.

- **Pass 1, standards / supply-chain family:** DSSE, in-toto, SLSA, Sigstore bundles, RFC 8785 JCS, a concrete JS canonicalizer, TUF specification, and a TUF client implementation. Queries and source classes covered attestation envelopes, signing preimages, JSON canonicalization, trust-root rotation, replay, rollback, fast-forward, freeze, and mix-and-match.
- **Pass 2, platform / extension-host family:** Deno, Tauri v2, Chrome/Firefox extension permissions, VS Code extension host/commands/workspace trust, Electron security/context bridge/utility process, Figma architecture and published sandbox-escape response, and Obsidian lifecycle documentation. Queries and source classes covered profile-file schemas, permission mismatch/update behavior, host construction, bridge injection, lifecycle, and command collisions.

Within these families, the second pass did not produce a candidate that changes local authority, disposition, proof burden, or implementation order. The remaining gaps are named above rather than treated as clean results. The declared discovery gate is therefore closed for this L4 report; the omitted families are explicitly reserved for a pass 2 only if the threat model changes.
