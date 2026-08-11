# Command-line direction

Threadleaf's CLI is a first-class interface to the same open vault runtime as the desktop app. It
will be useful on a headless machine, in a shell pipeline, from an editor, or in an automated test.
It will not depend on a running Electron window.

## Contract

- Markdown and attachments remain canonical.
- Read commands never create application state inside a vault.
- Mutations use the shared vault writer, revision checks, recovery journal, and keep-both conflict
  behavior.
- Human-readable output is concise; `--json` has a versioned, machine-readable shape.
- Success and failure have documented exit codes. Diagnostics go to standard error.
- Commands are non-interactive by default when standard input or output is not a terminal.
- A vault can be supplied explicitly. No command silently operates on an unrelated remembered
  vault.
- Plugin and developer commands declare when they require the desktop compatibility host.

## Initial command families

| Family | Examples | Initial authority |
| --- | --- | --- |
| Vault | `vault info`, `files`, `read` | Read-only kernel access |
| Discovery | `search`, `links`, `backlinks`, `headings`, `tags` | Rebuildable indexes |
| Mutation | `create`, `append`, `prepend`, `move`, `delete` | Recoverable writer |
| Daily notes | `daily path`, `daily read`, `daily append` | Configured path plus writer |
| Tasks | `tasks`, `tasks daily` | Parsed Markdown checkboxes |
| Automation | `command`, `--json`, `--stdin` | Shared action registry |
| Development | `plugin inspect`, `plugin test` | Explicit compatibility host |

The first implementation should make `vault info`, `files`, `read`, and `search` real before adding
mutations. This establishes parsing, output, vault selection, and exit-code contracts without
creating another write path. Mutation commands follow only by calling the existing recoverable
writer, never by using direct filesystem helpers.

## Compatibility facade

Obsidian's public CLI guide is useful behavioral input because its concise verbs already appear in
user scripts. Threadleaf can accept a measured subset such as `read`, `search query=...`, `files`,
`tags counts`, and `daily:append`, then translate those arguments into the native typed command
model. Compatibility is recorded per command and fixture, including output and error behavior.

The native interface remains the stable contract. It adds explicit vault selection, structured
JSON, headless execution, and script-safe diagnostics even where the compatibility spelling keeps
another application's conventions. No compatibility command may bypass the normal kernel or gain
implicit access to a running user's vault.

Reference behavior: [Obsidian CLI help](https://obsidian.md/help/cli).
