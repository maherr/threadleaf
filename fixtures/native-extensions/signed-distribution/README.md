# Signed native-extension distribution fixture

This fixture contains public bundle bytes and a manifest shape only. Tests generate ephemeral
Ed25519 keys and signatures in memory, so no publisher secret is stored in the repository. It is
not a published package or a marketplace listing.

`signed-manifest.example.json`, `catalog.example.json`, and `trust-anchors.example.json` are real
documents produced by the production signers with ephemeral keys that were discarded immediately
afterwards. They carry public key material and signatures only, which is exactly what a consumer
receives. Two gates read them, and both must keep passing:

- `node scripts/check-native-extension-distribution-schema.mjs` validates all three against
  `docs/compatibility/native-extension-distribution.v1.schema.json`.
- `src/native-extension/marketplace-trust.test.ts` verifies them through the production parsers.

Together they keep the published schema and the code from drifting apart. Regenerate all three
with the production signing helpers if the document shape ever changes; never hand-edit a
signature, because the record would then satisfy the schema while failing verification.
