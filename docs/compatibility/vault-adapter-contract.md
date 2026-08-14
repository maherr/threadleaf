# Vault adapter compatibility contract

## Status and scope

This document is the public contract for the `FileSystemAdapter` exposed as
`app.vault.adapter` by this Threadleaf compatibility runtime. It documents the
adapter surface implemented by the vault-adapter lane. It is a candidate
contract, not an assertion that the lane has been integrated into a release.

The Obsidian desktop API presents a broader `DataAdapter` surface. Threadleaf
commits only to the methods named in this document. A method absent from this
document is not supported by this contract, even if an Obsidian plugin happens
to use it successfully in some other runtime.

The signatures below use vault-relative string paths. Threadleaf normalizes
backslashes to slashes, applies POSIX path normalization and Unicode NFC, and
removes a leading `./` or leading slashes before resolving the path. A promise
that resolves to `void` resolves only after the delegated vault operation has
completed; a rejection reports a failed operation and is never a silent no-op.

| Method | Signature | Return shape | Threadleaf commitment |
| --- | --- | --- | --- |
| Text read | `read(path)` | `Promise<string>` | Read contained UTF-8 text. |
| Binary read | `readBinary(path)` | `Promise<ArrayBuffer>` | Read contained bytes. |
| Text write | `write(path, data, options?)` | `Promise<void>` | Create or revision-aware modify, with no timestamp override. |
| Folder create | `mkdir(path)` | `Promise<void>` | Create through the vault mutation port. |
| File copy | `copy(source, target)` | `Promise<void>` | Copy binary bytes to a new, nonexisting file. |
| Absolute path | `getFullPath(path)` | `string` | Return a contained absolute lexical path. |
| Presence | `exists(path, sensitive?)` | `Promise<boolean>` | Test a contained existing path, with optional exact-case check. |
| Metadata | `stat(path)` | `Promise<AdapterStat \| null>` | Return file or folder metadata, or `null`. |
| Directory list | `list(path)` | `Promise<ListedFiles>` | Return sorted child file and folder paths. |

## Shared containment rule

Obsidian's adapter API uses paths relative to the active vault. Threadleaf adds
a stronger safety guarantee to every documented path-taking method: no resolved
path may escape the active vault. Lexical traversal such as `../outside.md` is
rejected before an operation runs. Existing symlinks are resolved canonically;
a symlink to a location outside the vault is rejected. For a path that does not
yet exist, `getFullPath` and the mutation methods verify its nearest existing
ancestor before returning or mutating the target. A dangling symlink in that
ancestry cannot be used as an escape route and causes those calls to error.

This is a containment guarantee, not an authorization model. The adapter runs
inside Threadleaf's trusted compatibility runtime and exposes only the active
vault through this surface.

## Read methods

| Method | Obsidian-facing signature and return | Threadleaf guarantee | Deliberate boundary |
| --- | --- | --- | --- |
| `read` | `read(normalizedPath: string): Promise<string>` | Resolves to the existing contained file's UTF-8 text. Hidden vault paths are readable. | A missing, unreadable, non-file-system, or out-of-vault target rejects; Threadleaf does not convert those failures to an empty string. |
| `readBinary` | `readBinary(normalizedPath: string): Promise<ArrayBuffer>` | Resolves to an `ArrayBuffer` containing exactly the existing contained file's bytes. | It is a byte read, not text decoding and not a stream API. |

Obsidian plugins expect these methods to read a vault-relative path
asynchronously. Threadleaf first canonicalizes the existing target and applies
the shared containment rule. `read` reads it as UTF-8. `readBinary` returns the
exact byte range as a fresh `ArrayBuffer`, without interpreting the content.

An internal symlink may be read when its canonical target remains inside the
vault. A symlink to an external target is rejected. This is a Threadleaf
safety guarantee in addition to the familiar adapter signatures.

## Presence and inspection methods

