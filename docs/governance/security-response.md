# Security response

This document is the detailed version of [`SECURITY.md`](../../SECURITY.md). If the two ever
disagree, treat that as a bug in this document and fix it, since `SECURITY.md` is what GitHub
surfaces automatically to a reporter.

## Private reporting channel

Report a vulnerability through GitHub's private Security Advisory flow on the canonical repository
([open a private report](https://github.com/maherr/threadleaf/security/advisories/new)), not through
a public issue, discussion, or pull request. That flow keeps the report private between the reporter
and the maintainers with advisory access until a fix is ready.

Do not include real vault content, note text, or personally identifying data in a report. A minimal
reproduction against a synthetic vault, matching the standard this project already holds contributed
fixtures to ([`CONTRIBUTING.md`](../../CONTRIBUTING.md): "keep user vaults out of tests and examples,
use synthetic data only"), is more useful than a real one and does not put anyone's data at risk in
transit.

## Response targets

These are targets, not a service-level agreement. Threadleaf is currently maintained by a single
maintainer with no staffed security function, and a target can slip; if it does, that is a
resourcing gap to disclose, not to miss silently.

- **Acknowledgment:** within 5 business days of a report reaching the private channel above.
- **Initial triage:** a severity assessment and a next-step response within 14 days of
  acknowledgment, even if the next step is "still investigating."
- **Fix or mitigation:** no fixed deadline, because it depends on severity and complexity, but the
  reporter is kept updated at least every 30 days until the issue is resolved or explicitly
  declined.

Severity is judged against what the affected surface already claims. A break of a claim in
[`SECURITY.md`](../../SECURITY.md) or the [compatibility contract](../compatibility/contract.md),
for example a way to escape the trusted compatibility runtime's process isolation
(the [architecture doc's plugin lifecycle boundary](../architecture.md#community-plugin-lifecycle-boundary))
rather than merely hang it, or a way to corrupt or lose vault content outside the documented
conflict-copy and recovery paths, is treated as higher severity than a bug in a capability already
labeled a trusted-desktop-escape
([native extension capability contract](../compatibility/native-extensions.md)), which is documented
as unsandboxed by design.

## Disclosure policy

Threadleaf follows coordinated disclosure. The reporter and the maintainer agree on a disclosure
timeline once a fix or mitigation is available. Absent an agreement, 90 days after acknowledgment is
the default ceiling before the reporter may disclose independently: long enough for a small team to
ship a fix, short enough that a report cannot be sat on indefinitely. Actively exploited issues are
handled faster and disclosed sooner by mutual agreement.

A fixed security issue is credited in the release's [`CHANGELOG.md`](../../CHANGELOG.md) entry and,
once the project has one, a security advisory, unless the reporter asks to stay anonymous. There is
no bug bounty; do not expect payment for a report.

## What is explicitly out of scope

Consistent with [`SECURITY.md`](../../SECURITY.md), running an existing Obsidian-ecosystem community
plugin is equivalent to running local code by design: those plugins execute in a labeled trusted
compatibility runtime with process isolation, memory and CPU guardrails, and typed diagnostics, but
those are availability controls, not OS sandboxing or hard isolation from Node-capable plugin I/O. A
report that a compatibility plugin can read or write files, call the network, or otherwise act like
the local code it is, is not a vulnerability; a report that it can escape its own renderer process,
corrupt another plugin's state, or bypass the resource guardrails without a crash is. Native
extensions currently report `sandboxed: false` for the same reason
([native extension capability contract](../compatibility/native-extensions.md)): the capability host
is an in-process API and per-vault grant boundary, not a sandbox, until that changes.
