# Automated plugin package inspection

`pnpm test:plugin-package-inspection` runs the offline package-inspection fixture. It builds the
inspector, materializes each exact fixture package in a temporary disposable vault, and checks the
machine-readable result. `pnpm test:plugin-package-authority` then drives an exact fixture through
review, inspection receipt, apply, discovery, grant, enablement, and changed-bundle rejection.
These checks do not fetch a release, open a user vault, or update the authored compatibility
registry.

The input is an exact `manifest.json`, `main.js`, and optional `styles.css` byte set. Every asset
has a declared SHA-256 digest, and provenance carries the exact package version and release tag.
The inspector rejects a floating release label, digest mismatch, malformed manifest, invalid
package entry, unsupported platform, undeclared relative dependency, and undeclared Node builtin.

Each result contains these independently statused stages:

- package shape and exact asset bytes;
- manifest and minimum app/platform checks;
- dependency and static authority reports;
- banned/private primitive diagnostics;
- bounded activation in the existing trusted compatibility runtime;
- command, view, extension, and processor registration inventory;
- disposable-vault and temporary-root diffs;
- cleanup and timeout outcomes.

The report's compatibility level stops at Level 3 (activation plus registration inventory). Level 4
requires a named end-to-end workflow and is not manufactured by this package check. A candidate can
be written only from an all-gates-passed exact report. The candidate remains bound to the manifest,
bundle, stylesheet, and provenance digests.

Reviewed package management retains one compact inspection receipt from this report. The receipt
binds the exact manifest, `main.js`, optional stylesheet, release provenance, and static authority
report to their SHA-256 digests. Review stages the receipt, apply stores it beside the package,
and managed discovery uses its static authority report for grant and enablement decisions. It does
not run a second independent capability scan for a reviewed package. Missing or changed receipt
evidence, or any changed bound asset, makes the managed package invalid and blocks enablement.
Unmanaged packages remain discoverable as compatibility input and use the ordinary static scanner
until they pass the reviewed package workflow. A strict report that does not pass may still be
retained as a Level 0 receipt for an exact user-reviewed package; it carries the failure status and
does not claim compatibility or a workflow result.

Network authority is blocked by default. A caller may opt into `deterministic-fixture` mode only
with an explicit runtime factory that supplies the local fixture; the inspector does not pretend to
enforce that factory's network policy. A disposable-vault write is reported as a diff. A write
outside the temporary inspection root fails the cleanup gate when it is observed. Writes to
unrelated host paths, synchronous JavaScript that cannot be interrupted by an in-process promise
deadline, and unobserved code paths remain outside coverage. These are trusted compatibility-host
checks, not a security sandbox or proof that a Node-capable community plugin is safe.

Fixtures cover a passing registration, undeclared filesystem/path authority, a runaway activation,
global mutation, teardown failure, network denial, temporary-vault writes, observed boundary
escapes, and evidence redaction. CI uses only these reproducible offline fixtures. Live release
checks are separate and must be explicitly requested.
