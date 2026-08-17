# Level 4 Plugin Bridges

**Status:** Phase 0 receipt substrate implemented; production bridges and workflows not started
**Scope:** Style Settings 1.0.9, Calendar release `2.0.0-beta.2` with manifest `2.0.0`, and Templater 2.25.0  
**Last updated:** 2026-08-17

## Executive decision

Threadleaf should implement three narrow compatibility bridges around the existing isolated community-plugin renderer. It should not weaken the isolation model, imply that the renderer is a security sandbox, or generalize these bridges into a claim of complete Obsidian compatibility.

1. The Style Settings bridge makes Threadleaf's authoritative appearance CSS available as real source text inside each isolated renderer, provides the renderer's actual `window` as `activeWindow`, and synchronizes appearance changes before emitting `css-change`.
2. The Calendar bridge makes workspace regions physical, projects Threadleaf's daily-note settings through a truthful `daily-notes` internal-plugin facade, and streams authoritative vault changes into a stable in-renderer file tree. It also adds deterministic static traversal and a private fold-state store.
3. The Templater bridge admits only the complete exact package identity named by a fixed, checked-in, reviewed authority profile. The main process resolves a fresh construction policy before every execution attempt. A static capability scan can tighten or deny that policy, but can never select a less-authoritative execution mode. If the profile, complete staged package closure, grant, scan, safe-mode state, platform, or current policy epoch does not match, unchanged Templater 2.25.0 is unavailable as a whole. If every input matches, Templater runs as a trusted desktop escape and gains the settings, confirmation, local-storage, and hotkey surfaces needed by its named workflow. CodeMirror editor-extension and CLI delivery remain explicitly unavailable in the first Level 4 scope.

Level 4 is an evidence state, not a side effect of invoking a command. It is awarded only to an exact package identity whose named production workflow reaches an asserted terminal state and still works after the compatibility renderer and application state have been reconstructed.

The Phase 0 evidence-integrity substrate is now implemented in the script-only controller, verifier, strict receipt boundary, artifact builders, replay index, and registry publication path. The production trust policy has no issuer key, so no current real plugin can receive Level 4 from this milestone. The hermetic fixture workflow proves the path with an ephemeral key in a private temporary directory; its isolated Level 4 row never enters the checked-in registry. Style Settings, Calendar, and Templater behavior remain later work.

## Inputs and current architecture

This design was implemented from the required `main` baseline `bdff2adb27ba4768ad6ede8c5832ae923c6b059b`, the compatibility contract, the upstream saturation report, the 2026-08-14 plugin-wedge matrix, the exact upstream releases named above, and the current native-extension capability host.

That baseline already includes these wedge foundations:

- Wedge 1 landed workspace and file-manager shims with a real-leaf construction brand, honest preference throws, `OpenViewState` propagation, and refusal before mutation in `renameFile`.
- Wedge 2 landed an honest internal-plugin registry and tests. Its `daily-notes` entry remains disabled and has no instance or options surface.
- Wedge 4 landed host-conformant metadata, link, and YAML helpers with tests: `Vault.getAllFolders()`, `Vault.getAvailablePath()`, `parseFrontMatterTags`, `getAllTags` and inline-tag cache positions, `parseLinktext`, `getLinkpath`, `getFirstLinkpathDest`, `stringifyYaml`, and `prepareSimpleSearch`. `FileManager.processFrontMatter` remains absent, so Lane 6 is still required.
- Wedge 3 landed candidate vault-adapter `write`, `mkdir`, `copy`, and `getFullPath` behavior, tests, and a candidate contract document. The contract is an implementation input, not a compatibility or release claim.

The bridge work below extends those landed surfaces rather than recreating them. `FileManager.processFrontMatter` remains absent on this baseline, so Lane 6 is still required.

The exact wedge targets are:

| Plugin ID | Distribution tag | Manifest version | Wedge `main.js` SHA-256 |
|---|---|---|---|
| `obsidian-style-settings` | `1.0.9` | `1.0.9` | `1828abaacdab4c5578b705a625c585b30512f8efad4c7cfc5a18e70cc3557468` |
| `calendar-beta` | `2.0.0-beta.2` | `2.0.0` | `64d1c6c620803246724bc922c5c2e0a17c406ffc23f6bbcfbfb14c643958fbb7` |
| `templater-obsidian` | `2.25.0` | `2.25.0` | `6a29790e8ad3bb3de5bcc7381588f20093b2dbecc1ff27d8a5d7ed3fcebbdf4e` |

The relevant runtime path is:

```text
reconcileCompatibilityPlugins
  -> WorkspaceRuntime.loadPlugin
  -> IsolatedPluginRuntime.loadPlugin
  -> ElectronPluginRuntime.loadPlugin
  -> PluginRendererService.handle("load-plugin")
  -> PluginHost.loadPluginUnsafe
  -> evaluatePlugin
  -> new PluginClass(app, manifest)
  -> plugin.__load()
```

Each compatibility plugin executes in a Node-enabled `WebContentsView` with `contextIsolation: false` and `sandbox: false`. The main Threadleaf renderer remains sandboxed. This is useful process and DOM separation, but it is not a capability sandbox: an enabled plugin can use Node directly once its bundle is evaluated. The native-extension host provides useful vocabulary and lifecycle precedent, especially exact-byte grants, `trusted-desktop-escape`, and typed `capability-unavailable` failures. It does not make a community-plugin renderer capability-governed.

There are six current seams that matter:

- Environment seam: `registerCompatibilityPluginView(view)` in `src/main/main.ts` applies theme, plugin `styles.css`, and accessibility CSS to a newly created compatibility view. It is creation-oriented and does not carry a typed, live environment snapshot through the plugin-runtime protocol.
- Construction seam: `PluginHost.loadPluginUnsafe()` in `src/runtime/plugin-host.ts` validates and evaluates the bundle before constructing the plugin. Authority-sensitive policy must arrive and be validated before `evaluatePlugin`, because top-level bundle code can execute before the constructor.
- Surface seam: `PluginSurfaceSnapshot` and the current main-process attachment state model one visible plugin surface. `Workspace.getRightLeaf()` can therefore be semantically present while the view still occupies the main plugin surface rather than a physical right dock.
- Workspace and file-manager seam: the landed Wedge 1 shims already establish honest leaf construction, preference failures, `OpenViewState` propagation, and pre-mutation rename refusal. The bridge must preserve those contracts while adding the named Calendar and Templater behaviors.
- Vault-adapter seam: the landed Wedge 3 candidate supplies `write`, `mkdir`, `copy`, and `getFullPath`. Remaining operations, event coherence, receipts, and rollback behavior must extend that implementation and its candidate contract.
- Internal-plugin seam: the landed Wedge 2 registry is truthful about absence. Calendar and Templater need the disabled `daily-notes` record extended into a truthful enabled facade backed by Threadleaf settings, not a second registry.

The design extends those seams. It does not add a second community-plugin execution model.

## Terms and invariants

### Named production workflow

A named production workflow is a versioned, user-visible sequence for one exact plugin release. It identifies its starting state, user inputs, expected vault and private-state changes, visual or editor result, cancel behavior, and post-reload result. A workflow is narrower than "the plugin works."

Examples:

- Style Settings: discover one enabled snippet's declarations, change one declarative control, observe the actual computed style, then reproduce both control state and computed style after reload.
- Calendar: create and delete a daily note through production paths while the calendar is physically mounted in the right dock, and observe the day markers update and persist after reload.
- Templater: configure a template hotkey through the declarative settings surface, invoke it through a real keyboard event in an active note, verify final note bytes, then repeat after reload.

### Exact package identity

Evidence and authority bind to all of the following:

```ts
interface ExactPluginPackageIdentity {
  pluginId: string;
  manifestVersion: string;
  distributionTag: string;
  manifestSha256: string;
  mainSha256: string;
  stylesSha256: string | null;
  packageTreeSha256: string;
}
```

For ordinary releases, `distributionTag` and `manifestVersion` will normally match. They are not aliases. Calendar demonstrates why both must be retained.

`packageIdentityDigest` is the SHA-256 of the RFC 8785 canonical JSON serialization of this complete structure. Field-by-field equality and the digest must both match. `packageTreeSha256` covers the normalized, sorted manifest of every regular file in the distribution package, including every locally resolvable JavaScript, JSON, WebAssembly, and native-addon candidate. Mutable plugin data, host caches, and grant files are not part of the distribution tree and are never module-resolution inputs.

An identity is descriptive until the main process has staged and sealed that complete tree. Execution may resolve modules only from the sealed, content-addressed package root associated with the identity. A matching `mainSha256` by itself is never an executable identity and is never sufficient for a grant, policy, receipt, or load decision.

### Production path

"Production" means the unchanged release package is copied into its verified sealed execution root and loaded from there through the packaged Electron loader, real isolated renderer, real main renderer, real workspace runtime, and real revision-checked vault writer. A direct call to a plugin callback, a unit test of the shim, or a synthetic command invocation is supporting evidence, not Level 4 evidence.

### Reload

Reload means all state that could make the result accidentally pass in memory has been discarded. At minimum the plugin view and its isolated renderer are destroyed and recreated. If the workflow depends on main-process private settings, window layout, capability policy, or host-local storage, the test restarts the application as well. Reopening a view within the same renderer is not a reload-persistence proof.

## Level 4 evidence contract

### Problem

`PluginHost.runCommand()` currently promotes a plugin summary to compatibility level 4 after a command callback returns and vault mutations settle. A canceled picker, a confirmation dialog closed without action, or a command that completes only its first phase can therefore overclaim Level 4. The command return is merely an observation that control came back.

### Decision

Runtime command execution must never assign Level 4. Runtime observations may support lower compatibility diagnostics, but Level 4 comes only from a controller-finalized and verifier-accepted evidence record for an exact package and effective Threadleaf build. In the current same-user deployment, that separation is a reproducibility and integrity convention, not a hostile-process security boundary.

Each controller-run named workflow has this terminal state machine:

```text
not-started -> started -> completed
                      -> canceled
                      -> failed
                      -> timed-out
```

Only the controller-derived `completed` state is eligible. `canceled`, `failed`, `timed-out`, missing assertions, unsupported delivery, or an ambiguous terminal state are non-passing results. A callback resolving, a command returning a string, a modal closing, a runtime observation claiming success, or the absence of an exception does not imply `completed`.

### Required evidence receipt

The evidence registry advances from the current declaration-oriented v1 shape to a signed, receipt-bearing v2 shape. Receipt signing and verification provide structured integrity within the declared co-privileged operating model; they do not create a security boundary from an already granted Node plugin.

#### Receipt threat model and controller boundary

The controller, verifier, packaged application, and a granted `trusted-desktop-escape` plugin share an OS identity and writable filesystem in the current Level 4 design. Receipts therefore defend against drift, accidental corruption, partial runs, stale replay across builds or evidence-tool revisions, and non-malicious divergence between the runtime, workflow harness, and catalog. They do not defend against a malicious community plugin after Node authority has already been granted. Such a plugin can potentially alter or invoke the controller, trust policy, replay index, attempt records, or receipt paths available to that user.

That malicious-plugin threat is handled entirely at grant time: a fixed checked-in authority profile, complete executable-closure identity, sealed exact package tree, explicit grant and revocation state, and denial on any profile, identity, scan, epoch, or platform mismatch. Receipt evidence is not a second sandbox, an attestation against the granted plugin, or a substitute for that pre-construction decision.

