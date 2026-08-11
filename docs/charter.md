# Project charter

## Mission

Build the fully open knowledge workspace that lets people leave a closed application without
leaving their vault, workflows, or plugin ecosystem.

## Core promise

Select an existing vault. It opens without content conversion. Important plugins work. Every note
remains portable, and returning to another Markdown application remains possible.

## Initial users

1. Existing Markdown-vault power users who want a fully open application.
2. Linux users, self-hosters, developers, and privacy-conscious users.
3. Plugin authors who want a stable open runtime.
4. Later, ordinary note-taking users who choose Threadleaf for product quality.

## What better means

Threadleaf does not need the largest feature count. It needs stronger guarantees:

- fully open and reproducibly buildable;
- no account or network requirement;
- same-vault operation without content migration;
- atomic writes, recovery, snapshots, and explicit conflict handling;
- a stable, documented, tested extension contract;
- honest per-plugin compatibility reporting;
- a rebuildable metadata index;
- open synchronization choices;
- optional automation presented as cited, reversible diffs;
- a coherent interface rather than unrelated plugin surfaces.

## Invariants

1. User files are authoritative.
2. Opening a vault never requires conversion.
3. Migrations are explicit, previewable, reversible, and optional.
4. Threadleaf state remains separate from `.obsidian/`.
5. No feature silently introduces a proprietary storage dependency.
6. Every write path is tested under interruption before it reaches user vaults.
7. Compatibility claims come from tests.
8. The kernel remains small.
9. Offline operation remains complete.
10. Existing plugins run in a labeled trusted mode.
11. Native extensions use declared capabilities and a versioned API.
12. AI remains optional and provider-independent.

## Initial non-goals

- Supporting every published plugin.
- Reproducing another application's pixels.
- Mobile clients.
- Multiplayer collaboration.
- A privileged proprietary sync service.
- Reimplementing every core feature before an alpha.
- Inventing a new note format.
- Requiring AI for ordinary knowledge work.

## North-star proof

A user selects an existing vault, reviews a read-only compatibility report, opens notes and
attachments, enables representative plugins, edits content safely, and then opens the same files in
another Markdown application unchanged. Interrupting Threadleaf during a write loses no data.
