# Natural Language Dates 0.6.2 compatibility disposition

**Last updated:** 2026-08-20

## Decision gate

Make one unchanged, installed Natural Language Dates workflow usable through Threadleaf's visible
command palette while preserving plugin-owned views and keeping untested autosuggest and daily-note
behavior outside the claim.

## Primary evidence

- Upstream source and release: <https://github.com/argenos/nldates-obsidian>, tag `0.6.2`, commit
  `58849aa1bf73ab8cb4febc7c83807e27454c4d82`, MIT license.
- Official and acceptance-vault manifest SHA-256:
  `dfdcbdd8272d839ec0620af3a1fa7ab1f785ad3cdc6feed1f18ccb7b09621f29`.
- Official and acceptance-vault main SHA-256:
  `387d36a43412f761c0c69320655a7ec09aa9189ae2267550224cacc861e63fd6`.
- Public source shows eight commands, one editor suggest, one protocol handler, and callback commands
  that discover `MarkdownView` through the active workspace rather than an editor callback.
- Bundled daily-note support probes internal and cross-plugin state. Those paths are not needed by
  the accepted parse-command workflow and remain outside the claim.

## Disposition by seam

| Seam | Authority and boundary | Disposition | Executable proof |
| --- | --- | --- | --- |
| Exact package | Official GitHub release and installed bytes match | Depend on unchanged release | Reviewed authority profile and asset hashes |
| Callback command routing | Public plugin source and Obsidian API types | Adapt native editor context routing when no plugin view is active | `src/runtime/plugin-host.test.ts` |
| Visible parse command | Unchanged MIT plugin | Benchmark through Threadleaf's command palette | `pnpm test:natural-dates` |
| Editor suggest | Registration is measurable; native suggestion UI is a separate process seam | Defer | Explicit evidence limitation |
| Daily-note and protocol paths | Bundle probes private and cross-plugin state | Reject from this claim pending dedicated fixtures | Explicit evidence limitation |

## Rights and claim boundary

Threadleaf uses the permissively licensed public plugin and independently authored fixtures. No
proprietary application source, assets, or extracted implementation text enters the repository.
The evidence proves one command workflow for one exact bundle on Linux Electron, not universal
Natural Language Dates compatibility.