A dedicated controller process, launched outside the packaged Electron application and outside every community-plugin renderer, is the only receipt finalizer in the supported workflow. The controller executable, harness, and versioned schema are hashed. The signing key is not embedded in or imported by the packaged application, runtime, workflow fixture, or registry generator. This process and code separation reduces accidental self-promotion, but same-user file placement or permissions are not claimed as protection from deliberate co-privileged Node code.

The controller creates a cryptographically random 256-bit `runNonce` and unique `runId`, launches the exact packaged application under test, and owns the append-only observation channel. Runtime code may emit only schema-bounded raw observations tied to that nonce and a monotonic observation sequence. It may not emit a terminal state, write a receipt envelope, write to the final receipt directory, update the evidence registry, or request a compatibility-level change. The controller derives terminal state from its assertion plan, direct filesystem and process probes, UI automation results, renderer lifecycle observations, and bounded runtime observations. A runtime observation is evidence for an assertion, never authority to mark that assertion or workflow complete.

Under the supported workflow, runtime code has no finalization or publication API. A production workflow may be instrumented by the runtime, but the controller alone derives whether the observations satisfy the predeclared workflow. This is a structural application invariant for ordinary operation, not a tamper-proof guarantee against an already granted malicious plugin.

**Optional future boundary upgrade, not required for the current Level 4 claim:** running the issuer under a separate OS user with non-inherited credentials and ACLs, or on a separate host or CI signer, would create an enforceable authority boundary and support a stronger evidence claim. That deployment is deliberately out of scope here.

#### Receipt v2 payload

Every v2 payload contains at least:

- `schemaVersion: 2`, workflow ID, workflow-definition hash, fixture version, exact fixture-tree hash, and the controller-created `runId` and `runNonce`;
- exact plugin package identity, `packageIdentityDigest`, staged package-tree hash, authority-profile ID and digest, and the construction policy, grant, and safe-mode epochs observed at each construction checkpoint;
- Threadleaf semantic version and source commit as informational fields, plus the exact packaged application artifact SHA-256, installed application tree SHA-256, canonical build-manifest SHA-256, relevant `dist` bundle-tree SHA-256, Electron executable SHA-256, and one `effectiveBuildIdentityDigest` over those exact hashes;
- controller version, controller executable SHA-256, the complete trusted executable-closure SHA-256, trusted-controller-manifest ID and SHA-256, evidence-harness version and tree SHA-256, issuer key ID and key-identity SHA-256, issuer-trust-store version and identity SHA-256, platform, architecture, and Electron version;
- a digest of the declared preconditions and starting fixture;
- a monotonic sequence of user-visible steps, controller probes, and bounded host observations;
- the controller-derived terminal state;
- every required completion assertion, its observed value, its observation source, and the immutable artifact or direct probe that produced it;
- the allowlisted vault changes and an assertion from a controller-owned before/after tree diff that no other vault paths changed;
- the private-state namespaces expected to change, without embedding secret or personal values;
- the isolated-renderer identity before reload and a different identity after reload;
- post-reload assertions that repeat the durable part of the workflow;
- a cancel or dismissal control proving that the same command can return without satisfying completion;
- uncaught-error, rejected-promise, renderer-crash, timeout, and host-diagnostic results;
- screenshots or DOM/computed-style artifacts where the assertion is visual, each named by content hash.

The canonical build manifest is a strict RFC 8785 JSON artifact with one fixed schema, application identity, version, platform, architecture, required installed paths, and a sorted path-normalized inventory of the executable and resource closure of the installed package. The controller and verifier independently rebuild that inventory from the supplied installed tree, reject missing or extra files, and reject normalized NFC or portable case-colliding paths. Hashing only `package.json`, a semantic version, a Git commit, or one bundle is insufficient. The relevant `dist` manifest separately names the main, preload, main-renderer, plugin-renderer, runtime, and generated compatibility-registry bundles so a dirty or partially rebuilt installation cannot reuse a receipt from another effective build.

#### Canonical serialization, signature, and atomic finalization

The v2 envelope is:

```ts
interface Level4ReceiptEnvelopeV2 {
  schemaVersion: 2;
  payload: Level4ReceiptPayloadV2;
  payloadSha256: string;
  issuer: {
    keyId: string;
    keyIdentitySha256: string;
    controllerVersion: string;
    controllerExecutableSha256: string;
    trustedExecutableClosureSha256: string;
    trustedControllerManifestSha256: string;
    issuerTrustStoreIdentitySha256: string;
  };
  signature: {
    algorithm: "Ed25519";
    valueBase64: string;
  };
}
```

Payloads are UTF-8 RFC 8785 canonical JSON. The schema permits only JSON strings, booleans, nulls, arrays, objects, and safe-range integers; it forbids floating-point measurements. Timestamps are UTC RFC 3339 strings and digests are lowercase hexadecimal. `payloadSha256` is computed over the canonical payload bytes. The unsigned envelope consists of `schemaVersion`, `payload`, `payloadSha256`, and `issuer`; the Ed25519 signature covers the domain-separated bytes `threadleaf-level4-receipt-v2\0` followed by the RFC 8785 canonical unsigned-envelope bytes. The complete envelope, including the signature, is then canonicalized, and its SHA-256 becomes `receiptFileSha256` in the registry entry. The verifier requires every duplicated issuer, controller-manifest, controller-executable, key-identity, and trust-store identity field inside the payload to equal the signed outer `issuer` fields.

The controller holds draft observations in a controller-designated per-run directory. It finalizes only after the application has reached the declared reload checkpoint, every required assertion and negative control has passed, the final vault/private-state diff has settled, and all artifact hashes have been recomputed from disk. It writes the complete canonical envelope to a private `.level4-pending` staging directory, flushes the file, installs it with a no-replace atomic hard-link, removes the temporary name, and flushes the directory. A `.<name>.incomplete` marker remains until the final directory flush succeeds; the verifier and registry generator categorically ignore a final name with that marker. An existing final name, an inability to guarantee no-replace semantics, a signing failure, or any failed flush aborts publication. In ordinary operation the registry generator sees either the complete finalized envelope or no publishable receipt, never a partially written receipt. This atomicity claim does not make the same-user directory immutable against a malicious granted plugin.

Canceled, failed, timed-out, crashed, and partial attempts may produce controller-signed non-passing attempt records in a separate attempts store, or no record. They never produce a receipt in the publishable receipt store and never reuse the nonce. The controller does not turn a later retry into the same run; every retry gets a fresh nonce and run ID.

#### Trust-root bootstrap and rotation within the co-privileged model

The Threadleaf release maintainer authorizes receipt keys and evidence-tool identities through normal reviewed source changes. The current root is a canonical checked-in policy at `scripts/compatibility/trust/level4-trust-policy.v1.json`; the registry-generation command supplies that fixed current path to the verifier and never accepts a trust-policy path from a receipt. The policy contains:

```ts
interface Level4TrustPolicyV1 {
  schemaVersion: 1;
  trustStoreVersion: number;
  trustedControllerManifest: {
    manifestId: string;
    manifestVersion: number;
    controllerVersion: string;
    controllerExecutableSha256: string;
    executableClosureSha256: string;
    executableClosure: {
      schemaVersion: 1;
      roots: string[];
      entries: Array<{ path: string; bytes: number; sha256: string }>;
    };
    allowedReceiptSchemaVersions: [2];
    currentHarness: {
      version: string;
      treeSha256: string;
    };
  };
  issuerKeys: Array<{
    keyId: string;
    publicKeyBase64: string;
    keyIdentitySha256: string;
    status: "active" | "revoked";
  }>;
}
```

`trustedControllerManifestSha256` hashes the canonical manifest object. `issuerTrustStoreIdentitySha256` hashes the complete canonical policy, including the manifest, key bytes, statuses, and `trustStoreVersion`. The verifier treats this checked-in current policy as an explicit input; values or paths named only by the receipt have no authority.

Key rotation is a reviewed policy replacement: add the new key as `active`, mark the prior key `revoked`, increment `trustStoreVersion`, and regenerate the policy identity. Controller or harness replacement updates the trusted controller manifest in the same change. Because the active key identity, controller manifest, harness, and trust-store identity are part of the verification tuple, rotation or revocation invalidates every old receipt immediately and the catalog remains below Level 4 until the workflow is rerun. There is no grace carry-forward, and the generation-consistency rule below forbids publishing any registry row produced under a superseded policy identity. Within the declared model, a malicious same-user plugin could alter this policy or the surrounding files; stronger protection requires the optional future boundary above.

#### Verification and replay invalidation

The registry generator invokes a dedicated verifier with explicit paths for the packaged application, current plugin package, sealed execution root, current trust policy, current controller executable, current evidence-harness tree, receipt, workflow definition, and fixture tree. None of those current-policy or current-tool paths may come from the receipt. The verifier must:

1. require byte-for-byte canonical envelope serialization and a valid Ed25519 signature from the one `active` issuer key in the current trust policy, with exact `keyId`, key-identity, trust-store-version, and trust-store-identity matches;
2. recompute the supplied current controller executable, the complete interpreted controller/verifier executable closure, and evidence-harness tree, require them to match the current trusted controller manifest, and then require the receipt's controller version, controller executable hash, executable-closure hash, controller-manifest identity, harness version, and harness-tree hash to match those current trusted values, not merely the artifacts the receipt names;
3. recompute the fixture tree, complete source plugin package tree, sealed execution-root tree, packaged artifact, installed application tree, build manifest, relevant `dist` tree, Electron executable, and effective-build digests from the supplied current local artifacts;
4. require exact field-by-field package identity, authority-profile digest, workflow definition, platform, architecture, and build-identity matches;
5. require terminal state `completed`, every required assertion, a different post-reload renderer identity, no unallowlisted vault mutation, and no unavailable required delivery;
6. reject a `runNonce` or `runId` that appears in any different signed payload or verification tuple in the append-only replay index;
7. treat repeated verification of the same `receiptFileSha256` for the same exact verification tuple as idempotent, not as a new run;
8. emit the registry row only from verifier-accepted receipt fields, never from declarative JSON beside the receipt.

The exact verification tuple is the canonical digest of the effective build identity, exact package identity, authority-profile digest, workflow-definition hash, fixture-tree hash, platform, architecture, controller executable hash, trusted executable-closure hash, trusted-controller-manifest hash, evidence-harness version and tree hash, issuer key identity, and issuer-trust-store version and identity. The replay index records that tuple digest beside the nonce, run ID, and receipt-file hash.

Any change to the packaged artifact, installed tree, relevant `dist` bundle, build manifest, Electron executable, exact package tree, authority profile, workflow definition, fixture tree, platform, architecture, controller executable, any reachable controller/verifier dependency, trusted controller manifest, evidence-harness version or tree, issuer key identity, or issuer-trust-store identity invalidates the receipt. A still-valid signature from a superseded controller, harness, key, or trust-store generation is rejected against the current policy. There is no metadata-only carry-forward. Re-establishing Level 4 for any changed tuple is a new controller run that re-executes every required probe and produces a fresh nonce, signature, and receipt.

Policy reads and registry publication must be one coherent generation. The verifier takes an initial canonical trust-policy snapshot and carries that snapshot's `issuerTrustStoreIdentitySha256` in every accepted-verification result and in every generated registry row; it performs a final current-identity reread before returning so a policy change during verification fails closed. The generator validates all registry, TypeScript, and Markdown projections before installing any of them, writes derived projections first, rereads the current checked-in policy immediately before the authoritative JSON commit, and rolls every output back if any projection or the authority seam fails. One `generationId` derived from the registry body binds all three projections; runtime imports the authoritative JSON generation and rejects a mismatched generated TypeScript projection, while Markdown is explicitly descriptive and never an authority input. A reviewed rotation or revocation must also invalidate, or atomically replace, any registry whose rows were generated under the old policy identity, so no stale Level 4 row survives the policy change. The required controls inject failures at projection seams and rotate or revoke the policy at the true authority commit point, asserting that the resulting catalog contains zero Level 4 rows.

