# Command-line interface

Threadleaf's CLI is a first-class interface to the same open vault kernel and metadata index as the
desktop app. It works on a headless machine, in a shell pipeline, from an editor, or in an automated
test. It does not depend on a running Electron window.

## Current commands

Every command requires an explicit vault path. The CLI never silently uses the desktop app's
remembered vault.

```sh
threadleaf --vault /path/to/vault vault info
threadleaf --vault /path/to/vault file file="Note"
threadleaf --vault /path/to/vault files [folder=Folder] [ext=png] [total]
threadleaf --vault /path/to/vault folder path=Folder [info=files|folders|size]
threadleaf --vault /path/to/vault folders [folder=Folder] [total]
threadleaf --vault /path/to/vault wordcount file="Note" [words|characters]
threadleaf --vault /path/to/vault read "Folder/Note.md"
threadleaf --vault /path/to/vault search "quoted phrase" [--limit 20]
threadleaf --vault /path/to/vault links "Folder/Note.md"
threadleaf --vault /path/to/vault backlinks "Folder/Note.md"
threadleaf --vault /path/to/vault unresolved
threadleaf --vault /path/to/vault orphans
threadleaf --vault /path/to/vault deadends
threadleaf --vault /path/to/vault outline "Folder/Note.md"
threadleaf --vault /path/to/vault create "Folder/New note" [--content "# Title\n"]
threadleaf --vault /path/to/vault append "Folder/Note.md" --content "Added text" [--inline]
threadleaf --vault /path/to/vault prepend "Folder/Note.md" --content "Lead text" [--inline]
threadleaf --vault /path/to/vault move "Folder/Note.md" --to "Archive/Note.md" [--update-links]
threadleaf --vault /path/to/vault rename "Folder/Note.md" --name "New name" [--update-links]
threadleaf --vault /path/to/vault delete "Folder/Note.md"
threadleaf --vault /path/to/vault trash list
threadleaf --vault /path/to/vault restore "Folder/Note.md"
threadleaf --vault /path/to/vault properties path="Folder/Note.md"
threadleaf --vault /path/to/vault property:read path="Folder/Note.md" name=status
threadleaf --vault /path/to/vault property:set path="Folder/Note.md" name=status value=review
threadleaf --vault /path/to/vault property:remove path="Folder/Note.md" name=status
threadleaf --vault /path/to/vault tasks [path="Folder/Note.md"] [done|todo|status="?"] [total|verbose]
threadleaf --vault /path/to/vault task ref="Folder/Note.md:12" [toggle|done|todo|status="?"]
threadleaf --vault /path/to/vault aliases [path="Folder/Note.md"] [total|verbose]
threadleaf --vault /path/to/vault tags [path="Folder/Note.md"] [sort=count] [total|counts]
threadleaf --vault /path/to/vault tag name=project [total|verbose]
```

During development, prefix the same arguments with `pnpm cli`.

| Command | Output | Authority |
| --- | --- | --- |
| `vault info` or `vault:info` | Canonical path and note, heading, tag, and link counts | Read-only kernel plus derived index |
| `file` | Path, name, extension, byte size, and filesystem timestamps | Safe visible-file inventory |
| `files` | Sorted visible file paths with folder, extension, and count filters | Safe visible-file inventory |
| `folder` | Recursive file count, folder count, and byte size | Safe visible-file inventory |
| `folders` | Sorted visible folder paths with parent and count filters | Safe visible-file inventory |
| `wordcount` | Unicode word and grapheme-character counts for one Markdown note | Read-only kernel |
| `read` | UTF-8 note content | Read-only kernel |
| `search` | Ranked paths and best context, with a bounded result count | Derived metadata and full-text index |
| `links` | Ordered outgoing internal-link occurrences and resolution states | Derived metadata index |
| `backlinks` | Resolved source notes and occurrence counts for one note | Derived metadata index |
| `unresolved` | Every unresolved or ambiguous link occurrence with its source | Derived metadata index |
| `orphans` | Notes with no resolved incoming source | Derived metadata index |
| `deadends` | Notes with no parsed outgoing internal-link occurrence | Derived metadata index |
| `outline` | Ordered headings with levels and source lines | Derived metadata index |
| `create` | Created Markdown path and revision | Recoverable no-clobber writer |
| `append` | Updated Markdown path and revision | Revision-checked recoverable writer |
| `prepend` | Updated Markdown path and revision | Revision-checked recoverable writer |
| `move` | Preview or committed source, destination, rewrites, and written revisions | Whole-vault proof plus compound recovery journal |
| `rename` | Preview or committed same-folder destination, rewrites, and written revisions | Whole-vault proof plus compound recovery journal |
| `delete` | Source and recoverable trash paths | Revision-checked recoverable rename |
| `trash list` or `trash:list` | Original path, trash path, revision, and byte size | Dedicated read-only trash inspection |
| `restore` | Trash and restored paths | Revision-checked recoverable rename |
| `properties` | Sorted indexed property names and values for one note | Derived metadata index |
| `property:read` | One indexed property value or an explicit absent result | Derived metadata index |
| `property:set` | Typed property value, note revision, and transaction | Revision-checked recoverable writer |
| `property:remove` | Committed removal or explicit no-write missing result | Revision-checked recoverable writer |
| `tasks` | Vault-wide or targeted-note Markdown tasks with status filters and optional count/location output | Read-only kernel plus Markdown task scanner |
| `task` | One targeted task line, optionally with a new checkbox status | Read-only scanner or revision-checked recoverable writer |
| `aliases` | Frontmatter aliases across the vault or one targeted note, optionally with source paths | Derived metadata index |
| `tags` | Unique tag catalog with occurrence counts across the vault or one targeted note | Derived metadata index |
| `tag` | Occurrence total and carrying files for one tag | Derived metadata index |

