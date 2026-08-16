# API stability and deprecation

Threadleaf publishes several different surfaces to the outside world. They do not all carry the same
stability promise, and conflating them is exactly the failure mode this document exists to prevent.
It names each surface, states what it promises today, and states what changes once Threadleaf calls
itself 1.0 (the roadmap's own
[Phase 6 exit gate](../roadmap.md#phase-6-ecosystem-and-public-launch)).

## Everything is pre-1.0

Threadleaf is `0.1.0-beta.7` ([`package.json`](../../package.json)).
[`CHANGELOG.md`](../../CHANGELOG.md) states that the project "uses Semantic Versioning... once public
releases begin," meaning SemVer is not strictly in force yet. Read every "stable" claim below as
"governed by an explicit, versioned contract that changes deliberately and is recorded in the
changelog," not as "will never break." Nothing described as stable here is exempt from breaking in a
beta if a compatibility or safety invariant in [`docs/charter.md`](../charter.md) requires it; that
has priority over API stability while the project is pre-1.0.

## Versioned, contract-governed surfaces

These surfaces have an explicit version number, a schema, or both, and a change to their meaning is
expected to be a deliberate, recorded event rather than an incidental refactor:

- **The native extension manifest and SDK.** Version 1, API version `1.0`
  ([native extension capability contract](../compatibility/native-extensions.md); schema at
  [`native-extension-manifest.v1.schema.json`](../compatibility/native-extension-manifest.v1.schema.json)).
  Consumed from source today through the package's `exports` map (`.`, `./native-extension`,
  `./native-extension/sdk`, `./private-state-lock` in [`package.json`](../../package.json)); the
  package is `"private": true` and is not currently published to a registry, so consuming the SDK
  means building from source or a git dependency, not `npm install`. Unknown capability IDs,
  duplicate IDs, invalid entrypoints, unsupported manifest versions, and portable declarations of
  desktop-only capabilities already fail closed rather than degrade silently. Adding a capability to
  a manifest is authority growth and requires a fresh review; it cannot inherit an existing grant.
- **The public compatibility specification**, `urn:threadleaf:spec:v1`
  ([`public-spec/SPECIFICATION.md`](../../public-spec/SPECIFICATION.md)). Its own version and URI
  policy is the authority here and is not restated in full: a patch release may correct wording or
  presentation without changing the v1 schema, and any change to field meaning, conformance levels,
  or byte semantics requires a new specification version and a changelog entry. This covers the
  generated API vocabulary, the CLI contract, the theme contract, the fixture manifest, the
  conformance report, and the plugin registry datasets under `public-spec/data/`.
- **The headless CLI's command surface** (IDs, aliases, syntax forms, exit codes, output formats;
  documented in [`docs/cli.md`](../cli.md)) is regenerated from `src/cli/command-line.ts` and
  published as part of the same public specification's CLI dataset, so it inherits that
  specification's versioning policy rather than having its own.
- **The Markdown processor family** (post processors, fenced-code block processors, and the
  render-child lifecycle that manages them) has its own normative contract,
  [`docs/compatibility/open-plugin-api.md`](../compatibility/open-plugin-api.md), which states
  plainly that it is "normative for the signatures and observable behavior below." It is also
  recorded as the `markdown-processors` surface in the public specification's generated API dataset
  (`public-spec/data/api.v1.json`), so, like the CLI, it inherits that specification's versioning
  policy rather than having its own, even though it remains desktop-compatibility-only and is not a
  portable native-extension API.

## Explicitly unstable: the compatibility runtime's internals

The independently implemented CommonJS `obsidian` compatibility module that lets existing, unmodified
community plugins run (`AGENTS.md`: "existing plugins run only in the clearly identified trusted
compatibility runtime") is not a versioned public API for new development, and carries no
deprecation window. It exists to track whatever surface existing third-party plugin bundles actually
call, measured per plugin and per compatibility level in the
[compatibility contract](../compatibility/contract.md), and the module's remaining, undocumented
surface can change, at any time and without notice, whenever that is what fixing or extending
measured compatibility requires. A family that has its own normative contract, such as the Markdown
processor family covered above, is the exception: it changes only under the public specification's
version policy, not silently, because
[`docs/compatibility/open-plugin-api.md`](../compatibility/open-plugin-api.md) and the
`markdown-processors` entry in `public-spec/data/api.v1.json` already pulled it out of
"undocumented." Do not build a new integration against the rest of this module's internals; it is
scoped to running plugins written against upstream Obsidian's API, not to being a second stable API
of Threadleaf's own. New extension authors should
target the versioned native extension API above instead (`docs/charter.md` invariant: "Native
extensions use declared capabilities and a versioned API").

The same applies to everything else not named above: application internals under `src/` that are not
exposed through the package `exports` map, the CLI, or the public specification datasets, and every
piece of private per-vault application state (workspace tabs, bookmarks, appearance selections,
native extension grants, and similar). These are explicitly documented elsewhere as private state
outside the vault, not a contract with a third party
([`docs/private-state-lock.md`](../private-state-lock.md) describes one such migration boundary), and
can change shape between releases through an internal migration rather than a public deprecation
process.

## The native extension SDK's license is still an open decision

[`docs/architecture.md`](../architecture.md#decisions-still-to-make) lists "Native extension SDK
license and capability vocabulary" as a decision not yet made. Today the SDK ships under the same
`AGPL-3.0-or-later` as the rest of the application, because there is no separate license file for it.
The [README](../../README.md#license) already flags that "a future standalone extension SDK may use a
permissive license so plugins can target Threadleaf without inheriting the application's license."
That has not happened yet. Treat the SDK's current license as AGPL until a separate license file says
otherwise, and expect this document and the README to be updated together when it does.

## Deprecation windows and breaking-change announcements

**Today, pre-1.0:** any of the surfaces above can still change between beta releases, including in a
breaking way, without a soak period. What is consistent is that a breaking change will be recorded
as a `Changed` or `Removed` entry in [`CHANGELOG.md`](../../CHANGELOG.md), which already follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and that a native extension manifest or API
version bump, or a public specification version bump, accompanies a change to field meaning or byte
semantics, per the policies cited above. There is no dedicated `Deprecated` changelog section in use
yet; adopting one, ahead of removal rather than concurrent with it, is expected as the project gets
closer to 1.0.

**At and after 1.0**, once Semantic Versioning is actually in force
([`CHANGELOG.md`](../../CHANGELOG.md)): a breaking change to the native extension API or the public
specification requires a major version bump of the relevant contract, not just the application, and
a capability or command intended for removal is marked deprecated in the changelog at least one
minor release before it is removed, so a consumer pinned to a minor version has a documented window
to react. [The roadmap](../roadmap.md#phase-6-ecosystem-and-public-launch) commits only to
documenting "API stability, deprecation, succession, and fork continuity before calling the project
1.0"; it does not itself specify a window. This document, and the specific windows above, is the
concrete form of that roadmap item, not a separate promise the roadmap already makes.