### Evidence modes

Unit, integration, and composed tests remain valuable gates, but none can award Level 4 by themselves. The required hierarchy is:

1. Unit tests prove parsers, stores, protocol validation, and compatibility objects.
2. Integration tests prove each cross-process seam with deliberate positive and negative controls.
3. One production Electron workflow is observed and finalized by the dedicated controller, and its receipt is accepted against the current trust policy and verification tuple.

The registry can retain `composed` evidence as a supporting mode, but a Level 4 workflow must also name a verifier-accepted `production-receipt` record. The current source has no such record. Platform-specific evidence yields platform-specific Level 4. A Linux receipt must not make the Windows or macOS catalog report Level 4.

### Catalog wording

The catalog should say, for example, "Level 4 for the Style Settings live snippet-control workflow on Linux," not "fully compatible." Known absent surfaces remain visible beside the verified workflow. It must describe a verifier-accepted workflow receipt under the current co-privileged evidence convention, never a hostile-process attestation, tamper-proof record, or security boundary from an already granted Node plugin. A change to any verification-tuple field invalidates the displayed Level 4 state until the bound workflow is rerun under a fresh controller nonce. Receipts are never carried forward by rewriting metadata.

### Required code-level changes for evidence

- `src/runtime/plugin-host.ts`: remove the compatibility-level mutation from `runCommand()` and expose workflow observations without assigning a level.
- `compatibility/plugin-evidence.v1.json`: migrated in place to schema 2 so the existing path now names exact identities, signed production workflow receipts, completion assertions, reload assertions, and platform scope.
- `scripts/generate-plugin-compatibility-registry.mjs`: invoke the dedicated verifier with the current trust policy, trusted controller and harness artifacts, supplied packaged application, and exact package tree rather than checking only declarations and gate paths.
- `src/shared/plugins.ts` and `src/generated/plugin-compatibility-registry.ts`: represent workflow-scoped evidence, platform scope, distribution tag, and limitations.
- Add the canonical receipt schema, dedicated controller/finalizer, checked-in trust policy, trusted controller manifest, replay index, and verifier under `scripts/compatibility/`. Runtime code may import observation types only, not finalization or signing code.

## Bridge 1: Style Settings appearance and snippet CSS

### Upstream behavior to preserve

Style Settings 1.0.9 discovers settings by walking `document.styleSheets` and reading each stylesheet owner's source text. It writes live values into a plugin-owned `<style id="css-settings-manager">`, updates body classes and CSS custom properties, and emits `workspace` `css-change`. It uses the global `activeWindow` for deferred parsing. Durable values are stored through `Plugin.saveData()` and rebuilt on plugin load.

Threadleaf currently injects a plugin package's `styles.css` with Electron `webContents.insertCSS()`. That changes styling but does not create an owner node with source text, so Style Settings cannot discover `@settings` declarations through its upstream traversal. Threadleaf's theme and snippet CSS is also authoritative in the main renderer and is not kept live in existing isolated plugin renderers.

### Design

#### 1. Add a typed renderer-environment snapshot

Extend `src/shared/plugin-runtime-protocol.ts` with a host-to-renderer operation such as:

```ts
interface PluginRendererEnvironment {
  vaultId: string;
  vaultGeneration: number;
  sequence: number;
  theme: "light" | "dark";
  appearanceCss: string;
  pluginCss: string;
  accessibilityCss: string;
}
```

`sequence` is monotonic within a vault generation. The renderer ignores stale snapshots. The protocol carries complete replacement text, not incremental CSS edits, because replacement is deterministic and avoids partial cascade state after a missed message.

The exact integration seam is the current `registerCompatibilityPluginView(view)` path in `src/main/main.ts`, lifted into a reusable environment publisher and delivered through `ElectronPluginRuntime` and `PluginRendererService`. Initial environment synchronization must complete before `load-plugin` is sent. Later snapshots use the same operation for watcher changes and settings edits.

Concretely, `IsolatedPluginRuntime.open({ create })` asks `ElectronPluginRuntime.open()` for an idle renderer, and `ElectronPluginRuntime.open()` currently invokes `registerCompatibilityPluginView(view)` before returning that renderer. The new renderer slot should retain the acknowledged environment sequence from that creation path. `loadFreshSlot()` may hand the slot to `PluginHost` only after `PluginRendererService` has applied that sequence to the DOM. This is the precise isolated-runtime to plugin-renderer join for the bridge.

#### 2. Materialize CSS as source-bearing DOM nodes

In `src/plugin-renderer/plugin-renderer-service.ts`, maintain renderer-owned style elements in the plugin document:

```html
<style id="threadleaf-compat-appearance-source"></style>
<style id="threadleaf-compat-plugin-source"></style>
<style id="threadleaf-compat-accessibility"></style>
```

Set their `textContent` to the authoritative source. Do not use `insertCSS()` for source that a plugin is expected to inspect. The resulting `CSSStyleSheet.ownerNode.textContent` is the exact text Style Settings scans.

The cascade order is:

1. plugin-host base CSS;
2. Threadleaf theme and enabled snippet source;
3. the package's `styles.css`;
4. plugin-created styles, including `#css-settings-manager`;
5. Threadleaf's mandatory accessibility protections, narrowly scoped and `!important` only where the protection must be non-overridable.

This order lets Style Settings override theme/snippet declarations while preserving Threadleaf's hard accessibility boundary.

#### 3. Provide the real `activeWindow`

`src/plugin-renderer/renderer.ts` should install `activeWindow` before any plugin bundle is evaluated:

```ts
Object.defineProperty(globalThis, "activeWindow", {
  value: window,
  enumerable: true,
  configurable: false,
  writable: false,
});
```

It must be the isolated renderer's actual `window`, not a proxy to the main renderer. Timers and DOM access then stay in the plugin's realm and preserve the isolation boundary.

#### 4. Synchronize live changes in the right order

`src/main/vault-appearance-loader.ts` remains the source of authoritative appearance CSS. The main process should retain the latest normalized appearance snapshot per vault and publish it to every active compatibility view when any of these occur:

- a theme or snippet file changes;
- a snippet is enabled or disabled;
- a Threadleaf appearance setting changes;
- the vault generation changes;
- safe mode changes the enabled plugin set;
- a new compatibility renderer is registered.

Within an isolated renderer, environment application is one transaction:

1. replace source-node text;
2. update the document theme marker and body classes;
3. force stylesheet realization by reading the sheet count or awaiting one animation frame;
4. trigger `workspace.trigger("css-change")`;
5. acknowledge the environment sequence.

The main process reports an appearance update complete only after every targeted active renderer has acknowledged the current sequence or has been declared dead and removed. This prevents a toggle from reporting success while the old CSS is still rendered.

A Style Settings control change itself remains renderer-local: its upstream callback updates the plugin-owned dynamic style or body class immediately, then persists through `saveData()`. Threadleaf must not delay that visible change behind a main-process round trip. The host participates again only when Threadleaf's own snippet enablement changes, at which point the environment transaction replaces source text and `css-change` makes Style Settings reparse its declarative definitions.

#### 5. Preserve reload state through existing authorities

Threadleaf snippet enablement remains in Threadleaf's appearance settings. Style Settings values remain in the plugin's `data.json` through the existing `loadData()` and `saveData()` bridge. Reload reconstruction is:

```text
Threadleaf appearance settings -> environment source nodes
Style Settings data.json       -> plugin dynamic style/body classes
```

Neither source should overwrite or duplicate the other. The renderer receives the environment first, then the plugin loads and reapplies its saved values.

### Deliberate boundary

This bridge styles the isolated renderer that owns Style Settings. It does not let a community plugin inject arbitrary CSS or body classes into Threadleaf's main renderer or another plugin's renderer. Threadleaf may copy its own authoritative theme/snippet source into every isolated renderer, but plugin-created dynamic CSS remains realm-local. This is a deliberate difference from Obsidian's single shared renderer because crossing that boundary would erase the isolation model and give one plugin control over unrelated surfaces.

The Style Settings Level 4 claim must therefore read "Style Settings controls the isolated plugin surface." It must not claim that Style Settings can restyle Threadleaf's native editor, file tree, or unrelated plugin views.

### Shim prerequisites

| Wedge lane | Requirement | Why |
|---|---|---|
| Lane 1, workspace/fileManager | No hard prerequisite for the named workflow | The bridge itself uses workspace events already present. |
| Lane 2, metadata/YAML | None | CSS discovery does not depend on metadata. |
| Lane 3, vault adapter | None beyond current plugin data persistence | `data.json` persistence already supplies the durable value path. |
| Lane 4, commands/keymap | `app.commands.removeCommand` and honest command snapshot reconciliation | Style Settings removes and recreates dynamic commands as parsed settings change. |
| Lane 5, internalPlugins | None | The plugin does not need an internal-plugin facade for this workflow. |

### Production workflow and receipt assertions

**Workflow ID:** `style-settings.snippet-control-live-reload.v1`

The Level 4 workflow fixture contains an enabled snippet with one boolean class setting and one numeric CSS-variable setting. The workflow must:

1. start with a fresh isolated renderer and confirm the source node contains the exact fixture declaration;
2. open Style Settings through the real settings surface and confirm both controls are present;
3. change both controls through pointer or keyboard input;
4. assert the plugin's saved data, the body class or CSS variable, and a named element's computed style;
5. disable the snippet and assert the controls and dynamic command disappear and the computed style reverts;
6. re-enable it, set the values again, close the view, destroy the renderer, restart the application, and reopen the plugin;
7. assert the controls, saved values, body class or CSS variable, and computed style are restored without replaying the input.

A control callback resolving without the computed-style assertion is not completion.

### Risk and effort

**Risk:** Medium. The main risks are cascade ordering, stale watcher snapshots, and falsely treating Electron-injected CSS as discoverable source. The bridge is well bounded because it does not change vault semantics or main-renderer authority.

**Estimated effort:** 5 to 8 engineer-days after Lane 4, including protocol tests, renderer lifecycle tests, a real appearance-watcher test, and the production receipt harness.

## Bridge 2: Calendar region, configuration, event, and traversal bridge

### Upstream behavior to preserve

Calendar's startup path registers a view and, on layout ready, mounts it with `app.workspace.getRightLeaf(false).setViewState({ type: "calendar" })`. Its cache builds note markers by statically traversing the vault and then listening for vault `create`, `delete`, `rename`, and `modify` events. Daily-note behavior reads `{ folder, format, template }` from `internalPlugins.getPluginById("daily-notes").instance.options`. Template-based creation reads and writes fold information through `window.app.foldManager`.

Threadleaf currently satisfies parts of the API semantically but not physically. A right leaf can resolve without placing the renderer in a right dock, plugin-originated vault events do not cover files created or deleted through native Threadleaf paths or external changes, and the internal-plugin facade cannot truthfully expose daily notes without transporting Threadleaf's actual configuration.

### Design

#### 1. Make region part of leaf and surface identity

Add a closed region vocabulary:

```ts
type PluginSurfaceRegion = "main-document" | "right-dock";

interface PluginSurfaceDescriptor {
  surfaceId: string;
  leafId: string;
  pluginId: string;
  viewType: string;
  region: PluginSurfaceRegion;
  visible: boolean;
}
```

