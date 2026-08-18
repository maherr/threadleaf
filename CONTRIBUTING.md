# Contributing

Threadleaf is a public pre-1.0 desktop application. Contributions should close a documented product,
compatibility, accessibility, performance, or reliability gap rather than add unmeasured breadth.

Before contributing:

1. Read `docs/charter.md` and `docs/architecture.md`.
2. Tie compatibility work to an executable plugin fixture.
3. Keep user vaults out of tests and examples. Use synthetic data only.
4. Run `pnpm check`.
5. Describe observable behavior and limitations in the change.
6. Include screenshots from the real Electron application for visible changes and update the
   committed visual baseline only after inspecting the changed pixels.

Compatibility work may rely on public documentation, permissively licensed API definitions, open
formats, and open-source plugin code. Do not submit proprietary application code, copied assets, or
decompiled resources.