The visible file inventory includes ordinary attachments, Canvas documents, and other user files.
The Markdown note corpus remains the narrower input to read, search, graph, task, property, and
workspace behavior. Both exclude `.obsidian/`, `.git/`, `.trash/`, and Threadleaf transaction
artifacts. Read-only kernel opening performs path validation but creates no state directory, vault
identity, recovery journal, or watcher. `trash list` deliberately inspects `.trash/` through a
dedicated path without admitting its contents to either ordinary corpus.

## Note targets

Native positional note arguments and `path=` are exact vault-relative paths. `file=` is the
familiar name-based form: it compares Markdown basenames case-insensitively after NFC Unicode
normalization, and accepts the name with or without `.md`. A unique match returns its canonical
vault path. No match returns `VAULT` exit 3, and multiple matches return the same exit with every
candidate path listed. Threadleaf never guesses among duplicate basenames.

This rule is shared by read, graph, outline, text mutation, move, rename, delete, property, task,
alias, and tag commands. `task ref=<path:line>` remains exact because the path and source line form
one stable address. `restore` is also exact because it addresses the one-to-one path mapping under
`.trash/`, not the live Markdown corpus.

The `file` information command applies name lookup to every visible vault file. Supplying an
extension matches that full basename. Omitting it compares stems, so `file=Diagram` can resolve
`Diagram.canvas`; two visible files with the same stem fail as ambiguous rather than selecting one.

## File and folder inventory

`files` lists files recursively from the vault root or `folder=<path>`. `ext=<extension>` accepts a
leading dot and compares case-insensitively. `total` changes only human output to the resulting
count; versioned JSON retains the paths and count. The older native `--directory <path>` spelling
remains an alias for `folder=`.

`folders` lists descendant folders recursively, including empty folders, and `folder=<path>` limits
the traversal to one visible parent. `folder path=<path>` reports recursive file count, descendant
folder count, and total visible bytes. `info=files`, `info=folders`, or `info=size` returns one number
in human mode while JSON retains all fields. Missing and private folder targets fail explicitly for
`folder`; a missing list filter produces an empty `files` or `folders` result.

Visible inventory follows only file symlinks whose canonical target remains inside the vault and
outside private application trees. Broken links and links outside the boundary are omitted.
Recursive discovery does not traverse folder symlink entries, preventing cycles and duplicate
trees.

`wordcount` counts the complete saved Markdown source after excluding a leading UTF-8 BOM. Words
use Unicode word boundaries. Characters are Unicode grapheme clusters, so a composed accent or ZWJ
emoji sequence counts as one visible character. `words` or `characters` returns only that number in
human mode; JSON always includes the canonical note path and both counts.

The graph commands expose the index's distinctions instead of flattening them. `links` retains
source order and duplicate occurrences. `backlinks` groups resolved occurrences by source, while
reporting both the number of source notes and the number of link occurrences. `unresolved` includes
both links with no candidate and links with multiple candidates, with either state explicit in JSON
and human output. `orphans` means no resolved incoming source; a resolved self-link is incoming.
`deadends` is syntax-level in this release: a note containing any parsed internal link is not a
dead end even when that link is unresolved or ambiguous. `outline` returns heading level, text, and
one-based source line. These choices have executable fixtures and do not yet claim every Obsidian
edge semantic.

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