Every compatibility `WorkspaceLeaf` has an immutable region. `getRightLeaf(false)` reuses or creates a `right-dock` leaf. `getUnpinnedLeaf()` and `splitActiveLeaf()` return a `main-document` leaf. Activation is tracked per region, so activating Calendar does not hide the active Markdown note.

`Workspace.getLayout()` should place right-region leaves under `right.children`. `revealLeaf()` selects and expands the owning region. This is enough for the Calendar workflow; it is not a general Obsidian docking tree.

#### 2. Add a physical right-dock host

`src/renderer/index.html` should contain a dedicated plugin-surface mount inside the existing right dock, separate from the main document host. The native dock's collapse and resize controls remain authoritative. The right dock can expose Inspector and Calendar as mutually selectable dock contents, while the main editor remains mounted.

The renderer reports bounds and visibility keyed by `surfaceId`. In `src/main/main.ts`, replace the singleton compatibility-view attachment state with maps keyed by surface ID and region. Attach one `WebContentsView` per active region to the same `BrowserWindow`, clip it to the reported host rectangle, update bounds on dock resize, hide it on collapse, and remove it on leaf detach.

`PluginSurfaceSnapshot`, `ElectronPluginRuntime` surface callbacks, and `IsolatedPluginRuntime` view-closing logic become region-aware. Opening a right-dock view closes or replaces only a conflicting right-dock surface, not the main plugin or editor surface. Popout delivery for the right dock is explicitly unsupported in the first version.

The exact existing seam is the current `PluginSurfaceSnapshot` to renderer to main-process bounds path. The bridge changes that path from one implicit surface to explicit surface descriptors.

#### 3. Extend the landed registry with Threadleaf's daily-note settings

Threadleaf already owns per-vault daily-note settings in `VaultNoteWorkflowSettings`:

```text
dailyNoteFolder
dailyNoteDateFormat
dailyNoteTemplate
```

The landed Wedge 2 internal-plugin registry already carries an honest disabled `daily-notes` record with no instance or options surface. Lane 5 extends that same registry entry rather than adding a parallel registry. Before plugin load, include its immutable internal-plugin snapshot in the renderer initialization state and expose the following only when Threadleaf's corresponding native daily-note workflow is available:

```ts
internalPlugins.getPluginById("daily-notes") => {
  id: "daily-notes",
  enabled: true,
  instance: {
    options: {
      folder: dailyNoteFolder,
      format: dailyNoteDateFormat,
      template: dailyNoteTemplate,
    }
  }
}
```

This facade may report `enabled: true` because Threadleaf implements the corresponding native daily-note workflow. Without that feature and its transported options, the existing record remains disabled. Other named internal plugins remain disabled until their behavior exists.

When Threadleaf settings change, publish a new immutable internal-plugin snapshot to all active compatibility renderers for the vault, swap the facade options atomically, then emit the event Calendar observes for periodic-note settings changes. The facade must not copy these values into `.obsidian/daily-notes.json`; Threadleaf remains the authority.

#### 4. Build one authoritative vault-event stream

The bridge attaches to `WorkspaceRuntime.handleWatchBatch(batch)` after the watcher batch has been accepted and the index has reached a coherent revision. It emits a generation-bound, sequenced stream to active plugin renderers:

```ts
type CompatibilityVaultEvent =
  | { type: "create"; path: string; stat: FileStat }
  | { type: "modify"; path: string; stat: FileStat }
  | { type: "delete"; path: string; wasFolder: boolean }
  | { type: "rename"; oldPath: string; path: string; stat: FileStat };

interface CompatibilityVaultEventBatch {
  vaultId: string;
  vaultGeneration: number;
  sequence: number;
  indexRevision: number;
  events: CompatibilityVaultEvent[];
  reset: boolean;
}
```

The in-renderer `Vault` keeps a canonical path-to-object map. A batch first reconciles `TFile` and `TFolder` objects, parent `children` arrays, and cached stats. It then fires events in the same deterministic order. A rename preserves the file object's identity and passes `oldPath`. A delete fires before the object becomes unreachable to listeners. The metadata cache invalidates or refreshes the same path before the corresponding workspace refresh event.

If a sequence is missed, the vault generation changes, or the watcher reports an unclassifiable rescan, the host sends `reset: true` plus a full inventory. The renderer rebuilds its tree and emits one `resolved` boundary instead of inventing deltas.

All official compatibility `Vault` and `FileManager` mutations should go through a host mutation port and receive a mutation receipt. The watcher event derived from that receipt is the sole normal event source. Until that routing is complete, the existing immediate in-renderer events need a bounded mutation ledger keyed by operation ID and resulting revision so the matching watcher event is consumed exactly once. Path-and-time heuristics are not acceptable because they can suppress a real external edit.

This stream covers:

- files created or deleted by Calendar itself;
- daily notes created by Threadleaf's native workflow;
- CLI or other host mutations that pass through the kernel writer;
- external filesystem changes observed by the vault watcher.

#### 5. Implement deterministic static traversal

Add the upstream static API `Vault.recurseChildren(root, callback)` to `src/runtime/obsidian-compat.ts`. It traverses the canonical in-renderer tree depth-first in stable normalized-path order and invokes the callback once per descendant. It does not follow symlinks outside the vault, expose hidden `.obsidian` state, or perform a fresh filesystem walk while events are being applied.

Initial inventory must be installed before `markLayoutReady()`. Calendar's `onLayoutReady()` callback can then traverse a complete tree and subscribe for later deltas without a race between initial scan and event delivery. Events that arrive during inventory installation are queued by sequence and applied after the inventory revision.

#### 6. Add a real fold-state compatibility store

Implement `window.app.foldManager.load(file)` and `save(file, info)` as a private, per-vault, per-path store outside the vault. The stored value is schema-validated and size-bounded. `load()` returns the saved fold payload or `null`; `save(file, null)` removes it. Rename and delete events move or remove the corresponding entry.

Calendar uses this surface to copy fold information from a template to the created daily note. The first implementation preserves and copies fold state but does not claim that Threadleaf's editor renders every Obsidian fold payload. If the native editor has no equivalent state for a payload, the value remains preserved and the compatibility diagnostics say `stored-not-rendered`. This is an honest partial semantic bridge rather than a no-op.

#### 7. Resolve Calendar's package identity divergence

The official release is tagged `2.0.0-beta.2`, while its manifest says `2.0.0`. The current equality rule treats that package as suspect or floating even though both strings and the bundle are exact.

Package inspection should preserve both values. A tag/manifest mismatch is accepted only when:

- the distribution source resolved an exact release tag and pinned release object or commit from the configured official repository or trusted catalog;
- the manifest ID matches the catalog/repository identity;
- tag, manifest, main bundle, optional stylesheet, and package-tree digests are all recorded;
- neither version string is a floating alias such as `latest`;
- the user-facing package record displays the divergence.

The mismatch becomes an informational `distribution-manifest-version-divergence` diagnostic, not a floating-version failure. Grants bind the complete identity, both values, package-tree digest, and fixed authority digest; Level 4 evidence binds the same identity plus the effective build. Registry lookup must not use only `(pluginId, manifestVersion)`, because multiple beta tags may ship the same manifest version.

### Deliberate boundaries

The Calendar bridge does not promise arbitrary Obsidian split trees, draggable tabs, mobile layout, weekly/monthly notes without their owning feature or plugin, or cross-plugin shared DOM. It implements two physical regions because that is the smallest layout model that truthfully satisfies Calendar's production workflow.

Calendar drag-and-drop behavior and Obsidian's full drag manager are outside the first Level 4 workflow. Right-dock popouts are also outside it. These are visible limitations in the catalog, not silent shims.

### Shim prerequisites

| Wedge lane | Requirement | Why |
|---|---|---|
| Lane 1, workspace/fileManager | `getRightLeaf`, `revealLeaf`, `getUnpinnedLeaf`, `splitActiveLeaf`, layout-ready state, `getActiveFile`, `openLinkText`, deletion prompt, and note creation helpers | Mounting, navigation, opening, creation, and deletion all use these paths. |
| Lane 2, metadata/YAML | `parseFrontMatterTags`, tag/link helpers, metadata-cache tags and unresolved links, `getAllFolders`, and available-path helpers | Calendar and the daily-note helper use read-side metadata and safe path resolution around note creation. This lane does not supply front matter mutation. |
| Lane 3, vault adapter | Extend the landed candidate `write`/`mkdir`/`copy`/`getFullPath` implementation with `remove`/`rmdir`, receipts, rollback, and event-stream coherence | A direct adapter mutation must not leave Calendar's cache stale. |
| Lane 4, commands/keymap | Existing command execution is sufficient for the named workflow | Calendar registers commands, but no dynamic removal is required by its basic workflow. |
| Lane 5, internalPlugins | Truthful `daily-notes` facade | This is the authoritative configuration transport. |
| Lane 6, transactional front matter | Revision-checked `FileManager.processFrontMatter` through the host mutation port | Template-based daily-note creation must not lose a concurrent external metadata edit. |

### Production workflow and receipt assertions

**Workflow ID:** `calendar.right-dock-daily-note-events-reload.v1`

The Level 4 fixture sets a non-default date format, daily-note folder, and template in Threadleaf settings. The workflow must:

1. load Calendar and assert its actual `WebContentsView` bounds are contained by the visible right-dock host while a Markdown editor remains visible in the main region;
2. assert Calendar observes the transported folder, format, and template values;
3. create today's daily note through the Calendar control and verify the exact target path, rendered template bytes, and day marker;
4. create another matching note through Threadleaf's native daily-note or file path and verify its dot appears without reloading Calendar;
5. delete one note through a native production path and verify its dot disappears;
6. rename a matching note and verify the old marker disappears and the new date marker appears once;
7. close the app, restart, reopen Calendar, and verify the right-dock mount, settings, traversal-built markers, and retained note state;
8. run a cancellation control for any confirmation used by deletion and assert no note or marker changed.

A successful create command without the target bytes and marker update is not completion.

### Risk and effort

**Risk:** High. This bridge crosses layout geometry, renderer attachment, file-object identity, watcher ordering, metadata invalidation, and settings authority. The highest correctness risk is duplicate or missing vault events; the highest UX risk is a semantic right leaf that still overlays the main surface.

**Estimated effort:** 3 to 5 engineer-weeks after the applicable lane prerequisites. The region model and event stream should be treated as reusable infrastructure, but the implementation must remain bounded to two regions and one authoritative event order.

## Shared prerequisite Lane 6: transactional `processFrontMatter`

Lane 2 supplies read-side metadata and YAML compatibility only. At baseline `4094f46`, `FileManager.processFrontMatter` is still absent, and completing Lane 2 must never imply that this mutating API exists. Calendar and Templater depend on a separately owned Lane 6 that routes front matter changes through the host mutation port and the canonical vault-event stream.

### API and transaction contract

`FileManager.processFrontMatter(file, mutator)` is an optimistic, revision-checked transaction:

