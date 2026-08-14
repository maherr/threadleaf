# Native extension capability contract

Native Threadleaf extensions are a separate runtime from the trusted CommonJS compatibility host.
The first stable manifest is version 1, with API version `1.0`. Its machine-readable schema is
[`native-extension-manifest.v1.schema.json`](./native-extension-manifest.v1.schema.json), and the
TypeScript vocabulary is exported from `src/native-extension/manifest.ts`. Signed distribution
records, publisher key rotations, and signed marketplace catalogs have their own machine-readable
schema in
[`native-extension-distribution.v1.schema.json`](./native-extension-distribution.v1.schema.json).

## Manifest and review

A manifest contains an ID, display name, version, contained relative entrypoint, exactly one of
`portable` or `desktopOnly`, and a list of declared capability IDs. The host sorts and validates
those IDs. The `reason` text is displayed during review only. It is never converted into authority.
Unknown IDs, duplicate IDs, invalid entrypoints, unsupported versions, and portable declarations of
desktop-only capabilities fail closed.

Registration computes the SHA-256 digest of the exact bundle bytes and an authority digest of the
entrypoint, version, declared capability IDs, and target flags. A grant stores both digests, the
extension ID, the vault ID, the selected capabilities, and grant timestamps. A later bundle byte
change is stale even when the manifest is unchanged. Changing the entrypoint or version is also
stale. Adding a capability produces an authority-growth review and cannot inherit an earlier grant.
Human display or reason changes that do not alter authority do not count as growth.

Grants are private application state. `FileNativeExtensionGrantStore` writes one versioned document
outside all vaults with an atomic replacement and mode `0600`; it never writes `.obsidian/` or a
vault-owned settings file. The application must supply its OS application-data path. File writes
take a cross-process lock, reread the latest document while holding it, and preserve an existing
revocation when a stale save races with revoke. The in-memory store is intended for tests and
disposable hosts. An explicit host `grant` is a reviewed replacement and clears the prior
revocation marker. Grants remain separate for every `(vaultId, extensionId)` pair.

## Enforced ports

Extension code receives `NativeExtensionContext` from the SDK. Each method crosses a typed public
port and checks, in order, that the invocation is live, the capability is declared, the runtime can
provide it, the current vault identity matches, the per-vault grant is current, and the capability
is included in that grant. A label or `reason` cannot satisfy any of these checks.

| Capability | Public port | Portable | Boundary |
| --- | --- | --- | --- |
| `vault.read` | bounded Markdown listing and text reads | yes | capability-governed |
| `vault.write` | revision-checked text writes | yes | capability-governed |
| `network` | host-provided HTTP(S) request | yes | capability-governed |
| `clipboard` | text read and write | yes | capability-governed |
| `external-navigation` | validated HTTP(S) open request | no | trusted desktop escape |
| `editor-ui` | selection and replacement | yes | capability-governed |
| `workspace-ui` | notice and vault-relative open | yes | capability-governed |
| `notifications` | bounded in-app notice delivery | yes | capability-governed |
| `subprocess` | host process adapter | no | trusted desktop escape |
| `secrets` | named secret provider | no | trusted desktop escape |
| `dynamic-code` | host-provided evaluator | no | trusted desktop escape |

An unavailable adapter returns `capability-unavailable`. A missing grant, stale digest, revoked
grant, safe mode, undeclared call, and cross-vault identity are distinct typed failures. A portable
runtime rejects desktop-only manifests and capabilities before an adapter is called. URL and secret
name inputs are validated at the public boundary. Vault writes still require the caller's revision
choice and are delegated to the host's recoverable writer.

`notifications` is deliberately separate from `workspace-ui`:
`NativeNotificationPort.show(message)` accepts a non-empty message of at most 4,096 UTF-16 code
units, allows at most eight messages per invocation, and allows at most 20 messages per extension
and vault in a rolling 60-second window. A missing notification adapter returns
`capability-unavailable` without calling any fallback. The `bindNativeNotificationPort` helper
connects the port to a host-owned callback such as the application's existing visible notice or
toast bus. The callback receives text only. Extensions never receive Electron, DOM, BrowserWindow,
or operating-system notification authority. This is an in-app notice surface, not a durable queue,
background delivery service, or OS notification API.

## Lifecycle and trust

Install is a trust gate and never creates a grant. `install` requires an explicit options object
whose `mode` is `trusted-distribution` together with signed metadata; a missing options object, any
other mode, or absent metadata is a `distribution-untrusted` failure. `NativeExtensionInstallMode`
has exactly one member, so no configuration value, settings file, or environment variable can put a
production host into an unsigned mode. Public `register` always fails closed, because callable
registration is unavailable on production hosts.

Unsigned development is therefore not a host setting. It is reachable only by importing the
source-only `src/native-extension/test-support.ts` module, which is not a package export and not a
build entry. Grants created that way are permanently labelled `unsigned-development`, are rejected
by the grant parser if they carry any trust metadata, and never count as marketplace trust or as a
production fallback. `scripts/check-native-extension-build-artifact.mjs` enforces this boundary at
build time: it fails when test-only source appears as a build entry, as a package export, in the
public native-extension index, in any production source file, or anywhere in the emitted `dist`
bundles, and when the byte-only production SDK artifact contains a callable entrypoint field.

