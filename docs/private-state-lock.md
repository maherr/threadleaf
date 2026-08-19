# Private state lock

Threadleaf provides one small cooperative lock primitive for private application
state writers. It is a process boundary, not a user-vault format or a security
boundary. The public TypeScript surface is exported as `threadleaf/private-state-lock`.

## Contract

`acquireStateLock(path)` opens one persistent regular file with private-state
permissions and keeps that descriptor or handle alive until `close()`. On Linux
and macOS it takes `flock(LOCK_EX | LOCK_NB)`. On Windows it takes an exclusive,
fail-immediately `LockFileEx` lock over byte range `[0, 1)`. The kernel owns the
authority, so a process crash releases the lock while the regular file remains
at the same pathname.

The lock file is not an owner record. The primitive never renames, unlinks,
recreates, quarantines, or cleans up the file. It does not read or write PID,
token, mtime, lease, heartbeat, or stale-takeover state. A second process gets a
typed `StateLockBusyError` with `code === "busy"`; callers may use
`acquireStateLockAsync` for bounded timer-based polling. The async helper never
blocks the event loop and never uses `Atomics.wait` or a spin loop.

Before a sensitive mutation, the caller must call `lock.assertPathIdentity()`
after the transaction's final path checks and immediately before the mutation.
The native boundary compares the current pathname's filesystem identity with the
identity captured from the opened handle. A replacement, deletion, symlink, or
non-regular path aborts with `StateLockError` code `"compromised"`. This check
narrows the replacement window; it is not a capability against a same-UID
attacker who can race the check and mutation.

`withStateLock(path, operation)` acquires, performs one identity check, passes
the still-held lock to the operation, and closes it in `finally`. A release
failure is typed as `"release-error"` when the operation itself completed. A
failed operation remains the primary error while cleanup still runs.

## Migration and filesystem limits

An existing directory at the lock pathname is an explicit migration barrier.
Acquisition fails with `StateLockMigrationRequiredError`, `code ===
"migration-required"`, and `state === "quiescent"`. The directory is never
deleted. An application must quiesce every old directory-lock writer, migrate
its state deliberately, and only then choose a regular-file pathname.

Private state must be on a local filesystem whose kernel lock semantics are
known. POSIX `flock` behavior on NFS varies by server, mount, and protocol
version; SMB locking and byte-range interoperability also depend on server and
client configuration. Threadleaf does not claim this primitive coordinates
writers across those filesystems. A pathname replacement completed before the
next identity check is detected, but the check and a later filesystem mutation
are not an atomic security boundary. The lock is cooperative and protects
cooperating Threadleaf writers on the local host.

The path walk is fail-closed: POSIX builds require `O_NOFOLLOW` and validate
every ancestor with `openat`, while Windows builds inspect every ancestor with
`FILE_FLAG_OPEN_REPARSE_POINT`. A missing primitive or a symlink/reparse
ancestor observed during that walk is an error, never a fallback. This protects
cooperating writers from accidental path substitution; it is not a sandbox
against a racing same-UID process, privileged administrator, compromised
kernel, or untrusted network filesystem.

## Native boundary and packaging

The implementation is a project-owned C Node-API addon in
`native/state_lock.c`. It does not use V8 APIs, NAN, `fs-ext`, or
`proper-lockfile`. `native/include/` contains declaration-level ABI shims and
pins Node-API version 10. No Node implementation is copied into Threadleaf and
no third-party native dependency is introduced.

The Windows branch uses pinned `node-gyp` as a build tool so it links against
the pinned Electron runtime's verified header distribution and includes
Electron's required Windows delay-load hook. The shipped addon remains the
project-owned C source above; `node-gyp` is not a runtime dependency.

`pnpm run build:native:electron` explicitly rebuilds and loads
`dist/native/threadleaf-state-lock.node` in the pinned Electron runtime on the
matching host. Supported target builds are Linux x64, Windows x64, macOS
arm64, macOS x64, and a macOS universal addon made by `lipo`. A target build
fails closed on a host or architecture mismatch, so Linux cannot claim to
cross-build a Windows addon. `npmRebuild:false` remains set because this
explicit target build is the only native build authority.

Electron Builder unpacks `dist/native/**/*.node` under
`resources/app.asar.unpacked`. Each native package verifier inventories that
exact artifact, checks its OS and architecture, loads/acquires/asserts/releases
it in an independent process, and runs the packaged Electron executable with
`--native-lock-probe`. macOS and Windows signed lanes additionally verify the
native artifact inside the signed application. Local proof covers Linux x64
and macOS ARM64. Windows runtime proof and every signed-package proof remain
pending until their hosted runners execute.

The same project-owned addon exposes strict attachment-publication primitives
on Linux and macOS. Linux publishes an unnamed `O_TMPFILE` inode with `linkat`
under the held destination descriptor. macOS exclusively creates and fsyncs a
random hidden stage through that held descriptor, then calls
`renameatx_np(RENAME_EXCL)` in the same directory. A missing target receives
the complete bytes atomically, while an existing target returns `exists` and
leaves the claimant unchanged. macOS can retain the hidden stage as explicit
recovery evidence after a late failure or target race; successful publication
leaves no stage residue. Windows returns `unsupported` until equivalent native
descriptor and sharing primitives have executable package proof. These
operations do not broaden the cooperative state-lock threat model or authorize
pathname cleanup.

The GUI profile has a separate hardening layer: the Electron main process calls
`app.requestSingleInstanceLock()` before readiness and before constructing
settings or package managers, then serializes same-process private settings and
package mutations through one async queue. That admission lock is not the
interprocess state-lock authority. It does not cover CLI writers, alternate
`userData` or profile paths, or stale/crashed helpers. Source-retaining
user-vault publication remains a separate transaction and is not folded into
the GUI queue.

## Focused proof

`pnpm run test:native-lock` builds the addon and runs deterministic barriers in
separate child processes. One holder makes two independent probes and an async
probe report `busy`; killing the holder permits acquisition after the kernel
closes its descriptor; release and operation-error cleanup permit reacquisition;
the lock path remains present; replacing the pathname produces `compromised`; and
an old directory remains unchanged in `migration-required/quiescent` state.

`pnpm run test:native-lock-package` checks the native output, package export,
Electron ASAR-unpack rule, signed-artifact verifier inventory, packaged override
negative control, and the independent-process `CLI-LOCK-01` matrix. It copies
the addon into a simulated `resources/app.asar.unpacked` tree and loads it from
an unrelated working directory. `pnpm run test:native-lock-source` performs the
Node-API-only, pinned ABI, path-safety, permission, host-target, Electron-target,
release-lane, and Linux/macOS no-clobber-rename checks. The extracted-package and
Electron probes require a collision to preserve both source and target. They
never claim a runtime result for an operating system other than their host.
