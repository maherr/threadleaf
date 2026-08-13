# Contributing public compatibility cases

Status: normative contribution contract.

Contributions MUST remain implementation-neutral and reproducible offline. A case may describe a
portable Markdown behavior, a bounded appearance or CLI projection, a migration-preview boundary,
or a trusted desktop compatibility workflow. It MUST NOT require proprietary application code,
copied product assets, decompiled resources, a private vault, credentials, or a live network.

## Required case fields

Use the [case schema](../schemas/case.v1.schema.json). Every case MUST include:

- a stable, unique `id`, `category`, and `surface`;
- exact source fixture paths and a deterministic `operation`;
- an `expected` result that names byte, semantic, or explicitly allowed output behavior;
- an `allowedVariance` list, which must be empty when no variance is allowed;
- `support` set to `supported` or `unsupported`;
- a `license` identifier and `provenance` record for every contributed fixture; and
- a manifest or fixture reference whose SHA-256 digest can be checked offline.

An unsupported case is useful evidence. It MUST include a reason and MUST NOT be counted as a
passing implementation result.

## Review rules

Reviewers check that paths stay inside the fixture root, source bytes are license-clean, manifests
are deterministic, and no private or network-derived value enters expected output. A case that
needs an external product may record an independently observed result separately, with date,
version, platform, and provenance. It must not claim that an untested external implementation
passes.

The canonical runner is the owner of executable semantics. Do not copy its implementation into a
fixture or duplicate a generated registry table by hand. When a contract changes, update its
source evidence and generator, regenerate outputs, and add a changelog entry.

## Local checks

Run these commands from a clean checkout:

```sh
pnpm corpus:check
pnpm public-spec:check
pnpm check
```

The checks do not access the network. A maintainer may publish the already-built `public-spec/site`
tree separately after inspecting its exact content and target.
