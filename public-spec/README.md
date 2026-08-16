# Public compatibility specification

Threadleaf's public compatibility contract lives in the versioned [`v1/`](v1/) source tree and
the machine-readable [`data/`](data/) datasets. The generated [`site/`](site/) directory is a
static, local, offline view over those datasets.

The specification is implementation-neutral. It records exact Threadleaf versions, executable
gates, fixture hashes, provenance, licenses, and visible gaps. It does not turn source inspection or
discovery into compatibility evidence, or redistribute proprietary source code or assets.

## Build and check

```sh
pnpm public-spec:build
pnpm public-spec:check
```

`public-spec:build` regenerates the datasets and site from repository evidence. The output is
deterministic and has no network or account requirement. `public-spec:check` verifies generated
drift, JSON shape, local links and anchors, schema references, fixture digests, exact versions,
and the absence of remote runtime assets.

Publishing the generated site is intentionally outside this local build and requires maintainer
authorization.
