# Contributing

Threadleaf is in its architecture-proof phase. Contributions should strengthen the current phase
rather than expand the feature list.

Before contributing:

1. Read `docs/charter.md` and `docs/architecture.md`.
2. Tie compatibility work to an executable plugin fixture.
3. Keep user vaults out of tests and examples. Use synthetic data only.
4. Run `pnpm check`.
5. Describe observable behavior and limitations in the change.

Compatibility work may rely on public documentation, permissively licensed API definitions, open
formats, and open-source plugin code. Do not submit proprietary application code, copied assets, or
decompiled resources.