| Method | Obsidian-facing signature and return | Threadleaf guarantee | Deliberate boundary |
| --- | --- | --- | --- |
| `exists` | `exists(normalizedPath: string, sensitive?: boolean): Promise<boolean>` | Resolves `false` for a missing path and `true` for an existing contained path when `sensitive` is omitted or `false`. | An out-of-vault resolution rejects rather than being reported as absent. |
| `stat` | `stat(normalizedPath: string): Promise<AdapterStat \| null>` | Resolves metadata for an existing contained file or folder, or `null` for a missing path or a non-file, non-folder entry. | `ctime`, `mtime`, and `size` are host file-system observations in milliseconds and bytes. They are not a portable metadata store. |
| `list` | `list(normalizedPath: string): Promise<ListedFiles>` | Resolves `{ files: string[]; folders: string[] }` of immediate contained children, each relative to the vault and sorted independently. | It is nonrecursive. A missing or non-directory path rejects rather than resolving to empty arrays. |

### `exists`

The optional `sensitive` argument defaults to `false`, matching the usual
adapter call shape. With the default, successful canonical resolution is
enough to return `true`. With `sensitive: true`, Threadleaf also walks the path
from the vault root and requires every requested segment to match a directory
entry exactly. This permits plugins that need an exact-case existence check to
rely on it even on a case-insensitive host file system.

`exists` returns `false` for `ENOENT` from canonical resolution, including a
missing target or a dangling symlink. Containment failures and other
file-system errors remain errors so a plugin cannot mistake an unsafe path for
an absent file.

### `stat` and `list`

`stat` returns `{ type, ctime, mtime, size }`, where `type` is either `file` or
`folder`. Threadleaf derives `ctime` from the host birth time when it exists,
otherwise from the host change time, and derives `mtime` and `size` from the
host stat result. A symlink is inspected through its contained canonical
target; an external target is rejected by containment before metadata is
returned.

`list` returns immediate child paths only. Regular files go in `files` and
directories go in `folders`; both lists are sorted with `localeCompare`. A
symlinked child is classified from its contained target. Other entry kinds are
omitted rather than being represented as a file or folder. Hidden entries are
not filtered out.

## Text write and folder creation

| Method | Obsidian-facing signature and return | Threadleaf guarantee | Deliberate divergence |
| --- | --- | --- | --- |
| `write` | `write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void>` | Writes text through the compatibility vault's create or revision-aware modify path. | `DataWriteOptions.ctime` and `.mtime` are rejected when supplied. They are not ignored and are never honored. |
| `mkdir` | `mkdir(normalizedPath: string): Promise<void>` | Creates a contained folder through the compatibility vault's folder-creation port. | Threadleaf does not add recursive or idempotent behavior beyond that vault port's outcome. |

### `write`

`write` is a text method. It first rejects a supplied `ctime` or `mtime`. For
accepted options, it normalizes and validates the path, then examines the
target in the compatibility vault:

1. An existing file is passed to `Vault.modify`, which uses the vault's
   revision-aware text writer. If the writer detects a revision conflict, the
   operation rejects and the vault writer preserves the proposed bytes at its
   conflict path.
2. A missing file is passed to `Vault.create`, which uses the vault's
   no-clobber text creation path. A concurrent or preexisting target is an
   error, not an overwrite.
3. An existing folder is rejected because `write` requires a file path.

The adapter does not create parent directories itself. It does not write
directly around the vault mutation path, so normal vault mutation tracking and
events remain the authority for a successful write. If the compatibility
runtime is read-only or lacks the required writer port, the call rejects with a
capability error instead of reporting success.

`DataWriteOptions` has the familiar optional `ctime?: number` and
`mtime?: number` fields. This adapter deliberately rejects either field when
it is not `undefined`, before it selects or invokes a writer. Threadleaf makes
no promise to preserve, backdate, or set timestamps through `write`; plugins
that require timestamp control must treat it as unsupported.

