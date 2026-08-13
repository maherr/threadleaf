# Security policy

Threadleaf is pre-alpha and must not be trusted with important vaults yet.

When the public repository enables private vulnerability reporting, report security issues through
that channel instead of a public issue. Until then, do not publish an exploit or private vault data
in an issue, discussion, test fixture, or pull request.

Existing community plugins will run in a trusted compatibility mode because many expect desktop
filesystem, Node.js, and DOM access. Installing such a plugin is equivalent to running local code.
Threadleaf will distinguish this mode from its future capability-based native extension runtime.

The compatibility host has a versioned main-process resource policy. It bounds each renderer
operation, applies conservative memory and sustained CPU guardrails when Electron exposes valid
metrics, and terminates only the owning renderer after a breach. Missing metrics are visible as
unavailable and never treated as zero. These controls reduce hangs and runaway resource use; they
are not OS sandboxing, a permission boundary, or hard isolation from Node-capable plugin I/O.
