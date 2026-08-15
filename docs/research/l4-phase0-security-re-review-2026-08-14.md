# Threadleaf L4 Phase 0 security re-review: repair round 2

**Last updated:** 2026-08-15 09:28:29 EDT

## Verdict

The ambient Node `require` bypass is reachable in Threadleaf's real Electron plugin renderer. A
synthetic plugin resolved `globalThis.require("node:child_process")` without calling the sealed
`require` parameter. The existing static capability scanner nevertheless reports
`window.require`, `globalThis.require`, and `global.require` child-process imports as
`subprocess`. The single construction-policy resolver compares the complete measured static
capability set with the exact reviewed set after exact package-identity checks and before any
plugin construction. An ambient import that was not reviewed therefore fails closed before its
bytes execute.

This cleared the Step 0 architectural stop gate without changing the proven renderer, resolver,
or sealed-loader design. The repair round also authenticates reviewed registry digests, makes
both replay-ledger exhaustion paths diagnosable, guards every plugin-facing main-process IPC
handler against plugin-renderer senders, completes the builtin and native-addon authority
taxonomy, removes the dead compatibility-level union member, and places the package E2E proof in
both Linux CI workflows.

## Scope and topology

- Reviewed lane: `lane/l4-phase0`
- Repair baseline: `3b2aaba`
- Correct merge-base with `main`: `54bfb907`
- `d5d5789` is a commit on the lane, not its merge-base.
- The frozen [Level 4 plugin bridge specification](../architecture/level-4-plugin-bridges.md) was
  not edited.
- No merge and no push were performed.

The implementation commits before this receipt are:

1. `6bb34eb Pin ambient require probe coverage`
2. `7a28f85 Authenticate reviewed registry digests`
3. `c2d75d5 Diagnose plugin replay exhaustion`
4. `218cce2 Complete plugin authority mappings`
5. `3f4510e Gate plugin package E2E in Linux CI`

## Step 0: ambient `require` probe

### Exact live command and code path

The permanent probe is [check-plugin-ambient-require.mjs](../../scripts/check-plugin-ambient-require.mjs)
and runs through:

```sh
pnpm run test:plugin-ambient-require
```

It launches Electron 43.3.0 under an isolated Xvfb display, forces the renderer command line to
`--ozone-platform=x11`, disables GPU use, and gives the `WebContentsView` the production plugin
preferences:

```js
contextIsolation: false,
nodeIntegration: true,
sandbox: false,
```

The synthetic plugin's decisive code is:

```js
const childProcess = globalThis.require("node:child_process");
observed.childProcessResolved = Boolean(childProcess);
observed.childProcessSpawnType = typeof childProcess.spawn;
```

The probe compiles that source with the same relevant CommonJS shape as the host, passes a sealed
`require` as the function parameter, and counts calls to that parameter. Its exact live receipt
was:

```json
{"electronVersion":"43.3.0","nodeVersion":"24.18.1","webPreferences":{"contextIsolation":false,"nodeIntegration":true,"sandbox":false},"rendererCommandLineHasX11":true,"rendererCommandLineHasWayland":false,"rendererCommandLinePlatformArguments":["--ozone-platform=x11"],"pluginResult":{"globalThisRequireType":"function","windowRequireType":"function","globalRequireType":"function","childProcessResolved":true,"childProcessSpawnType":"function","errorName":null,"errorMessage":null,"sealedRequireCalls":0}}
```

Headline interpretation: ambient `require` is reachable and bypasses the passed sealed loader,
as proved by `childProcessResolved: true` and `sealedRequireCalls: 0`.

### Why the bypass does not cross the reviewed construction gate

The scanner's Node child-process rule in
[plugin-capability-scanner.ts](../../src/main/plugin-capability-scanner.ts) recognizes the
`require("node:child_process")` substring even when `require` is a member access. The permanent
test in [plugin-capability-scanner.test.ts](../../src/main/plugin-capability-scanner.test.ts)
asserts that each of these inputs reports exactly `subprocess`:

```js
window.require("node:child_process");
globalThis.require("node:child_process");
global.require("node:child_process");
```

The construction resolver in
[plugin-construction-policy.ts](../../src/main/plugin-construction-policy.ts) first binds the
request and inspected package to the complete reviewed package identity, then requires exact set
equality between the inspected static capabilities and `expectedStaticCapabilities`. A new
ambient import is therefore not treated as a reduced-authority runtime choice. It changes the
measured set and yields `authority-profile-mismatch` before the allow dispatch can be constructed.

