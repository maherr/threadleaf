# Repository instructions

Read `docs/charter.md`, `docs/architecture.md`, and
`docs/compatibility/contract.md` before changing product behavior.

## Invariants

- Markdown files and attachments are user-owned source data.
- Opening a vault must not require content conversion.
- Never silently rewrite `.obsidian/` or application-owned configuration.
- User-vault mutations must be explicit, atomic, recoverable, and tested under interruption.
- Compatibility claims require an executable fixture or integration test.
- The compatibility runtime may use public API definitions, open formats, independently written
  behavior tests, and open-source plugins. Do not copy proprietary application code, assets, or
  bundled resources.
- Keep the kernel small. Optional product behavior belongs in first-party plugins when practical.
- Existing plugins run only in the clearly identified trusted compatibility runtime. Native
  Threadleaf extensions will use declared capabilities.
- Do not introduce network or account requirements into offline workflows.

## Checks

Run `pnpm check` before committing source changes. When UI behavior changes, also launch the
Electron application and verify the rendered state in both themes.