### `mkdir`

`mkdir` validates the path under the shared containment rule and delegates to
`Vault.createFolder`. It resolves `void` after that vault operation completes.
The adapter makes one folder-creation call and adds no recursive parent
creation, overwrite, or collision policy of its own. As with `write`, a
read-only compatibility runtime or unavailable folder-creation port produces
an explicit rejection rather than a no-op.

## Binary copy and absolute paths

| Method | Obsidian-facing signature and return | Threadleaf guarantee | Deliberate boundary |
| --- | --- | --- | --- |
| `copy` | `copy(source: string, target: string): Promise<void>` | Copies the source file's exact bytes through the vault's no-clobber binary creation path. | Only file-to-new-file copy is supported. Folder, missing, special, and already-existing targets are rejected. |
| `getFullPath` | `getFullPath(normalizedPath: string): string` | Returns an absolute lexical path under the active vault only after containment validation. | It is not a promise of canonicalization, existence, readability, or permission to access a path outside the adapter. |

### `copy`

`copy` normalizes and validates both source and target before inspecting either
one. The source must `stat` as an existing file. A folder source is rejected,
as are a missing source and any source that resolves outside the vault. The
target must not already exist. This is a no-clobber operation: if the target
exists during the preflight or the vault's binary creation detects a collision,
the call rejects and does not overwrite the target.

For a successful copy, Threadleaf reads the source through `readBinary` and
passes those exact bytes to `Vault.createBinary`. The returned promise resolves
to `void` after binary creation completes. The adapter does not copy
directories, create parent folders, or copy timestamps and other file-system
metadata. A read-only runtime or absent binary-creation port fails explicitly.

### `getFullPath`

Obsidian plugins use `getFullPath` when they need the adapter's absolute local
path form. Threadleaf returns an absolute lexical path rooted at the active
vault. The path may name an existing entry or a not-yet-created child.

Before returning, Threadleaf checks the resolved path itself when it exists.
For a prospective child, it walks upward to the nearest existing ancestor and
checks that ancestor's canonical path is inside the vault. Lexical escapes,
external symlink ancestors, and dangling-symlink paths are errors. The method
does not read or write the returned path, and it does not turn this containment
check into a grant to escape the adapter boundary.

## Deliberately unsupported deletion

Obsidian's broader `DataAdapter` API includes deletion operations. Threadleaf's
vault adapter deliberately exposes neither `remove` nor `rmdir`:

| Obsidian API shape | Threadleaf behavior | Safe plugin assumption |
| --- | --- | --- |
| `remove(normalizedPath: string): Promise<void>` | No `remove` method exists on this adapter. A direct call therefore receives the ordinary JavaScript missing-method error, rather than a resolved no-op. | Do not use this adapter to delete a file. Feature-detect first if a plugin supports more than one host. |
| `rmdir(normalizedPath: string, recursive?: boolean): Promise<void>` | No `rmdir` method exists on this adapter. A direct call receives an honest missing-method error, rather than a resolved no-op. | Do not use this adapter to delete a folder, recursive or otherwise. |

Deletion is not exposed through this adapter. There is no implicit trash,
permanent delete, empty-folder removal, or recursive removal fallback. A plugin
must handle the absent methods as unsupported, not as evidence that a delete
succeeded.

## Compatibility evidence and review rule

The executable evidence for this contract is
`src/runtime/obsidian-file-system-adapter-wedge.test.ts`. It proves the
revision-aware existing-file and no-clobber new-file write paths, timestamp
option rejection before writer invocation, contained folder creation,
byte-exact no-clobber copy, and lexical, external-symlink, and dangling-symlink
path rejection.

For an integration review, a plugin may rely on the documented signatures,
return shapes, containment behavior, and explicit failure modes above. It must
not infer support for omitted `DataAdapter` methods, timestamp mutation,
deletion, recursive folder copy, or an escape from the active vault.