Red proof: the child-process scanner expression was temporarily weakened so member-form imports
were no longer detected. The new scanner test failed with an empty capability set where
`["subprocess"]` was expected. Restoring the expression returned the focused test to green.

## Finding 1: registry digest authentication

The compatibility registry generator now recomputes, rather than merely shape-checks, both
reviewed digests:

- `packageIdentityDigest` is recomputed from the complete package identity.
- `authorityDigest` is recomputed from the profile payload that binds the package-identity
  digest, expected static capabilities, required authorities, execution profile, and platforms.

The generator and TypeScript profile parser now share the exact runtime canonicalizer in
[authority-json-runtime.mjs](../../src/shared/authority-json-runtime.mjs), with the TypeScript
surface re-exporting it through [authority-json.ts](../../src/shared/authority-json.ts). This
removes the risk of two implementations drifting while still leaving the separately documented
strict-JCS receipt work outside Phase 0.

Permanent proof:

```sh
pnpm run test:compatibility-registry-authority-digests
```

The fixture promotes a synthetic evidence row to Level 4, keeps the real `mainSha256`, and tests
both forgeries:

1. Wrong `packageIdentityDigest`, followed by a recomputed internally consistent
   `authorityDigest`.
2. Correct identity fields with a wrong `authorityDigest`.

Before the repair, case 1 exited 0 and published the forged row. After the repair, the command
rejects both cases and prints:

```text
compatibility registry rejected forged Level 4 identity and authority digests
```

Mutation proof: temporarily bypassing the new digest equality rejected neither forgery, so the
negative test failed because the nested generator returned 0. Restoring the equality checks made
the test green.

## Finding 2: replay-ledger diagnostics and plugin IPC sender checks

### Distinct ledger exhaustion

`replay-ledger-exhausted` is now a typed construction denial code. Both bounded ledgers use it:

- The main-process resolver rejects once its consumed-policy ledger reaches 4,096 entries.
- The renderer-side plugin host rejects once its consumed-attempt ledger reaches 4,096 entries.

Duplicate attempts, policy digest drift, and authority epoch drift continue to use
`policy-epoch-stale`. Operations can now distinguish actual authority churn from a full replay
ledger without weakening either fail-closed path.

Both tests fill the bound through public behavior. The resolver test calls real
`resolveAndConsume()` operations with unique attempt identifiers. The host test sends valid,
digest-consistent construction dispatches. Neither test injects entries into a private `Set`.

Mutation proofs:

- Changing the resolver's bound result back to `policy-epoch-stale` failed the exact-code test,
  which received `policy-epoch-stale` instead of `replay-ledger-exhausted`.
- Applying the same mutation in the host failed its exact-code test in the same way.

### Main-renderer-only plugin IPC

[plugin-ipc-sender-guard.ts](../../src/main/plugin-ipc-sender-guard.ts) supplies one behavior guard
for plugin-facing main-process operations. All 24 plugin-facing `ipcMain.handle` registrations in
[main.ts](../../src/main/main.ts) now invoke it with
`isMainRendererSender(event.sender)`, including `reloadPlugin` and its neighboring mutation paths.
A plugin renderer that holds `ipcRenderer` cannot consume the host replay ledger by invoking the
main-window reload endpoint.

The permanent test proves both the behavior and the complete fixed endpoint inventory. A false
sender throws before the operation can run, and a structural scan requires the same guard in each
handler. The endpoint matcher also uses a token boundary so `reloadPlugin` cannot be falsely
satisfied by the `reloadPlugins` handler.

Mutation proof: removing only the `reloadPlugin` guard failed the structural test with
`missing sender guard for ipcChannels.reloadPlugin`. Restoring it made the behavior and structural
tests green.

## Finding 3: honest and complete authority taxonomy

The host now states the current limitation next to `builtinAuthority()`: every reviewed Phase 0
profile discloses all authorities mapped there. The mapping is forward-looking enforcement for a
future narrower reviewed profile, not an active discriminator among the six profiles shipped in
Phase 0. The scanner, exact profile equality, package identity, and grant checks remain active
controls today. This receipt does not claim otherwise.

The forward-looking mapping is now complete for the identified gaps:

| Load | Required authority |
|---|---|
| `node:sqlite` | `filesystem` |
| `node:inspector` | `dynamic-code` |
| `node:v8` | `dynamic-code` |
| In-root `.node` native addon | `dynamic-code` |

Each permanent test creates a synthetic narrow profile through the real
`PluginConstructionPolicyResolver`, withholds exactly the mapped authority, mints a
digest-consistent dispatch, and asks the real host to resolve or load it. Each path must fail with
`authority-profile-mismatch`.

