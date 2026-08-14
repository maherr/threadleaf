# Release authority and succession

This document states who can produce a Threadleaf release today, and what a successor, individual
or fork, would actually need to keep the project going if the current maintainer disappeared.

## Who cuts a release today

Threadleaf has one identified maintainer and no public repository yet:
[`docs/releases.md`](../releases.md) notes in several places that the hosted release lanes have no
public remote to run against. Release authority is therefore a mechanical fact rather than a role
with a charter: it is whoever holds push and tag rights on the eventual canonical repository
(`https://github.com/maherr/threadleaf`, per [`package.json`](../../package.json)) and the repository
secrets that [`.github/workflows/release.yml`](../releases.md#signed-release-candidate) requires
(`MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`,
`WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`). That workflow only runs on manual dispatch against
a tag exactly matching `v<package.json version>`, and its `publish` input defaults to `false`, so
producing a release is always a deliberate, attributable action, never a side effect of a merge.
There is no `CODEOWNERS` file and no separate release-approval body yet; a version bump and a tag are
the only two things that actually gate a release, and both are visible in git history.

Unsigned contributor builds do not need any of this. `pnpm run release:linux` and the equivalent
macOS and Windows package commands ([`docs/releases.md`](../releases.md)) run from a clean checkout
with no repository secrets, so anyone with the source and the right native toolchain can already
build and verify a Threadleaf package without asking the maintainer for anything. Only the signed,
published lane requires the credentials above.

## If the current maintainer disappears

Threadleaf's fork-continuity story is that nothing needed to keep going lives only in one person's
head, or in a system a departed maintainer controls. Concretely, in this repository today:

- **The vault behavior and compatibility specification** is versioned, generated, and checked in:
  `urn:threadleaf:spec:v1` under [`public-spec/`](../../public-spec/), with its own datasets, JSON
  schemas, and versioning policy in
  [`public-spec/SPECIFICATION.md`](../../public-spec/SPECIFICATION.md).
- **The fixture and benchmark corpus** is checked in and separately licensed `CC0-1.0`;
  [`public-spec/v1/index.md`](../../public-spec/v1/index.md) describes the same-vault and Excalidraw
  corpora as "independent CC0-1.0 synthetic corpora," and the public scale corpus and its budgets are
  documented in [`docs/performance.md`](../performance.md). CC0 on the fixtures matters specifically
  for continuity: even a maintainer who disagreed with everything else about the project could not
  withhold the test corpus from a fork, because it was never theirs to withhold.
- **The build is reproducible and self-contained.** `pnpm run test:package-reproducible` builds the
  unpacked Linux application twice, independently, and requires identical files, symlinks, modes,
  sizes, and SHA-256 hashes; the CI workflow pins every third-party action to an immutable commit and
  is itself checked by an integrity fixture that fails if a native lifecycle step is removed or made
  skippable ([`docs/releases.md`](../releases.md)). None of this depends on a hosted service only the
  current maintainer can reach.
- **The application itself is `AGPL-3.0-or-later`** ([`LICENSE`](../../LICENSE)). Copyleft is a
  structural continuity guarantee, not a promise: anyone who receives a distributed copy already has
  the right to the corresponding source and the right to keep modifying and redistributing it. A
  fork does not need permission to exist, only to be named appropriately; see
  [Trademark and naming](trademark-and-naming.md).
- **The contribution and review rules are written down**, not tribal knowledge:
  [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`AGENTS.md`](../../AGENTS.md), and
  [`public-spec/v1/contributing.md`](../../public-spec/v1/contributing.md) state what a change needs
  to be accepted, independent of who is doing the accepting.
- **The native extension SDK's license is the one open exception.** As noted in
  [API stability and deprecation](api-stability-and-deprecation.md), whether the SDK stays AGPL or
  moves to a permissive license is an explicitly undecided question in
  [`docs/architecture.md`](../architecture.md#decisions-still-to-make). A successor should resolve it
  deliberately rather than assume either answer.

What this repository cannot promise is that a specific person will step up to maintain a fork, sign
releases, or run a plugin directory if the current maintainer disappears. What it can and does
promise is that nothing about continuing the project requires that specific person: the spec, the
fixtures, the corpus, and the build are all already in the tree, under an open license, reproducible
without a hosted secret.

## Mirror expectations

There is no independent mirror today, because there is no public remote yet for anything to mirror.
Stating that a mirror already exists would be false.

Before Threadleaf is presented as safe to recommend without maintainer caveats
([the roadmap's Phase 6 exit gate](../roadmap.md#phase-6-ecosystem-and-public-launch)), the intent is
to designate the GitHub repository named in [`package.json`](../../package.json) as canonical and add
at least one independent, read-only mirror on a different host, so a single host outage or account
action cannot strand the project's history or its open license obligations. This is operationally
cheap precisely because of the points above: the repository has no Git LFS content, no external
service dependency, and, outside the signed release lane, no secret that must also be mirrored. This
is a stated intent tied to an existing roadmap item, not a claim that it is already done.
