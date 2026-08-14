# Governance

This is the index for Threadleaf's governance documents. They exist to satisfy the Phase 6 exit gate
in [the roadmap](../roadmap.md#phase-6-ecosystem-and-public-launch): public releases should be safe
to recommend without maintainer caveats, and the project should be able to continue if the original
stewards disappear. Read the linked documents for the parts that need detail; this page only indexes
them and states what is not written elsewhere.

## The documents

- [Trademark and naming](trademark-and-naming.md): Threadleaf's own naming policy, and its posture
  on the Obsidian trademark.
- [Security response](security-response.md): how to report a vulnerability, response targets, and
  disclosure policy.
- [API stability and deprecation](api-stability-and-deprecation.md): what is a versioned contract,
  what is internal and can change without notice, and how a breaking change is announced.
- [Release authority and succession](release-authority-and-succession.md): who can cut a release
  today, and what a fork needs to continue the project without the current maintainer.

## Decision making

Threadleaf does not yet have a formal decision-making body, a vote, or a written amendment process,
because it has one identified maintainer and no public repository yet. Two things constrain that
maintainer's discretion in the meantime:

- [`docs/charter.md`](../charter.md) states the project's mission, invariants, and non-goals.
  Product and architecture decisions are expected to be consistent with it; a decision that
  contradicts an invariant should change the invariant first, in a visible commit, not the other way
  around.
- [`AGENTS.md`](../../AGENTS.md) states repository-wide invariants that apply to every change,
  independent of who proposes it; see Contribution acceptance criteria below.

This page will describe a broader decision process, for example a second maintainer, a review
requirement, or a documented escalation path, once one actually exists. Until then, stating that one
exists would be inaccurate.

## Contribution acceptance criteria

A change is accepted when it is consistent with [`AGENTS.md`](../../AGENTS.md)'s invariants and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md)'s checklist, in particular:

- **Compatibility claims require evidence.** "Compatibility claims require an executable fixture or
  integration test" (`AGENTS.md`). A change that says a plugin, theme, or vault behavior works must
  ship or point at the fixture that proves it; see the
  [compatibility contract](../compatibility/contract.md) for the level system this evidence is
  measured against.
- **No proprietary or copied material.** The compatibility runtime may use public API definitions,
  open formats, independently written behavior tests, and open-source plugins. It must not contain
  copied proprietary application code, assets, or bundled resources (`AGENTS.md`).
- **Vault mutations are explicit, atomic, recoverable, and tested under interruption** (`AGENTS.md`).
  A change that writes to a user's vault needs an interruption fixture, not just a happy-path test.
- **The kernel stays small.** Optional product behavior belongs in first-party plugins when
  practical (`AGENTS.md`), and existing Obsidian-ecosystem plugins run only in the labeled trusted
  compatibility runtime, which the native extension contract keeps deliberately separate: it is "a
  review and lifecycle gate, not this native runtime's permission model"
  ([native extension capability contract](../compatibility/native-extensions.md)).
- **No new network or account requirement in an offline workflow** (`AGENTS.md`).
- **Public specification and corpus contributions** follow the stricter normative rules in
  [`public-spec/v1/contributing.md`](../../public-spec/v1/contributing.md): implementation-neutral,
  reproducible offline, license-clean, and reviewed against the case schema.
- `pnpm check` passes, and the change describes observable behavior and limitations rather than
  intent (`CONTRIBUTING.md`).

These are the same criteria a maintainer applies when merging their own change; there is no separate,
lighter bar for maintainer-authored commits.

## Scope of maintainer authority

Today, "maintainer authority" is a mechanical fact, not a role with a charter: it is whoever holds
push and tag rights on the canonical repository and the repository secrets that
[`release.yml`](../releases.md#signed-release-candidate) requires to sign and publish a release.
There is no `CODEOWNERS` file and no separate release-approval body yet. See
[Release authority and succession](release-authority-and-succession.md) for what that authority can
and cannot do, and what happens if it goes away.