1. The renderer requests a front matter transaction from the main-process host for `(vaultId, vaultGeneration, normalizedPath)`. The host reads the exact current file bytes and revision, parses front matter with the canonical YAML implementation, and returns a single-use `transactionId`, `expectedRevision`, an expiry, and a deep-cloned YAML-safe front matter value. No write lock is held while plugin code runs.
2. The plugin mutator runs exactly once in the plugin renderer against that local clone. The compatibility layer rejects a promise-returning mutator, functions, prototypes, aliases that escape the returned object, non-finite numbers, and other values outside the bounded YAML-safe schema. A thrown mutator error aborts the transaction without a write.
3. The renderer submits the single-use transaction ID and mutated value to the main process. The main process serializes all mutation commits for the normalized path, rechecks vault generation and the current revision, and consumes the transaction ID whether the commit succeeds or fails.
4. If the current revision differs, the host returns `{ status: "revision-conflict", expectedRevision, actualRevision }`, performs no write, emits no synthetic metadata or vault event, and surfaces a typed `FrontMatterRevisionConflictError`. It does not rerun the plugin callback automatically because the callback may have renderer-local side effects.
5. If the revision matches, the host applies only the front matter replacement to the held source form, validates the resulting document, and commits the complete bytes through the revision-checked atomic vault writer. The mutation receipt names the old revision, new revision, byte hash, operation ID, and transaction ID.

The compare-and-swap commit is the transaction boundary. An external edit between the initial read and commit cannot be overwritten, even though plugin code executes outside the main process. Closing the renderer, changing vault generation, expiring the transaction, or reusing a consumed transaction ID aborts without a write.

### Metadata and event ordering

After a successful durable write, ordering is fixed:

1. assign the new file and index revision;
2. invalidate the old metadata-cache entry before any listener can observe the new file revision;
3. reconcile the canonical in-renderer `TFile` object and stat from the mutation receipt;
4. deliver the single canonical vault `modify` event for the new revision;
5. parse and publish the metadata-cache `changed` event for that same revision, followed by any `resolved` boundary required by the batch;
6. settle `processFrontMatter` only after the vault event, metadata event, and mutation receipt are acknowledged.

During the interval between invalidation and the new parse, `getFileCache(file)` returns `null` or the new revision, never stale metadata labeled as current. The watcher consumes the operation receipt and must not emit a duplicate modify event.

### Required proof before Phase 3

Lane 6 needs unit, seam, and production-path tests before Calendar construction starts:

- a successful mutation preserves non-front-matter bytes, produces one durable revision, invalidates stale metadata before the vault event, publishes new metadata afterward, and emits exactly one modify event;
- a mutator throw, invalid YAML-safe value, renderer death, expired transaction, or persistence failure leaves the original bytes and metadata state intact;
- a negative conflict test pauses after the transaction read, applies a distinct external edit through the real watcher path, resumes the commit, and requires `revision-conflict`, preservation of the external bytes, zero transaction write receipts, and no transaction-originated metadata or vault event;
- restart reconstruction contains no reusable transaction token or cached allow decision.

## Bridge 3: Templater pre-construction Node policy and API surface

### Critical upstream fact

Templater 2.25.0 constructs `UserSystemFunctions` while building its function generator. On desktop with a `FileSystemAdapter`, that constructor immediately resolves Node's `util` and `child_process` modules and promisifies `exec`. The device-local `enable_system_commands` setting is consulted later as product behavior. It cannot make the Node capability absent at construction time.

Therefore Threadleaf cannot honestly offer unchanged Templater 2.25.0 in a subprocess-free mode merely by turning its setting off, returning a proxy, or replacing `exec` with a no-op. The authority decision precedes plugin construction and, because bundle top-level code can execute, precedes bundle evaluation.

### Design

#### 1. Bind authority to a fixed reviewed profile and grant

Authority is a checked-in review decision keyed to the complete exact package identity. It is not inferred from source scanning, mutable plugin settings, the requested workflow, or whichever modules happen to resolve during construction.

```ts
interface ReviewedAuthorityProfile {
  schemaVersion: 1;
  profileId: string;
  profileRevision: number;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  expectedStaticCapabilities: PluginCapabilityId[];
  requiredAuthorities: PluginCapabilityId[];
  executionProfile: "trusted-node-renderer" | "trusted-desktop-escape";
  allowedPlatforms: Array<"linux" | "darwin" | "win32">;
  authorityDigest: string;
}

interface CommunityPluginGrantV2 {
  schemaVersion: 2;
  grantId: string;
  vaultId: string;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  authorityProfileId: string;
  authorityProfileRevision: number;
  authorityDigest: string;
  grantedAuthorities: PluginCapabilityId[];
  provenance:
    | { kind: "signed-distribution"; releaseDigest: string; signerKeyId: string; signatureDigest: string }
    | { kind: "content-addressed-unsigned"; sourceDescriptorDigest: string };
  grantRevision: number;
  grantEpoch: number;
  issuedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
}
```

Both structures use RFC 8785 canonical JSON for their digests. Every constructible exact package, including Style Settings and Calendar, requires its own checked-in profile; there is no unprofiled default. The authority profile contains the complete expected static capability set for its exact package, not a minimum subset. `requiredAuthorities` is a conservative description of all authority reachable in the fixed runtime profile, not a copy of scanner output. Because the current compatibility profiles are Node-enabled, no reviewed profile may claim that Node filesystem, network, or process authority is technically absent merely because the bundle does not statically reference it. The checked-in Templater 2.25.0 profile must explicitly contain `subprocess` in both the reviewed expected capability set and the required authority set, and its execution profile is fixed as `trusted-desktop-escape`.

The scanner remains `staticOnly: true` review evidence. Its result must exactly match `expectedStaticCapabilities`, but the expected set and `requiredAuthorities` come from the fixed profile. Profile absence denies with `authority-profile-missing`; a missing or added scanned capability, scanner failure, or scan/profile set mismatch denies with `authority-profile-mismatch`. In particular, a scan that fails to report `subprocess` cannot select `trusted-node-renderer`, a reduced grant, or any fallback profile. A static scan can only preserve the reviewed mode, tighten it by causing denial, or add a diagnostic flag. It can never lower required authority or select the authority mode.

Grants match the full identity and exact authority digest. `grantedAuthorities` must equal the profile's `requiredAuthorities`; a superset does not rescue an identity or profile mismatch. Community-plugin grants therefore no longer bind only `main.js` and scanner output. Where an upstream distribution has a verifiable signature or signed release object, the grant reuses the native-extension signed-distribution provenance fields and verification path. Where it does not, the UI labels the grant `content-addressed-unsigned`, and exact staged bytes plus the reviewed profile remain mandatory.

Revocation is explicit and append-only. Revoking appends a new grant-state revision that repeats the bound identity and authority digest, sets `revokedAt` and `revocationReason`, and retains the prior issued row for audit. It increments the vault's `grantEpoch` and policy epoch, invalidates outstanding construction tickets, and destroys any renderer running under the revoked grant. Deleting or hiding a grant row is not revocation. Because a Node-enabled renderer cannot have authority removed in place, unload by renderer destruction is part of the revocation transaction.

The local `enable_system_commands` switch remains defense in depth and user intent, but it is never an input that selects construction authority.

#### 2. Seal the complete executable closure, then resolve every construction attempt in main

The main process stages the inspected distribution before any module resolution. The source plugin directory is never the execution root.

Staging performs these steps without importing, evaluating, or resolving package modules:

1. canonicalize the package root and enumerate a sorted relative-path inventory with `lstat`-style no-follow reads;
2. reject absolute paths, `..` traversal, case-colliding normalized paths, symlinks, sockets, devices, FIFOs, and other non-regular entries;
3. copy every regular distribution file through no-follow handles into a private host-owned staging directory while hashing the copied bytes;
4. build the canonical tree manifest, verify every identity field and `packageTreeSha256`, and reject a changed or incomplete source tree;
5. flush staged files and directories, make the tree read-only, and atomically install it at a content-addressed host-owned location keyed by `packageIdentityDigest` and `packageTreeSha256`;
6. reopen and verify an existing content-addressed location before reuse rather than trusting its name.

Module resolution starts only after sealing and starts from the staged `main.js`. Relative, absolute, and bare-package resolutions that produce a filesystem path must remain inside the sealed root. Node built-ins are admitted only under the fixed reviewed execution profile. Native addons require an explicit reviewed authority and platform-specific file hash; otherwise their presence denies staging. Mutable `data.json`, local-storage state, grants, caches, and files from the original plugin directory are never placed on the module-resolution path.

The host exposes one main-process-only function for every attempt:

```ts
type PluginConstructionPath =
  | "first-load"
  | "explicit-reload"
  | "automatic-recovery"
  | "renderer-death-restoration"
  | "app-restart-reconstruction"
  | "diagnostic-execution"
  | "test-execution";

interface ConstructionPolicyEpoch {
  policyEpoch: number;
  grantEpoch: number;
  grantRevision: number;
  safeModeEpoch: number;
  packageStoreEpoch: number;
  authorityProfileRevision: number;
}

interface PluginConstructionPolicy {
  constructionAttemptId: string;
  constructionPath: PluginConstructionPath;
  vaultId: string;
  vaultGeneration: number;
  epoch: ConstructionPolicyEpoch;
  packageIdentity: ExactPluginPackageIdentity;
  packageIdentityDigest: string;
  sealedPackageRootId: string | null;
  stagedPackageTreeSha256: string | null;
  authorityProfileId: string | null;
  authorityDigest: string | null;
  staticScanDigest: string | null;
  expectedStaticCapabilities: PluginCapabilityId[];
  requiredAuthorities: PluginCapabilityId[];
  boundary: "trusted-node-renderer" | "trusted-desktop-escape" | null;
  decision: "allow" | "deny";
  denialCode:
    | "authority-profile-missing"
    | "authority-profile-mismatch"
    | "package-identity-mismatch"
    | "package-stage-invalid"
    | "grant-required"
    | "grant-stale"
    | "grant-revoked"
    | "safe-mode-blocked"
    | "capability-unavailable"
    | "policy-epoch-stale"
    | null;
  issuedAt: string;
  policyDigest: string;
}

resolveConstructionPolicy(input): PluginConstructionPolicy
```

`resolveConstructionPolicy()` is owned and executed only by the main process. It reads the current sealed package record, fixed profile, complete static scan, grant and revocation record, safe-mode state, vault generation, platform/runtime availability, and all epochs in one coherent snapshot. It is called immediately before every first load, explicit reload, automatic recovery, reconstruction after renderer death, application-restart reconstruction, and diagnostic or test execution. Compatibility reconciliation may request construction, but it may not precompute an allow decision.

Every current hash-only re-entry path must be removed or made incapable of execution. `PluginHost.reloadPlugin()`, `IsolatedPluginRuntime.reloadPlugin()`, `RecoveringPluginRuntime`, and `WorkspaceRuntime.reloadPlugin()` retain only the durable exact package identity reference and requested construction reason. They all return to the same main-process resolver. No directory-plus-`expectedBundleSha256` overload remains. Diagnostic and test loaders cannot bypass this route or call `evaluatePlugin()` directly.

The policy epoch is monotonic per vault and changes whenever a grant is issued, revised, or revoked; safe mode changes; the reviewed profile or package store changes; platform capability changes; or the vault generation changes. A construction policy is single-attempt and cannot be cached as an allow decision by a renderer, slot, recovery wrapper, or workspace runtime. Immediately before main-process dispatch, the host rechecks every epoch and consumes the attempt ID. An epoch mismatch returns `policy-epoch-stale` and starts a new resolution; it never reuses or downgrades the old policy.

Only after an `allow` result does the main process provision a fresh renderer and disclose the sealed root through the one construction dispatch. A denied result sends no package path or package bytes to a renderer. `PluginRendererService` and `PluginHost.loadPluginUnsafe()` still verify the package identity, staged-tree digest, policy digest, and one-use attempt ID before `evaluatePlugin()` as defense in depth, but they do not choose authority. A renderer-originated load request or a reused attempt ID is rejected by the main process.

