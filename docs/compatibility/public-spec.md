# Public compatibility specification

Threadleaf publishes a versioned, implementation-neutral compatibility contract at
[`public-spec/`](../../public-spec/). Its canonical identifier is `urn:threadleaf:spec:v1`.

The generated [static site](../../public-spec/site/index.html) is an offline view over the
machine-readable [dataset index](../../public-spec/data/index.v1.json). The source tree records
normative versus informative language, exact app and plugin versions, executable gates, fixture
hashes, provenance, licenses, and visible gaps. It does not claim behavior from package discovery,
roadmap text, or an untested external implementation.

Consumers should start with [`public-spec/v1/index.md`](../../public-spec/v1/index.md), validate the
datasets against [`public-spec/schemas/`](../../public-spec/schemas/), then run the linked gates.
Contributors must follow [`public-spec/v1/contributing.md`](../../public-spec/v1/contributing.md)
and keep cases license-clean, deterministic, and free of private vault data.

Run `pnpm public-spec:check` to verify generated tables, schema references, local anchors, fixture
hashes, exact version binding, and offline assets. Site publication itself remains a
maintainer-authorized operation.
