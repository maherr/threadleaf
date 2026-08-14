# Trademark and naming

Threadleaf has not registered a trademark for its name or any wordmark. This document states
current naming policy and community expectations, not asserted trademark rights. If that changes (a
registration, a transfer, a new maintainer with a different policy), this document is updated to
match, not the other way around. "Threadleaf" below means the project name, as distinct from any
specific maintainer, company, or legal entity.

## Posture on the Obsidian trademark

Threadleaf is an independently implemented, fully open runtime that opens existing Obsidian-format
Markdown vaults and can run existing Obsidian community plugins through an independently written
compatibility layer. It does this using public API definitions, open file formats, independently
written behavior tests, and open-source plugin code; it does not copy proprietary Obsidian
application code, assets, or bundled resources (`AGENTS.md` invariants; see the
[compatibility contract](../compatibility/contract.md) for how that boundary is enforced and
measured).

Every reference to "Obsidian" in Threadleaf's own documentation, product surfaces, and marketing is
strictly nominative: it identifies the vault format, plugin ecosystem, or product category Threadleaf
interoperates with. It is never a claim of affiliation, sponsorship, partnership, certification, or
endorsement, and never a claim about who makes Threadleaf. The README already states this plainly:
"Threadleaf is not affiliated with or endorsed by Obsidian" ([`README.md`](../../README.md)). This
document exists to keep that posture consistent everywhere else the name appears.

Concretely:

- Say "compatible with Obsidian," "opens Obsidian vaults," or "runs Obsidian community plugins," not
  "an Obsidian app," "Obsidian for Linux," or any phrasing that could be read as Threadleaf being an
  Obsidian product or an official variant of one.
- Do not use Obsidian's logo, icon, color marks, or other visual branding in Threadleaf's own UI,
  website, store listings, packaging, or marketing.
- Do not register a domain, package name, or store listing that could suggest Threadleaf is an
  official Obsidian release, an Obsidian-endorsed distribution, or is operated by Obsidian's
  developers.
- The `.obsidian/` configuration directory that Threadleaf reads, and in reviewed cases migrates
  from, is an existing on-disk data convention Threadleaf must interoperate with to avoid requiring
  vault conversion (`AGENTS.md`: "Never silently rewrite `.obsidian/` or application-owned
  configuration"). Reading that directory, or naming it in documentation, is interoperability, not a
  trademark claim, and Threadleaf's own state is deliberately kept out of it; see the
  [migration contract](../compatibility/migration.md).

## Threadleaf's own name and forks

Threadleaf's source code is licensed `AGPL-3.0-or-later` ([`LICENSE`](../../LICENSE)). That license
governs copying, modification, and redistribution of the code. It does not grant or restrict use of
the project name "Threadleaf" itself: trademark and copyright are different kinds of claim, and
today there is no registered trademark to enforce either way.

Given that, this is a naming courtesy, not a legal demand, and it applies most to redistribution
other people will run or install, not to casual conversation, blog posts, or personal experiments:

- You may fork, modify, self-host, and study Threadleaf's code under the terms of the AGPL,
  including keeping the name "Threadleaf" for your own private or internal use.
- If you redistribute a modified build to other people, especially one with different behavior,
  different safety guarantees, or a different security posture than upstream, please rename it or
  clearly qualify it, for example "Foocorp Notes, based on Threadleaf," rather than distributing it
  as unqualified "Threadleaf." People trust the name to mean the vault-safety and compatibility
  invariants in [`docs/charter.md`](../charter.md) and [`AGENTS.md`](../../AGENTS.md); a fork that
  changes those invariants should not carry the same unqualified name.
- Please do not present a fork as the official Threadleaf project, claim the original maintainers
  endorse it, or use the Threadleaf name to solicit funding, donations, or support on the original
  project's behalf.
- Factual reference is always fine: "based on Threadleaf," "a Threadleaf fork," "compatible with
  Threadleaf's vault format," and similar descriptive statements do not need permission.

This is deliberately compatible with, not opposed to, the continuity story in
[Release authority and succession](release-authority-and-succession.md): if the original maintainers
disappear, a continuation fork is the intended outcome, not a violation of this policy. The naming
courtesy above asks a continuation fork to be honest about what changed, not to avoid forking.
