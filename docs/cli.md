# Command-line interface

Threadleaf's CLI is a first-class interface to the same open vault kernel and metadata index as the
desktop app. It works on a headless machine, in a shell pipeline, from an editor, or in an automated
test. It does not depend on a running Electron window.

## Current commands

Every command requires an explicit vault path. The CLI never silently uses the desktop app's
remembered vault.

```sh
threadleaf --vault /path/to/vault vault info
threadleaf --vault /path/to/vault files [--directory Folder]
threadleaf --vault /path/to/vault read "Folder/Note.md"
threadleaf --vault /path/to/vault search "quoted phrase" [--limit 20]
threadleaf --vault /path/to/vault create "Folder/New note" [--content "# Title\n"]
threadleaf --vault /path/to/vault append "Folder/Note.md" --content "Added text" [--inline]
threadleaf --vault /path/to/vault prepend "Folder/Note.md" --content "Lead text" [--inline]
```

During development, prefix the same arguments with `pnpm cli`.

| Command | Output | Authority |
| --- | --- | --- |
| `vault info` or `vault:info` | Canonical path and note, heading, tag, and link counts | Read-only kernel plus derived index |
| `files` | Sorted Markdown paths, optionally filtered to a directory | Read-only kernel |
| `read` | Exact UTF-8 note content | Read-only kernel |
| `search` | Ranked paths and best context, with a bounded result count | Derived metadata and full-text index |
| `create` | Created Markdown path and revision | Recoverable no-clobber writer |
| `append` | Updated Markdown path and revision | Revision-checked recoverable writer |
| `prepend` | Updated Markdown path and revision | Revision-checked recoverable writer |

The note corpus excludes `.obsidian/`, `.git/`, and Threadleaf transaction artifacts. Read-only
kernel opening performs path validation but creates no state directory, vault identity, recovery
journal, or watcher.

`create` is the first mutating command. It accepts a vault-relative note name or path, adds `.md`
when omitted, creates missing folders, and accepts empty content. `--content` interprets `\n`, `\t`,
and `\\` so multiline scripts do not need a temporary file. The same application service backs the
desktop New action and CLI command.

Creation first checks for an ordinary existing note and returns conflict exit 5 without touching
it. The kernel then stages the proposed bytes and commits only if the target still does not exist.
If another process creates the path during that race window, Threadleaf preserves the proposal as
a labeled conflict note and reports its path. Recovery completes a staged new-file write at the
requested path after interruption when that name remains free. All CLI mutation journals live in
Threadleaf's operating-system state directory outside the vault. A process-owned lock serializes
CLI mutations, rejects a live concurrent invocation, and permits takeover from a dead process.

`append` and `prepend` require an existing Markdown note and non-empty content. Without `inline`,
Threadleaf adds one separator using the note's existing LF or CRLF convention. With `inline`, it
inserts the decoded content directly. Prepend places content after a complete YAML frontmatter block;
an unterminated opening marker is ordinary Markdown and stays with the body. Both commands read a
stable snapshot and write against that exact revision. If the note changes before commit, the
external version remains at the requested path, the full proposal is kept as a conflict note, and
the command returns exit 5.

## JSON contract

Add `--json` anywhere before `--` to receive a versioned success envelope on standard output:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "files",
  "data": {
    "directory": "",
    "total": 2,
    "files": ["Linked Note.md", "Welcome.md"]
  }
}
```

Failures leave standard output empty. With `--json`, standard error receives the same versioned
shape with `ok: false` and a stable error code. Without it, standard error receives concise prose.

| Exit | Code | Meaning |
| ---: | --- | --- |
| 0 | success | Command completed, including an empty search result |
| 1 | `INTERNAL` | Unexpected Threadleaf failure |
| 2 | `USAGE` | Invalid command, option, or argument |
| 3 | `VAULT` | Vault, path, UTF-8, or indexed-note failure |
| 4 | `QUERY` | Search query exceeds the documented bounds |
| 5 | `CONFLICT` | Create target exists, a create race was preserved, or another CLI mutation is active |

## Compatibility spellings

The public Obsidian CLI guide is behavioral input because its concise verbs already appear in user
scripts. Threadleaf currently accepts these aliases in addition to its native forms:

```sh
threadleaf --vault /path/to/vault read file="Folder/Note.md"
threadleaf --vault /path/to/vault search query="quoted phrase"
threadleaf --vault /path/to/vault create path="Folder/Note" content="# Title\n"
threadleaf --vault /path/to/vault create name="Root note"
threadleaf --vault /path/to/vault append path="Folder/Note.md" content="Next line"
threadleaf --vault /path/to/vault prepend file="Folder/Note.md" content="Lead" inline
```

This is argument compatibility, not yet a claim of byte-for-byte output compatibility. Each added
command or error behavior will require an executable fixture. Threadleaf's native contract keeps
explicit vault selection, structured JSON, headless execution, and script-safe diagnostics even
where a compatibility spelling follows another application's convention. `file=` currently means
an exact vault-relative path in Threadleaf; basename and wikilink-style resolution are not claimed.

## Next mutation boundary

`move` and `delete` still come later. Each must call the existing recoverable writer with revision
and conflict semantics. They will never use a direct CLI filesystem shortcut or create a second
mutation path. Threadleaf does not yet accept Obsidian's `open`, `overwrite`, or template parameters,
active-file defaults, or basename resolution, and does not claim complete output compatibility.

Reference behavior: [Obsidian CLI help](https://obsidian.md/help/cli).
