# Auto Link Title 1.5.5 compatibility disposition

**Last updated:** 2026-08-20

## Decision gate

Make the unchanged Auto Link Title 1.5.5 default paste workflow seamless without copying or
rewriting the plugin, broadening Threadleaf into a general Electron remote implementation, or
touching a real vault during workflow verification.

## Primary evidence

- Upstream source and release: <https://github.com/zolrath/obsidian-auto-link-title>, tag `1.5.5`,
  commit `542a47d0592a293d2eec8ba126d08bf1729dc18b`, MIT license.
- Official release assets: manifest SHA-256
  `21916c8c8fa1996d38fc79e6064b61f41c6b34d5d4eaddaf36f18432b3f49a11`, main SHA-256
  `eb27498bfd05dc5c3847dd072f555ed4c02aece24451042c2edb25fc961f38be`, styles SHA-256
  `040d99c787acf90dba4374c21b67417dde43acc59ed4ab9bcee510bfbc4508b2`.
- Acceptance-vault bundle: the same manifest and styles with distinct main SHA-256
  `b1da7a8b9b98b4c7daeae1286db2cd7fc5e24bef2903d3e326adcfc7db146f32`.
- Public plugin source shows that default URL paste starts `convertUrlToTitledLink` without returning
  its promise. The default scraper first probes with `fetch`, then uses the removed
  `electron.remote.BrowserWindow` path to load a page and read its title.

## Disposition by seam

| Seam | Authority and boundary | Disposition | Executable proof |
| --- | --- | --- | --- |
| Editor paste | Public Obsidian API type and unchanged MIT plugin | Adapt the existing revision-bound `editor-paste` bridge | `scripts/check-url-selection-paste.mjs` |
| Legacy hidden window | MIT plugin source defines the calls it uses; Electron remote itself is not reproduced | Extract the smallest behavior: HTTP(S) title load, load/fail events, title read, mute, destroy | `src/runtime/obsidian-electron-compat.test.ts` |
| Async completion | Plugin source proves the fetch promise is not returned | Adapt host resource tracking and wait for bounded legacy activity before editor reconciliation | Official and installed-package Electron gates |
| General Electron remote | No named accepted workflow requires broader authority | Reject | Explicit API and evidence limitations |
| Real website dependence | Network variance would make the gate non-reproducible | Benchmark against a deterministic loopback page | `pnpm test:auto-link-title` |

## Rights and claim boundary

Threadleaf uses the permissively licensed public plugin and independently authored fixtures. No
proprietary application source, assets, or extracted implementation text enters the repository.
The evidence proves one default URL-paste workflow for two exact bundle hashes on Linux Electron.
It does not prove universal Auto Link Title behavior or general Electron remote compatibility.