The plugin catalog and settings surface display one of these explicit states:

- "Requires exact-package permission to run host processes";
- "Permission is stale because the complete package or reviewed authority profile changed";
- "Permission was revoked";
- "Package denied because capability scan and reviewed authority profile differ";
- "Unavailable on this platform because this release resolves Node child_process during construction".

The unavailable and mismatch states offer no enable toggle. Threadleaf must not present Templater as loaded with system commands merely disabled.

Required negative controls include:

- a scanner-evasive fixture that resolves `child_process` through a non-literal expression such as `require("child_" + "process")`; with no exact reviewed profile it must fail `authority-profile-missing`, and with a test profile whose expected set contains `subprocess` while the scanner omits it, it must fail `authority-profile-mismatch` before any evaluation marker;
- a package whose `main.js` is unchanged but whose reachable local dependency changes; it must fail complete package identity before module resolution;
- grant revocation, safe-mode change, and profile-revision changes between initial load and each reload/recovery path; every path must destroy the old renderer and deny or re-resolve under the new epochs;
- diagnostic and test entry points that attempt to call a lower loader directly; they must be structurally unable to evaluate bytes without a fresh main-process construction attempt.

#### 3. Make renderer provisioning fixed-profile-aware

`IsolatedPluginRuntime.open({ create })` currently pre-creates a generic idle Node renderer before knowing which plugin will occupy it. Change the creation contract so the main process supplies only the execution profile from the matched fixed authority profile after `resolveConstructionPolicy()` returns `allow`. Static scan output is not an execution-profile selector.

For the current architecture, both allowed compatibility profiles still use a Node-enabled renderer, so this does not make Node granular. Its guarantees are narrower:

- denied Templater bytes and paths never enter or execute in a renderer;
- allowed Templater is labeled a trusted desktop escape before construction;
- every construction attempt uses a fresh renderer with no previously evaluated community-plugin code;
- a renderer that hosted an authority-bearing plugin is destroyed on unload, revocation, safe-mode change, policy-epoch change, crash, or reload and is never returned to an idle pool;
- restart and recovery reconstruction repeat sealed-tree verification and main-process policy resolution.

Do not describe this as revoking `child_process` inside an already running Node realm. Once allowed Templater is evaluated there, it has the trusted renderer's Node authority.

#### 4. Deliver the declarative settings API in the plugin realm

Templater 2.25.0 uses `PluginSettingTab.getSettingDefinitions()` with these concrete definition types:

- structural: `group`, `page`, and `list`;
- controls: `folder`, `toggle`, `dropdown`, `number`, and `text`;
- conditional visibility and disabled predicates;
- custom page factories and list add/delete/reorder actions;
- validation, descriptions that may be `DocumentFragment` values, and refresh after mutation.

These functions and DOM fragments cannot be serialized safely across IPC. Render the settings tree inside the isolated plugin renderer where the plugin objects and callbacks live. The main renderer only selects the plugin settings surface and supplies its physical host bounds.

Extend the current compatibility setting-tab implementation in `src/runtime/obsidian-ui-compat.ts` with:

- `getSettingDefinitions()` dispatch;
- recursive group and page navigation;
- stable keyed control instances;
- real folder selection constrained to vault folders;
- list row creation, deletion, and deterministic reordering;
- predicate re-evaluation after each action;
- synchronous control readback plus awaited `onChange` settlement;
- validation errors attached to the affected control;
- `refreshDomState`, `getControlValue`, and `setControlValue` semantics used by the exact release;
- disposal of all listeners and plugin components when the tab or renderer closes.

A settings action is complete only after its callback, plugin `saveData()`, local-storage flush if applicable, DOM refresh, and command-snapshot reconciliation have all settled.

#### 5. Implement ConfirmationModal as a real blocking interaction

Templater's dangerous settings modal uses `ConfirmationModal`, `ConfirmationButton`, `setTitle`, `addCheckbox`, `addButton`, `addCancelButton`, disabled state, CTA styling, and asynchronous click handlers.

Implement these classes in `src/runtime/obsidian-ui-compat.ts` as a modal mounted over the plugin settings surface in the same isolated renderer. Required behavior:

- focus is trapped within the modal and restored to the invoking control;
- Escape and the cancel button close it without invoking confirmation;
- on desktop the confirmation button remains disabled until the checkbox is checked;
- the asynchronous confirmation callback is awaited;
- duplicate submission is blocked while the callback is pending;
- failure keeps or restores a visible error state and does not report completion;
- successful confirmation closes only after persistence settles;
- closing the underlying plugin surface cancels the interaction and yields a canceled workflow step.

This modal is part of the authority UX, so a native `confirm()` dialog or an auto-confirming test shim is not equivalent.

#### 6. Separate portable plugin data from device-local dangerous settings

Keep ordinary Templater settings in the existing plugin data path:

```text
.obsidian/plugins/templater-obsidian/data.json
```

Implement `App.loadLocalStorage(key)` and `App.saveLocalStorage(key, value)` with a private host store outside the vault, namespaced by `(vaultId, pluginId, key)`. This is where Templater's `templater-local-settings` value belongs. Do not use web `localStorage`, which would couple plugins by origin and profile.

The Obsidian API is synchronous, so initialization must preload the plugin's bounded local-storage map into the renderer before plugin evaluation. Reads are synchronous from that map. Writes update it synchronously and enqueue an atomic main-process persistence operation. Pending writes join `waitForSettledMutations()` and must be flushed before renderer teardown, reload evidence, or a settings action reports completion.

Values are schema-size-bounded JSON, not arbitrary classes or executable objects. `null` removes a key. A failed durable write rolls back the in-renderer value or marks the plugin state dirty and prevents the workflow from completing. The store is per device and per vault, matching the warning shown by Templater's confirmation modal.

#### 7. Deliver hotkeys through serializable command descriptors

Templater creates and removes dynamic commands for template hotkeys. Lane 4 must provide `removeCommand`, command listing, `executeCommandById`, and keymap push/pop behavior. Extend the plugin command snapshot with default hotkey descriptors and a stable revision. Main-renderer user bindings refer to `(pluginId, commandId)`, never an in-renderer function.

The production keyboard path is:

```text
real KeyboardEvent in main renderer
  -> Threadleaf keybinding resolver
  -> revision-bound plugin command descriptor
  -> plugin-runtime command RPC
  -> Templater callback in isolated renderer
  -> revision-bound editor/vault operations
  -> settled command and storage snapshots
```

When Templater changes its template-hotkey list, the renderer publishes a new command revision after the settings callback settles. Removed commands disappear from the main keymap. Collisions use Threadleaf's existing user-binding precedence and are displayed rather than resolved nondeterministically.

The Level 4 test must dispatch a real keyboard event. Directly invoking `runCommand()` does not prove hotkey delivery.

#### 8. Be explicit about CodeMirror delivery

Threadleaf's native editor is CodeMirror 6, but a CodeMirror `Extension` object created in the isolated renderer contains functions and realm-specific identities that cannot be structured-cloned into the main renderer. The current `registerEditorExtension()` stores such objects only in the plugin realm and does not install them into the native editor.

The first Templater Level 4 scope therefore makes this boundary explicit:

- provide the minimal `window.CodeMirror` mode-registration compatibility required for unchanged Templater to initialize its internal highlighter objects;
- track `registerEditorExtension()` registrations for lifecycle cleanup and diagnostics;
- report delivery as `registered-but-unavailable-in-native-editor`;
- annotate and disable Templater's declarative `syntax_highlighting` controls with "Not delivered to the Threadleaf editor";
- exclude syntax highlighting and editor suggestions from the Level 4 workflow and catalog claim.

This is not a silent no-op: the user-visible settings and compatibility report say the extension is not installed. Actual delivery would require a separately designed cross-realm extension protocol or executing vetted editor extensions in the main renderer. Neither should be smuggled into this bridge.

#### 9. Be explicit about CLI delivery

Templater registers `templater:create-from-template` through `Plugin.registerCliHandler`. Threadleaf's CLI is a headless kernel client and does not construct community-plugin renderers. Relaying a CLI call to a live GUI renderer would make behavior depend on an open application and would expand the trusted execution surface.

For the first Level 4 scope:

- implement `registerCliHandler` in the compatibility API so unchanged Templater can load;
- retain the handler descriptor in plugin diagnostics, but mark delivery `unavailable-headless`;
- do not add it to Threadleaf CLI help, completion, or executable command tables;
- if a caller addresses that plugin handler through a diagnostic API, return a structured unsupported result before any callback runs;
- show "CLI handler registered by plugin, not available in Threadleaf CLI" in the compatibility report;
- exclude CLI creation from the Level 4 workflow.

This is honest absence, not a no-op command. A future CLI bridge would need a separately reviewed headless plugin construction policy, exact package loading, capability grant access, transaction semantics, and evidence workflow.

### Deliberate boundaries

Threadleaf will not patch Templater's release bundle to lazily import `child_process`, replace `child_process` with an execution proxy, or claim a subprocess-free mode for this exact release. It will not execute ungranted Templater code in order to show a reduced settings page. It will not count CodeMirror registration or CLI registration as delivery.

User scripts and user system commands remain outside the first named Level 4 workflow even when the complete exact package grant permits them. The fixed reviewed profile and matching grant authorize the trusted escape; they do not establish that every Templater execution feature has production evidence.

### Shim prerequisites

| Wedge lane | Requirement | Why |
|---|---|---|
| Lane 1, workspace/fileManager | `getActiveFile`, `activeEditor`, active view, `openLinkText`, new-file parent, safe Markdown-link and creation helpers | Template insertion and create-from-template need real active editor and file semantics. |
| Lane 2, metadata/YAML | tags, link helpers, folder enumeration, available-path helpers, and metadata-cache read surfaces | Built-in Templater functions and creation paths reach these read-side APIs. This lane does not supply front matter mutation. |
| Lane 3, vault adapter | Production-harden landed candidate `write`/`mkdir`/`copy`/`getFullPath`, add `remove`/`rmdir`, and supply receipts plus high-level rollback semantics | The named create workflow must create, render, and clean up files without an adapter dead end. |
| Lane 4, commands/keymap | `removeCommand`, public command listing, `executeCommandById`, hotkey descriptors, keymap push/pop | Dynamic template commands and real hotkey delivery depend on this lane. |
| Lane 5, internalPlugins | Truthful daily-notes lookup through `getEnabledPluginById` or equivalent | Templater's daily-note helpers must see Threadleaf's real feature state. |
| Lane 6, transactional front matter | Revision-checked `FileManager.processFrontMatter` through the host mutation port, including conflict and event-order semantics | Templater built-ins must not overwrite a concurrent external metadata edit. |

### Production workflow and receipt assertions

**Workflow ID:** `templater.template-hotkey-live-reload.v1`

The construction-policy negative controls run first:

1. with the exact reviewed Templater authority profile present but no matching full-identity grant, request enablement and require `grant-required` or `capability-unavailable` as appropriate;
2. run the scanner-evasive subprocess fixture under the two specified negative cases and require `authority-profile-missing` or `authority-profile-mismatch` before evaluation;
3. alter one reachable local dependency while preserving `main.js` and require `package-identity-mismatch` before module resolution;
4. prove no bundle evaluation marker, constructor marker, renderer command, subprocess resolution, plugin data mutation, or publishable receipt occurred in any denied case.

The granted Level 4 workflow then:

1. stages and verifies the complete Templater package tree, matches its checked-in authority profile, and grants that exact identity and authority digest before renderer creation;
2. loads the plugin through a fresh main-process construction resolution and asserts the catalog boundary is `trusted-desktop-escape`;
3. opens the real declarative settings page, selects a template folder, adds one template hotkey, and persists both;
4. confirms the syntax-highlighting control and CLI delivery are visibly unavailable rather than silently active;
5. sends the configured real keyboard chord while a named Markdown note is active;
6. verifies final revision-bound note bytes, selection/cursor result where specified, and no subprocess invocation for this fixture;
7. exercises the dangerous-setting confirmation cancel path and proves the device-local value did not change;
8. closes and restarts the application, verifies a new policy resolution under the current grant and safe-mode epochs, then verifies ordinary settings, device-local settings, dynamic command registration, and keybinding reconstruction;
9. repeats the keyboard action on a clean note and verifies the exact final bytes again.

An opened picker, canceled modal, command return, or partially inserted template is not completion.

### Risk and effort

**Risk:** Very high. This bridge combines fixed reviewed authority, complete executable-closure staging, a pre-evaluation main-process decision on every construction path, trusted Node authority, synchronous local-storage semantics across processes, declarative callback-rich settings, confirmation UX, dynamic commands, and revision-bound editor writes. The most dangerous failure is any hash-only, cached-policy, scan-selected, recovery, diagnostic, or direct-loader path that evaluates bytes without the current exact-package decision.

**Estimated effort:** 5 to 8 engineer-weeks after Lanes 1 through 6. This excludes general cross-realm CodeMirror extension delivery and a headless community-plugin CLI runtime, both of which require separate designs.

## Cross-cutting protocol and lifecycle rules

### Generation and sequence binding

Every environment snapshot, vault-event batch, settings projection, command snapshot, storage flush, and surface descriptor is bound to a vault ID and vault generation. Mutable streams additionally carry a monotonic sequence. Construction attempts also bind the policy, grant, safe-mode, package-store, and authority-profile epochs. A renderer must reject stale generations and ignore duplicate sequences. The host must replace rather than merge after a sequence gap. The main process must reject any construction attempt whose current epochs differ from the single-use policy.

### Settlement

`waitForSettledMutations()` should become an explicit barrier over:

- revision-checked vault writes and their event receipts;
- transactional `processFrontMatter` metadata invalidation, vault event, metadata event, and conflict result;
- plugin `saveData()` writes;
- device-local storage flushes;
- command and hotkey snapshot publication;
- environment snapshot acknowledgement where the command changes appearance;
- modal completion or cancellation;
- surface mount acknowledgement where the workflow opens a view.

The barrier proves quiescence, not business completion. The named workflow still needs its outcome assertions.

### Renderer death and recovery

On renderer crash or forced teardown:

- reject all pending calls with a typed renderer-dead error;
- never mark an in-flight workflow completed;
- discard unacknowledged environment and command sequences;
- invalidate every outstanding construction attempt for that renderer;
- retain only durably acknowledged plugin data and local storage;
- return renderer-death restoration to main-process `resolveConstructionPolicy()`, recheck the sealed complete package tree and all current epochs, and create a fresh renderer only after a new allow decision;
- require the evidence harness to observe a new renderer identity.

Recovery code may retain an exact package identity reference, but never an allow decision, construction ticket, source directory, or main-file-only hash. Automatic recovery, app-restart reconstruction, and explicit reload follow the same rule.

### Diagnostics

Each bridge should expose structured diagnostics rather than logs alone:

- current vault generation and last applied environment/event sequence;
- physical surface region, host bounds, and renderer bounds;
- daily-note facade revision;
- pending and last durable storage revisions;
- construction path, attempt ID, policy digest and epochs, fixed authority-profile digest, grant revision and revocation state, complete exact package identity, sealed package-tree digest, static-scan digest, and authority boundary;
- editor-extension and CLI registration versus delivery state;
- workflow terminal state and failed assertion ID.

Raw plugin exceptions remain bounded and renderer-safe as required by the existing diagnostic contract.

## Dependency-ordered implementation plan

This is an implementation order, not an instruction to implement as part of this design task.

### Phase 0: Establish evidence integrity and construction security before building bridges

1. Remove runtime Level 4 promotion from `src/runtime/plugin-host.ts`.
2. Define the canonical v2 payload/envelope schemas, co-privileged receipt threat model, dedicated controller/finalizer, checked-in trust policy, trusted controller manifest and executable closure, signed attempt-record split, and no-replace atomic publication protocol.
3. Implement the dedicated verifier, strict authority JSON reads, semantic exact-build manifest, fixture/package tree hashing, append-only nonce replay index, current-controller/closure/harness comparison, full verification tuple, and fail-closed local-artifact comparison.
4. Update `compatibility/plugin-evidence.v1.json` or replace it with a versioned v2 source that can reference only verified signed receipts.
5. Update `scripts/generate-plugin-compatibility-registry.mjs` and `src/shared/plugins.ts` for exact identity, effective build identity, named workflows, platform scope, completion assertions, reload assertions, controller/closure identity, harness identity, issuer-key identity, trust-store identity, coherent projection generation, and limitations.
6. Add canceled-command, forged-terminal-state, modified-envelope, duplicate-nonce, wrong-packaged-build, partial-write, runtime-self-promotion, superseded-but-signed controller, wrong harness, rotated key, revoked key, and stale trust-store controls. Every control must remain below Level 4.
7. Define, check in, and validate the complete package identity, fixed reviewed authority profile, full-identity grant, authority digest, signed/unsigned provenance, and append-only revocation contracts for Style Settings 1.0.9, Calendar `2.0.0-beta.2`, and Templater 2.25.0 before any of those packages can load. Profile absence or validation failure denies; later phases only activate or consume these already reviewed profile records.
8. Add the host-owned content-addressed staging store, canonical complete-tree manifest, symlink/special-file rejection, sealed-root module-resolution constraint, immutable-root verification, and unchanged-main/changed-local-dependency negative control.
9. Implement the single main-process-only `resolveConstructionPolicy()` with policy, grant, safe-mode, package-store, and profile epochs. Remove every directory-plus-main-hash execution overload and route first load, explicit reload, automatic recovery, renderer-death restoration, app-restart reconstruction, and diagnostic/test execution through it.
10. Make renderer provisioning fixed-profile-aware, use a fresh renderer for each construction attempt, and add generic epoch-change, revocation, reload, recovery, restart, renderer-death, diagnostic, and direct-loader negative controls.

Within the declared non-malicious receipt model, this phase rejects stale, partial, divergent, or replayed evidence. For malicious-plugin risk, it prevents every later bridge from executing through a stale, hash-only, unprofiled, or scan-selected construction path before authority is granted.

### Phase 1: Complete Lane 4, then build Style Settings

1. Activate and consume the already checked-in Style Settings identity-bound authority profile; do not create or infer a profile in this phase.
2. Complete command removal and snapshot reconciliation in `src/runtime/obsidian-workspace-compat.ts`, `src/runtime/obsidian-compat.ts`, and the plugin-runtime protocol.
3. Add the environment snapshot protocol in `src/shared/plugin-runtime-protocol.ts` and `src/runtime/plugin-runtime-port.ts`.
4. Publish appearance snapshots from `src/main/main.ts` using `src/main/vault-appearance-loader.ts`.
5. Materialize source-bearing style nodes and `activeWindow` in `src/plugin-renderer/plugin-renderer-service.ts` and `src/plugin-renderer/renderer.ts`.
6. Add live update, stale-sequence, reload, cascade-order, and production workflow tests.

This is the smallest bridge and proves the environment-sync and reload-reconstruction patterns used later.

### Phase 2: Build Calendar's shared prerequisites and identity divergence support

1. Extend the landed Wedge 1 workspace/file-manager primitives while preserving the real-leaf brand, honest preference throws, `OpenViewState` propagation, and pre-mutation `renameFile` refusal; then make leaf regions explicit in `src/runtime/obsidian-workspace-compat.ts` and `src/runtime/obsidian-ui-compat.ts`.
2. Complete the remaining Lane 2 read-side metadata and static-tree prerequisites in `src/runtime/obsidian-compat.ts`. The landed helpers above (folders, tags, links, YAML, simple search) are inputs, not remaining work; the remaining scope is the read-side authority and static-tree coverage those helpers do not yet provide, and `processFrontMatter` is never treated as delivered.
3. Implement Lane 6 `FileManager.processFrontMatter` through the host mutation port with single-use transactions, revision-conflict results, fixed metadata/event ordering, and the injected external-edit conflict test. This proof must pass before Phase 3.
4. Extend the landed disabled Wedge 2 internal-plugin registry entry into the truthful Lane 5 daily-notes facade and add its settings transport.
5. Activate and consume Calendar's already checked-in Phase 0 identity-bound authority profile, staging, and grant contracts in `src/main/open-plugin-package-source.ts`, `src/main/plugin-package-inspection.ts`, `src/shared/plugin-packages.ts`, evidence lookup, and package-manager rendering so distribution tag and manifest version can differ without becoming floating.
6. Add generation-bound inventory and vault-event protocol types in `src/shared/plugin-runtime-protocol.ts` and apply them in `WorkspaceRuntime.handleWatchBatch()`.

The identity work belongs before Calendar evidence so the exact beta release can be represented without an exception hidden in the test harness.

### Phase 3: Build the physical right dock and Calendar state bridges

1. Extend `PluginSurfaceSnapshot` and runtime callbacks with surface IDs and regions.
2. Add a right-dock host in `src/renderer/index.html`, geometry and selection logic in `src/renderer/renderer.ts`, and styling in `src/renderer/styles.css`.
3. Replace singleton attached-view state with per-surface maps in `src/main/main.ts` and update `src/main/electron-plugin-runtime.ts` and `src/runtime/isolated-plugin-runtime.ts`.
4. Implement canonical file-tree reconciliation, `Vault.recurseChildren`, ordered vault events, reset behavior, and metadata invalidation in the runtime compatibility layer.
5. Add the private fold-state store and rename/delete integration.
6. Run right-dock geometry, external file event, native file event, duplicate-suppression, reset, traversal, and production workflow tests.

This phase unblocks Calendar and creates reusable region and event infrastructure for later plugins.

### Phase 4: Complete Lane 3 and enforce Templater policy first

1. Production-harden the landed candidate adapter `write`/`mkdir`/`copy`/`getFullPath` behavior, add `remove`/`rmdir`, and route compatibility mutations through receipts with rollback semantics.
2. Activate and consume the fixed Templater authority profile already checked in and validated during Phase 0. Require its complete exact package identity, full expected static capability set, and explicit `subprocess` authority; apply the Phase 0 full-identity grant, authority-digest, sealed-package, and explicit-revocation contracts. Do not create or revise the reviewed profile as an implementation side effect in this phase.
3. Prove Templater first load, explicit reload, automatic recovery, renderer-death restoration, app-restart reconstruction, and diagnostic/test execution all reach the one Phase 0 main-process resolver immediately before construction and carry a single-use attempt to `PluginRendererService` and `PluginHost` only after allow.
4. Require a fresh fixed-profile-aware renderer for every Templater construction attempt and destroy it on unload, revocation, epoch change, recovery, or authority-profile change.
5. Add Templater-specific top-level side-effect, scanner-evasive subprocess, scan/profile mismatch, unchanged-main/changed-local-dependency, grant-revocation, safe-mode-epoch, recovery, restart, reload, renderer-death, diagnostic, and test-entry negative controls. Every denial must occur before module resolution or evaluation as applicable.

No Templater UI test should run before this phase, because constructing the exact plugin before the policy gate would exercise the very failure the design is meant to remove.

