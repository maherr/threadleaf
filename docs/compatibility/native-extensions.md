# Native extension capability contract

Native Threadleaf extensions are a separate runtime from the trusted CommonJS compatibility host.
The first stable manifest is version 1, with API version `1.0`. Its machine-readable schema is
[`native-extension-manifest.v1.schema.json`](./native-extension-manifest.v1.schema.json), and the
TypeScript vocabulary is exported from `src/native-extension/manifest.ts`.

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
vault-owned settings file. The application must supply its OS application-data path. The in-memory
store is intended for tests and disposable hosts.

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
| `subprocess` | host process adapter | no | trusted desktop escape |
| `secrets` | named secret provider | no | trusted desktop escape |
| `dynamic-code` | host-provided evaluator | no | trusted desktop escape |

An unavailable adapter returns `capability-unavailable`. A missing grant, stale digest, revoked
grant, safe mode, undeclared call, and cross-vault identity are distinct typed failures. A portable
runtime rejects desktop-only manifests and capabilities before an adapter is called. URL and secret
name inputs are validated at the public boundary. Vault writes still require the caller's revision
choice and are delegated to the host's recoverable writer.

## Lifecycle and trust

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
against extension code importing a host module through a future packaging mistake. The fixture
entrypoint is supplied as a typed SDK function so the conformance suite can exercise the boundary;
production bundle evaluation and process isolation are separate work. The trusted desktop runtime
also reports `trusted-desktop-escape` for navigation, subprocess, secrets, and dynamic code. Those
operations must never be described as sandboxed or portable.

The unchanged Obsidian compatibility runtime remains separately labeled and trusted. Its static
capability report and exact-bundle grant are a review and lifecycle gate, not this native runtime's
permission model.

## Minimal SDK workflow

The checked-in portable fixture at
`fixtures/native-extensions/portable-summary/` reads one note and writes a generated summary using
only the public vault port:

```ts
import { definePortableExtension } from "threadleaf/native-extension/sdk";

export default definePortableExtension({
  manifest,
  bundleBytes,
  entrypoint: async (context, input: { path: string; outputPath: string }) => {
    const note = await context.vault.readText({
      vaultId: context.vaultId,
      relativePath: input.path,
    });
    return context.vault.writeText({
      vaultId: context.vaultId,
      relativePath: input.outputPath,
      content: `# Summary\n\n${note.content}\n`,
      expectedRevision: null,
    });
  },
});
```

The conformance tests exercise this fixture plus malicious undeclared, stale-bundle, authority-
growth, unavailable-port, cross-vault, safe-mode, revocation, teardown, timeout, and trusted-
desktop cases. The tests use fake public ports and never touch a real vault.