Red proof: reverting all four mappings caused four named failures. `node:sqlite`,
`node:inspector`, and `node:v8` resolved when they should have been denied. The in-root native
addon reached `runtime-load-failed` instead of being stopped with `authority-profile-mismatch`.
Restoring the mappings returned all four tests to green.

## Finding 7: dead compatibility-level union member

The compatibility registry's verified level is now typed as the only reachable value, `0`, in
both [plugins.ts](../../src/shared/plugins.ts) and
[compatibility-catalog.ts](../../src/cli/compatibility-catalog.ts). The stale `0 | 4` type no
longer implies a source can independently produce Level 4.

Red proof: narrowing the production unions left a migration fixture assigning `4`; TypeScript
failed at that exact assignment. Updating the fixture to the reachable value `0` restored the
typecheck.

## Finding 6: package E2E is now a Linux CI gate

The CI gap was fixed rather than recorded as deferred work. The source command retains its local
build-first behavior:

```text
test:plugin-packages-e2e = pnpm run build && pnpm run test:plugin-packages-e2e:built
```

The new `test:plugin-packages-e2e:built` command runs the E2E against existing built artifacts.
Both the normal Linux CI job and the signed Linux release job invoke it exactly once after
`pnpm run release:linux`, reusing the package build that those jobs already verify. It is not added
to the cross-platform `pnpm run check` because this Electron package proof is Linux and Xvfb
specific.

The cheap [check-plugin-packages-e2e-config.mjs](../../scripts/check-plugin-packages-e2e-config.mjs)
gate is part of `pnpm run check`. It parses both workflow files and pins the Linux runner, Xvfb
installation, command split, ordering after `release:linux`, and exactly-once execution.

Mutation proof: removing the E2E step from the normal CI workflow failed with
`CI Linux job must run plugin E2E after the verified build.` Restoring the step made the config
gate green.

## Final verification receipt

The native addon is gitignored, so it was rebuilt before the native-dependent gates. The final
serialized command was:

```sh
flock /tmp/threadleaf-heavy-gate-b.lock sh -c \
  'pnpm run build:native && pnpm run test:plugin-packages-e2e && pnpm run check'
```

It ran in a transient user unit after both the outer launcher and the locked inner command
verified `MemAvailable >= 8388608 kB`. The launch preflight observed 34,986,052 kB available.

| Gate | Result |
|---|---|
| Native addon build | RC 0 |
| Plugin package E2E | RC 0 |
| Full `pnpm run check` | RC 0 |
| systemd unit | `Result=success`, `ExecMainCode=0`, `ExecMainStatus=0` |
| Runtime | 3 minutes 27.142 seconds wall, 11 minutes 17.037 seconds CPU |
| Peak memory | 2.5 GB |

The rebuilt native artifact was 30,952 bytes with mtime
`2026-08-14 22:54:30.672266077 -0400`.

The package E2E receipt reported all load-bearing booleans true:

```json
{"pluginId":"obsidian-excalidraw-plugin","version":"2.26.4","reviewAssets":3,"integrityRaceBlocked":true,"authorityGateVerified":true,"authorityProfileDenialVerified":true,"installedDisabled":true,"uninstallRestored":true}
```

The full suite result was:

```text
Test Files 148 passed | 1 skipped (149)
Tests      1531 passed | 3 skipped (1534)
```

The full check also confirmed six identity-bound reviewed profiles, three negative profile
controls, rejection of forged Level 4 digests, CI placement of the package E2E, 19 shipped native
extension files, 11 native production sources, 172 plugin-construction production sources, and
19 built plugin-construction artifacts. The format gate returned green while reporting 19 warning
and 38 informational diagnostics; none was an error.

## Boundary retained

This repair does not claim that the sealed CommonJS loader removes ambient Electron authority.
It does not. The proven Phase 0 boundary is exact reviewed package identity plus exact static
capability equality before construction, with the sealed resolver constraining dependency loads
that do reach it. A future profile that intentionally becomes narrower can rely on the completed
builtin and native-addon taxonomy, but today's six broad profiles do not exercise a denial at
that layer.

## Known limitation and Phase 1 governance gate

The grant-time static capability scan is a bypassable backstop to human review. Computed
require-alias access (`globalThis["require"](...)`) evades the scanner's regexes. Capability grants
are construction-time declarations, not runtime enforcement. No narrow-authority (below full
ambient-Node) plugin profile ships until ambient `require` is neutralized in the plugin realm
(Phase 1). Real containment today is SHA-256 pinning plugin bytes to human-reviewed profiles.

**Governance gate:** no narrow-authority profile ships until ambient `require` is neutralized in
the plugin realm.
