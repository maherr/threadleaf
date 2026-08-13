# Same-vault behavior corpus v1

This is a small, public, implementation-neutral vault for compatibility work. Every byte in
`vault/` is authored for Threadleaf's behavior tests; it is not copied from Obsidian, a private
vault, or a bundled application resource. `manifest.json` records the canonical vault byte
inventory and `cases.json` records executable behavior expectations.

The corpus intentionally contains ordinary Markdown, attachments, a JSON Canvas document, and
`.obsidian/` configuration side by side. A consumer must treat Markdown and attachments as
authoritative and `.obsidian/` as read-only compatibility input. The Threadleaf gate is:

```sh
pnpm run corpus:check
```

Another implementation may consume the fixture by copying this directory to a temporary vault,
verifying `manifest.json`, and running the supported cases in `cases.json`. Cases marked
`unsupported` are evidence that a behavior has not been measured, not passes. Contributions should
add a deterministic case and source bytes, update the manifest, explain the independent provenance,
and include a reproducible runner assertion before changing a case from `unsupported` to
`supported`.
