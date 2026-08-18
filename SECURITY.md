# Security policy

Threadleaf is a pre-1.0 stable release. Keep an ordinary external backup of any vault you use with
it, as you should for any local-first editor.

Report security issues through GitHub's private vulnerability reporting for
[`maherr/threadleaf`](https://github.com/maherr/threadleaf/security/advisories/new), not through a
public issue. Do not publish an exploit or private vault data in an issue, discussion, test fixture,
or pull request. See
[`docs/governance/security-response.md`](docs/governance/security-response.md) for the full reporting
channel, response targets, and disclosure policy.

Existing community plugins will run in a trusted compatibility mode because many expect desktop
filesystem, Node.js, and DOM access. Installing such a plugin is equivalent to running local code.
Threadleaf will distinguish this mode from its future capability-based native extension runtime.

The compatibility host has a versioned main-process resource policy. It bounds each renderer
operation, applies conservative memory and sustained CPU guardrails when Electron exposes valid
metrics, and terminates only the owning renderer after a breach. Missing metrics are visible as
unavailable and never treated as zero. These controls reduce hangs and runaway resource use; they
are not OS sandboxing, a permission boundary, or hard isolation from Node-capable plugin I/O.