`move` and `rename` never overwrite a destination. Before mutation, Threadleaf snapshots the
Markdown corpus and compares every parsed link against a projected index containing the proposed
path. Resolved targets that need new text become exact source-offset rewrite proposals; aliases,
anchors, titles, whitespace, BOM, line endings, and unrelated bytes stay untouched. Ambiguous or
unresolved cases that cannot be proved safe remain blockers.

When safe rewrites are required, the first invocation exits 5 with a structured
`requires-confirmation` preview and changes nothing. Rerun with `--update-links` to accept the
current plan. Add `--json` to the preview invocation to inspect every entry under
`error.details.rewrites`. Threadleaf re-plans from current bytes, revision-checks every affected
note, and uses one parent journal to coordinate the rewrites and rename. A collision or external
edit triggers reverse-order rollback; any losing proposal or rollback version is preserved as an
explicit conflict copy. A move with no required rewrite commits without the flag.

For `move`, `to=` is an exact note path unless it ends in `/` or `\`, in which case Threadleaf keeps
the source filename inside that explicit destination folder. `rename` accepts one filename without
directory separators and keeps the note in its current folder. Both add `.md` when omitted.

`delete` is recoverable by construction. It stores a note at the same relative path under
vault-local `.trash/`, preserves exact bytes, and intentionally allows incoming links to become
unresolved. A prior trash entry with that path blocks another delete instead of being overwritten.
`restore` accepts either the original path or its `.trash/` path and moves the entry back only when
the original path is free. This exact one-to-one mapping avoids hidden manifests and makes recovery
understandable in any file browser. Both operations compare the source revision again at commit and
recover through the same rename journal after interruption. Threadleaf rejects `permanent` deletion;
manual removal from `.trash/` remains outside the current CLI contract.

`properties` and `property:read` expose the same current scalar-and-list projection used by desktop
search. Both are read-only and create no CLI state. Threadleaf has no active-file default, so each
property command requires an explicit exact `path=` or unique-name `file=` target.

`property:set` defaults to `type=text`. Supported explicit types are `text`, `list`, `number`,
`checkbox`, `date`, and `datetime`. Text is stored as a quoted one-line YAML string. A list value may
be a JSON array of strings or a comma-separated list; each member is quoted on its own YAML line.
Numbers must be literal integers or decimals, checkboxes must be `true` or `false`, dates use
`YYYY-MM-DD`, and datetimes use `YYYY-MM-DDTHH:mm:ss`. Property names currently accept ASCII letters,
numbers, underscores, and hyphens.

The mutation service changes only the selected top-level property block and preserves the BOM,
line endings, comments, unrelated property order and spelling, and complete note body. A note with
no frontmatter gets a new YAML envelope. Removing the last property removes the resulting empty
envelope; removing an absent property succeeds without writing. Duplicate keys, quoted or spaced
keys, JSON frontmatter, nested mappings, and block scalars are refused before any write because this
first patcher cannot yet preserve them losslessly. A revision race keeps the external winner at the
requested path, stores the complete proposed file as a conflict copy, and returns exit 5.

`tasks` scans every indexed Markdown note, one exact `path=` target, or one unique-name `file=`
target. With no filter it
returns all recognized tasks. `done` means status `x` or `X`; `todo` means every other status, so
custom statuses remain visible. `status=<char>` matches one exact Unicode character. Human output
is checkbox text by default, `verbose` prefixes `path:line`, and `total` prints only the matching
count. Versioned JSON always includes the full matching records and their count.

`task` reads or mutates one task addressed by exact `ref=<path:line>`, or by `path=` or `file=` plus
`line=`.
`toggle` changes `x` or `X` to a space and every other status to `x`; `done` sets `x`, `todo` sets a
space, and `status=<char>` sets one custom character. The scanner recognizes unordered and ordered
list checkboxes, including nested and quoted tasks, while excluding fenced code, inline code, and
HTML comments. Mutation changes only the status range and preserves the BOM, LF or CRLF endings,
task text, indentation, and all unrelated bytes. Setting the current status succeeds without a
write. A revision race keeps the external winner, stores the complete proposed note as a conflict
copy, and returns exit 5.

`aliases` reads `alias` and `aliases` frontmatter values across the vault, one exact `path=` target,
or one unique-name `file=` target. `total` prints the number of alias entries. Human output lists
aliases alone by default and adds the exact source path with `verbose`. Versioned JSON always
includes both fields.

`tags` reports distinct tag names from frontmatter and inline Markdown. `total` prints the distinct
tag count, `counts` adds each tag's occurrence total to human output, and `sort=count` orders by
descending occurrence count with a name tie-breaker. Repeating one tag in a note increases its
occurrence count; the file list still contains that note once. `tag name=<tag>` accepts a name with
or without a leading `#`; `total` prints its occurrence count and `verbose` includes every carrying
file. Fenced code, inline code, and HTML comments are excluded, and a frontmatter tag is not
counted again as inline syntax.

