# Level 4 evidence harness

This directory is the checked-in harness closure named by the trusted controller manifest. It contains fixture workflows and their deterministic drivers. A harness is an explicit verifier input, not a claim that any production plugin has passed it.

Level 4 receipts are a co-privileged reproducibility and integrity convention for drift, accident, partial runs, replay, and other non-malicious divergence. They are not a sandbox or an attestation against an already granted Node plugin.

The fixture proof is run with:

```text
pnpm test:level4-hermetic
```

It creates an ephemeral Ed25519 key and all mutable state below a private temporary directory. The production trust policy intentionally has no issuer key until a later attended production bootstrap.
