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
```

During development, prefix the same arguments with `pnpm cli`.

| Command | Output | Authority |
| --- | --- | --- |
| `vault info` or `vault:info` | Canonical path and note, heading, tag, and link counts | Read-only kernel plus derived index |
| `files` | Sorted Markdown paths, optionally filtered to a directory | Read-only kernel |
| `read` | Exact UTF-8 note content | Read-only kernel |
| `search` | Ranked paths and best context, with a bounded result count | Derived metadata and full-text index |

The note corpus excludes `.obsidian/`, `.git/`, and Threadleaf transaction artifacts. Read-only
kernel opening performs path validation but creates no state directory, vault identity, recovery
journal, or watcher.

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

## Compatibility spellings

The public Obsidian CLI guide is behavioral input because its concise verbs already appear in user
scripts. Threadleaf currently accepts these aliases in addition to its native forms:

```sh
threadleaf --vault /path/to/vault read file="Folder/Note.md"
threadleaf --vault /path/to/vault search query="quoted phrase"
```

This is argument compatibility, not yet a claim of byte-for-byte output compatibility. Each added
command or error behavior will require an executable fixture. Threadleaf's native contract keeps
explicit vault selection, structured JSON, headless execution, and script-safe diagnostics even
where a compatibility spelling follows another application's convention.

## Next boundary

Mutation commands come later. `create`, `append`, `prepend`, `move`, and `delete` must call the
existing recoverable writer with revision and conflict semantics. They will never use a direct CLI
filesystem shortcut or create a second mutation path.

Reference behavior: [Obsidian CLI help](https://obsidian.md/help/cli).