Signed distribution metadata uses Ed25519 and binds the exact bundle bytes, authority digest, and
the complete installed package-tree digest. A package-tree field is optional only for old records;
those records use the bundle digest as a bundle-only compatibility identity. Publisher rotation is
accepted only from an offline trusted predecessor. If that anchor is revoked, a rotation issued
after revocation or with an effective time backdated before revocation is rejected.

`NativeExtensionMarketplaceCatalog` is the signed catalog index. The catalog root signs its
`generatedAt`, `expiresAt`, revision, entry-set digest, complete signed entries, lifecycle state,
and successor paths. The host applies a fixed 31-day local max-age and an explicit verification
clock, so forged freshness fields, offline expiry, and a future catalog fail closed. Unsigned
`NativeExtensionMarketplaceIndex` values remain parseable only for migration diagnostics and never
authorize installation. Every selected entry still requires exact local bundle bytes and is
reverified under the catalog publisher anchors. Rollback, replay, generated-time freeze,
unexplained omission, missing bytes, invalid signatures, and expired catalogs are hard failures.

Each accepted `(extensionId, version)` records metadata, bundle, authority, and package-tree
identity evidence. A package version cannot be rebound to different bytes, authority, metadata, or
tree identity. An omitted entry with explicit lifecycle state becomes an irreversible tombstone
carrying the same evidence, and a later catalog cannot re-add that key. Catalog state is durable,
monotonic, mode `0600`, cross-process locked, and compare-and-swap protected. Compare-and-swap is
a required part of the state-store contract: a store that does not implement it is refused at the
install boundary, never degraded to a plain write. The cross-process lock is never broken
automatically, because breaking a lock a live owner still holds would lose the very update the
lock protects, so an abnormal termination such as `SIGKILL` leaves the lock file in place and
later catalog writes fail until an operator removes it. The failure names the lock path and the
owner recorded in it. Catalog-backed
verification reports `marketplaceIndex: "signed-catalog"` and retains catalog revision, root,
metadata, and installed-tree provenance. It never downgrades that evidence to `not-applicable`
because a catalog path was used. A standalone signed record is the only `not-applicable` case.

`grant`, `revoke`, `setSafeMode`, `inspect`, `execute`, `stop`, and `close` are host operations.
Revocation and safe mode preserve the saved grant while preventing execution. A running invocation
receives an abort signal and teardown callbacks. The host enforces an invocation deadline and a
bounded teardown deadline; timeout and teardown are typed failures. An ended invocation cannot make
another port call. Teardown callbacks are all attempted, but the first callback or deadline
failure is returned as `NativeExtensionError` with code `teardown`. If entrypoint execution also
failed, that original failure is retained as the returned teardown error's `cause`.

These are in-process deadlines, not cancellation or sandboxing. A deadline aborts the context signal
and prevents later guarded port calls, but it cannot stop JavaScript that is already running or undo
an adapter operation that already started. Code that retains references outside the guarded context
is not contained by this host. The capability boundary therefore remains an API and availability
boundary, not an OS sandbox, worker isolation boundary, or guarantee of rollback for late effects.

Inspection deliberately reports `sandboxed: false`. The capability host in this version is an
in-process API boundary, not an OS sandbox, seccomp policy, worker isolation boundary, or guarantee
against extension code importing a host module through a future packaging mistake. The production
SDK exports only byte-only bundle definitions; function-injected fixture entrypoints are confined to
the source-only test-support module so the conformance suite can exercise the boundary, and
production bundle evaluation and process isolation are separate work. The trusted desktop runtime
also reports `trusted-desktop-escape` for navigation, subprocess, secrets, and dynamic code. Those
operations must never be described as sandboxed or portable.

The unchanged Obsidian compatibility runtime remains separately labeled and trusted. Its static
capability report and exact-bundle grant are a review and lifecycle gate, not this native runtime's
permission model.

## Minimal SDK workflow

The checked-in portable fixture at `fixtures/native-extensions/portable-summary/` is a byte-only
production bundle. Production SDK construction does not accept a caller-injected function:

```ts
import { definePortableExtension } from "threadleaf/native-extension/sdk";

const bundle = definePortableExtension({
  manifest,
  bundleBytes,
});
```

The source-only test-support module supplies callable fixture entrypoints for conformance tests.
The production host verifies bytes and fails closed until a future runtime evaluator is present.

The conformance tests exercise this fixture plus malicious undeclared, stale-bundle, authority-
growth, unavailable-port, cross-vault, safe-mode, revocation, teardown, timeout, trusted-desktop,
catalog freshness, key rotation, package rebind, tombstone re-add, catalog compare-and-swap, and
grant revoke/save interleaving cases. The tests use fake public ports and never touch a real vault.