## JSON contract

Add `--json` anywhere before `--` to receive a versioned success envelope on standard output:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "files",
  "data": {
    "folder": "",
    "extension": null,
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
| 5 | `CONFLICT` | A target exists, a write or task race was preserved, link updates need confirmation, link integrity blocks a move, trash recovery collides, or another CLI mutation is active |

## Compatibility spellings

The public Obsidian CLI guide is behavioral input because its concise verbs already appear in user
scripts. Threadleaf currently accepts these aliases in addition to its native forms:

```sh
threadleaf --vault /path/to/vault file file="Diagram.canvas"
threadleaf --vault /path/to/vault files folder="Attachments" ext=png total
threadleaf --vault /path/to/vault folder path="Projects" info=size
threadleaf --vault /path/to/vault folders folder="Projects" total
threadleaf --vault /path/to/vault wordcount file="Note" words
threadleaf --vault /path/to/vault read file="Note"
threadleaf --vault /path/to/vault read path="Folder/Note.md"
threadleaf --vault /path/to/vault search query="quoted phrase"
threadleaf --vault /path/to/vault links path="Folder/Note.md"
threadleaf --vault /path/to/vault backlinks file="Note"
threadleaf --vault /path/to/vault outline path="Folder/Note.md"
threadleaf --vault /path/to/vault create path="Folder/Note" content="# Title\n"
threadleaf --vault /path/to/vault create name="Root note"
threadleaf --vault /path/to/vault append path="Folder/Note.md" content="Next line"
threadleaf --vault /path/to/vault prepend file="Note" content="Lead" inline
threadleaf --vault /path/to/vault move path="Folder/Note.md" to="Archive/Note.md"
threadleaf --vault /path/to/vault rename file="Note" name="New name"
threadleaf --vault /path/to/vault delete path="Folder/Note.md"
threadleaf --vault /path/to/vault restore path="Folder/Note.md"
threadleaf --vault /path/to/vault properties path="Folder/Note.md"
threadleaf --vault /path/to/vault property:read path="Folder/Note.md" name=status
threadleaf --vault /path/to/vault property:set path="Folder/Note.md" name=status value=review
threadleaf --vault /path/to/vault property:set path="Folder/Note.md" name=aliases 'value=["First","Second"]' type=list
threadleaf --vault /path/to/vault property:remove path="Folder/Note.md" name=status
threadleaf --vault /path/to/vault tasks file="Note" todo verbose
threadleaf --vault /path/to/vault task ref="Folder/Note.md:12" toggle
threadleaf --vault /path/to/vault task path="Folder/Note.md" line=12 status="?"
threadleaf --vault /path/to/vault aliases file="Note" verbose
threadleaf --vault /path/to/vault tags path="Folder/Note.md" counts
threadleaf --vault /path/to/vault tag name=project verbose
```

This is argument compatibility, not yet a claim of byte-for-byte output compatibility. Each added
command or error behavior will require an executable fixture. Threadleaf's native contract keeps
explicit vault selection, structured JSON, headless execution, and script-safe diagnostics even
where a compatibility spelling follows another application's convention. `file=` performs the
unique basename resolution described above, while `path=` remains exact. The target behavior is
covered by cross-command executable fixtures rather than claimed from argument parsing alone.

## Current compatibility boundary

Threadleaf accepts Obsidian's public `delete path=<path>` spelling but deliberately omits its
`permanent` flag. Move and rename support explicit compound link rewriting through Threadleaf's
native `--update-links` confirmation flag. Threadleaf accepts the public property command names and
parameter spellings, but its lossless frontmatter subset and native JSON contract are narrower than
a complete compatibility claim. Threadleaf does not yet accept Obsidian's `open`, `overwrite`, or
template parameters, active-file defaults, or graph-command `total`, `counts`, `verbose`, and
`format` flags. The task subset does not yet support `active`, `daily`, or alternate `format`
output. Alias and tag commands do not yet support `active` or alternate `format` output.
`trash list`, `trash:list`, and `restore` are native Threadleaf recovery commands rather than
claimed Obsidian CLI compatibility.

Reference behavior: [Obsidian CLI help](https://obsidian.md/help/cli).