### Phase 5: Build Templater's supported surfaces

1. Add private per-device plugin local storage in a new main-process store, shared protocol messages, and `App.loadLocalStorage/saveLocalStorage` in `src/runtime/obsidian-compat.ts`.
2. Implement declarative settings and `ConfirmationModal` in `src/runtime/obsidian-ui-compat.ts` and the plugin-host document styles.
3. Complete command descriptor and real hotkey delivery in the runtime snapshot, main renderer keybinding resolver, and command RPC.
4. Implement minimal CodeMirror mode-construction compatibility, explicit native-editor delivery diagnostics, and disabled settings annotations.
5. Implement `registerCliHandler` as an explicitly unavailable descriptor, with no callback delivery into the headless CLI.
6. Run storage durability, confirmation cancel, hotkey E2E, renderer restart, app restart, denied-policy, and production workflow tests.

### Phase 6: Publish evidence only after all receipts pass

Build the exact packaged application, generate its canonical build and relevant-`dist` manifests, then have the dedicated controller run clean fixtures with fresh nonces and atomically finalize signed receipts. Validate each receipt against the installed packaged artifact, current exact plugin tree, current trusted controller manifest, current harness, active issuer key, current trust-store identity, workflow definition, replay index, and platform before regenerating the compatibility registry. Confirm the catalog names the exact workflow, the co-privileged receipt threat model, and every deliberate limitation. Do not assign Level 4 to a bridge merely because its implementation tests pass, and do not carry receipts onto another verification tuple.

## File-by-file impact map

The exact split can change during implementation, but these are the current ownership seams.

| Area | Existing files expected to change | Likely new focused files |
|---|---|---|
| Evidence | `src/runtime/plugin-host.ts`, `src/shared/plugins.ts`, `compatibility/plugin-evidence.v1.json`, `scripts/generate-plugin-compatibility-registry.mjs` | canonical receipt schemas, dedicated controller/finalizer, checked-in trust policy, trusted controller manifest, exact-build manifest generator, verifier, replay index, one production workflow driver per plugin |
| Shared plugin protocol | `src/shared/plugin-runtime-protocol.ts`, `src/runtime/plugin-runtime-port.ts` | none required if protocol remains cohesive |
| Isolated runtime | `src/runtime/isolated-plugin-runtime.ts`, `src/main/electron-plugin-runtime.ts`, `src/plugin-renderer/plugin-renderer-service.ts`, `src/plugin-renderer/renderer.ts` | optional environment-state helper |
| Style appearance | `src/main/main.ts`, `src/main/vault-appearance-loader.ts`, plugin-host document CSS | appearance environment synchronizer tests |
| Workspace and views | `src/runtime/obsidian-workspace-compat.ts`, `src/runtime/obsidian-ui-compat.ts`, `src/shared/contracts.ts`, optionally `src/shared/workspace-layout.ts` | region/surface state helper if maps make `main.ts` too broad |
| Physical rendering | `src/renderer/index.html`, `src/renderer/renderer.ts`, `src/renderer/styles.css`, `src/main/main.ts` | none required |
| Vault events and traversal | `src/application/workspace-runtime.ts`, `src/runtime/obsidian-compat.ts`, shared protocol | compatibility inventory/event reconciler |
| Transactional front matter | `src/runtime/obsidian-compat.ts`, file-manager contracts, host mutation port, metadata cache, watcher receipt reconciliation | Lane 6 transaction registry and typed revision-conflict result |
| Calendar settings and fold state | `src/runtime/obsidian-compat.ts`, settings transport contracts | private fold-state store |
| Package identity and grants | `src/main/open-plugin-package-source.ts`, `src/main/plugin-package-inspection.ts`, `src/shared/plugin-packages.ts`, `src/shared/plugins.ts`, grant storage, registry generator and catalog rendering | content-addressed sealed package store, canonical tree-manifest builder, grant revocation log |
| Community-plugin construction authority | main-process construction entry point, shared plugin contracts, all runtime load/reload/recovery/diagnostic layers, `src/runtime/plugin-host.ts` | fixed authority-profile registry, main-only construction-policy resolver and single-use attempt validator |
| Templater local storage | `src/runtime/obsidian-compat.ts`, protocol and lifecycle barriers | private plugin-local-storage store |
| Templater settings/modal | `src/runtime/obsidian-ui-compat.ts`, plugin-host HTML/CSS | declarative settings renderer if separation improves testability |
| Templater hotkeys | command snapshots, main-renderer keybinding resolver, plugin command RPC | none required |
| Templater CodeMirror/CLI honesty | `src/runtime/obsidian-workspace-compat.ts`, `src/runtime/obsidian-compat.ts`, catalog diagnostics | delivery-state types |

## Risk summary

| Bridge | Primary risk | Scope guard | Effort |
|---|---|---|---|
| Style Settings | stale CSS and wrong cascade/source representation | realm-local plugin CSS, complete replacement snapshots, computed-style evidence | Medium, 5 to 8 engineer-days |
| Calendar | duplicate/missing events and fake right-dock semantics | two fixed regions, one sequenced event source, reset on gaps | High, 3 to 5 engineer-weeks |
| Templater | any load, reload, recovery, restart, or diagnostic path executing code outside the current reviewed authority decision | sealed complete package closure, fixed exact-identity authority profile, full-identity grant, main-only per-attempt resolver with epochs, scan mismatch denial | Very high, 5 to 8 engineer-weeks after lanes |

## Deliberate non-matches

| Obsidian behavior | Threadleaf decision for this scope | Reason |
|---|---|---|
| Style Settings can affect the whole shared application DOM | Keep plugin-generated CSS inside its isolated renderer | Preserves the central isolation boundary. |
| Arbitrary dock trees, tab dragging, and mobile Calendar layout | Support physical main and right-dock regions only | This is the smallest truthful model for the named workflow. |
| Every Obsidian fold payload visibly rendered | Preserve/copy validated state and report unsupported rendering | Avoids destroying data without pretending editor parity. |
| Templater without subprocess authority because its toggle is off | Make unchanged 2.25.0 unavailable until its fixed full-package authority profile and matching grant are current | The release eagerly resolves `child_process` during construction, and the scanner cannot select a reduced mode. |
| Templater CodeMirror extension installed in native editor | Report registered but unavailable; disable and annotate the setting | Cross-realm function-bearing extensions are not serializable. |
| Templater CLI handler executable by Threadleaf CLI | Register descriptor only and report `unavailable-headless` | The CLI does not host community plugin runtimes or their authority policy. |
| Level 4 means every feature of a plugin works | Level 4 names one exact production workflow and its limits | Evidence should not outrun what was executed and persisted. |
| Level 4 receipt resists an already granted malicious Node plugin | Treat receipts as co-privileged drift, partial-run, and stale-replay evidence only | Malicious-plugin risk is accepted or denied at the exact-package grant boundary. |

## Definition of done for the architecture

An implementation based on this document is complete only when all of these are true:

- runtime command return can no longer assign Level 4;
- every Level 4 catalog row is backed by a controller-finalized, canonically serialized, signed, nonce-unique, exact-package, exact-effective-build, platform-scoped production receipt accepted against the current controller manifest, harness, active issuer key, trust-store identity, and replay index;
- receipt and catalog wording states that Level 4 evidence is a co-privileged convention for drift, accident, partial-run, replay, and non-malicious divergence detection, not protection from an already granted malicious Node plugin;
- Style Settings discovers source-bearing appearance CSS, applies controls live, and reconstructs the result after renderer and app reload;
- Calendar is physically bounded by the right dock while a main editor remains visible, sees Threadleaf's real daily-note settings, and updates markers exactly once for native, plugin, and external file changes;
- Calendar's exact beta tag and manifest version remain distinct in package identity, grants, and evidence;
- Lane 6 `processFrontMatter` uses revision-checked read-modify-write, exposes typed conflicts, never overwrites the injected external edit, and orders metadata invalidation and events against the committed revision;
- the complete plugin distribution is staged and sealed before module resolution, grants bind full identity plus authority digest with explicit revocation, and changing a reachable local dependency invalidates identity even when `main.js` is unchanged;
- the fixed reviewed Templater authority profile explicitly requires `subprocess`, any scan/profile mismatch denies instead of selecting a lower authority, and static scanning never selects authority anywhere in the construction path;
- first load, reload, recovery, renderer-death restoration, app-restart reconstruction, and diagnostic/test execution all invoke the one main-process resolver under current policy, grant, and safe-mode epochs;
- denied Templater code is not resolved, evaluated, or constructed;
- allowed Templater is visibly labeled a trusted desktop escape;
- Templater's declarative settings, confirmation modal, device-local storage, and real hotkey path complete and persist;
- CodeMirror editor-extension and CLI delivery are visibly absent and excluded from the Level 4 claim;
- cancellation, renderer death, sequence gaps, persistence failures, and unsupported delivery all fail closed without producing a Level 4 receipt.

No candidate branch is associated with this design document.

## Revision record

- P0-1 -> Bridge 3 now keys Templater authority to a fixed reviewed complete-package profile that explicitly requires `subprocess`; the static scan can only preserve that reviewed decision or deny on mismatch, and the scanner-evasive negative control must fail before evaluation.
- P0-2 -> Exact identity now means a sealed complete executable closure, community grants bind full identity and authority digest with explicit revocation, and one main-process resolver with policy, grant, and safe-mode epochs owns every load, reload, recovery, restart, renderer-death, diagnostic, and test construction path.
- P1-1 -> Receipt v2 now has a dedicated controller as the sole supported finalizer, bounded raw runtime observations, exact packaged-app and `dist` hashes, RFC 8785 serialization, Ed25519 signatures, fresh nonces, no-replace atomic finalization, local-artifact verification, and replay/build invalidation with no metadata carry-forward.
- P1-2 -> `processFrontMatter` is now explicit Lane 6 work with optimistic revision-checked read-modify-write, typed conflict results, fixed metadata/event ordering, and a required conflicting-external-edit negative test before Phase 3.
- Round 2 P0-2 -> The receipt threat model now states that controller, verifier, trust policy, stores, application, and granted Node plugin are co-privileged. Receipts address drift, accident, partial runs, stale replay, and non-malicious divergence; malicious-plugin risk is handled entirely by fixed-profile, full-closure, deny-on-mismatch grant-time policy.
- Round 2 replay and trust mechanics -> The verification tuple now includes the controller executable, trusted controller manifest, harness, issuer key, and issuer-trust-store identities. The verifier compares controller and harness values with current trusted inputs, and reviewed trust-policy bootstrap plus rotation/revocation invalidates old receipts.
- Round 2 P2 -> Phase 0 now checks in and validates identity-bound profiles for Style Settings, Calendar, and Templater before any plugin load; later phases only activate and consume those reviewed records.
- Round 2 baseline -> Current-architecture inputs now target `4094f46`, treat the Wedge 1 workspace/file-manager shims, Wedge 2 disabled internal-plugin registry, and Wedge 3 candidate vault adapter as landed, and retain Lane 6 because `processFrontMatter` is still absent.
- Round 3, P1 publication race: policy snapshot identity carried through verification results and registry rows; pre-publication policy-identity recheck with abort; rotation invalidates or atomically replaces registries generated under the old identity; rotation-between-verify-and-publish control requires zero Level 4 rows.
- Round 3, P2 baseline staleness: baseline moved to `2916469`; Wedge 4's landed metadata/link/YAML helpers recorded as inputs; Phase 2 rewritten to budget only the remaining read-side and static-tree work; Lane 6 confirmed still required.
