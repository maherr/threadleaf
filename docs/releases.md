# Release engineering

Threadleaf 0.1.0-beta.3 is a maintainer-led daily-drive beta. Native contributor lanes create
unsigned Linux x64, macOS ARM64 and x64, and Windows x64 artifacts. These remain contributor builds,
not signed public releases. A separate manual workflow fails closed unless Windows signing and
Apple Developer ID plus notarization credentials are present. Nothing publishes automatically.

## Exact final-asset staging

`pnpm run stage:release-assets` is a local, no-network boundary between a lane's verified candidate
directory and a later publication workflow. It accepts an explicit lane, an input directory, an
external verification receipt, and a new empty output path:

```sh
pnpm run stage:release-assets -- \
  --lane linux-x64-unsigned \
  --input /absolute/path/to/candidate-input \
  --receipt /absolute/path/to/verification-receipt.json \
  --output /absolute/path/to/final-assets
```

The command permits only the current `package.json` version and one exact lane matrix. The input
directory must contain every expected direct file and nothing else. It rejects missing or extra
names, a stale version, directories, symlinks, non-regular files, a changed size, or a changed
SHA-256 digest. It never discovers artifacts with a release glob. Its output copies those exact
bytes and adds one deterministic JSON manifest bound to the source commit, package version, and
lane. The manifest contains no timestamp, host path, credentials, or release URL.

The initial allowlist is intentionally small:

| Lane | Exact assets |
| --- | --- |
| `linux-x64-unsigned` | AppImage, RPM, their shared SHA-256 file, the reproducible tar.xz archive, and that archive's JSON manifest and SHA-256 file |
| `macos-universal-signed` | universal DMG, ZIP, SHA-256 file, and `latest-mac.yml` |
| `windows-x64-signed` | x64 NSIS installer, ZIP, SHA-256 file, and `latest.yml` |

The receipt is an input from a platform-specific verifier. It records the exact source commit,
version, lane, asset names, sizes, and SHA-256 digests. A signed lane accepts only a receipt whose
signature status is `verified`; an unsigned receipt is rejected before any output directory is
created. This stager does not perform cryptographic signature verification, create a key, sign a
manifest, upload an artifact, create a GitHub release, or assert that an artifact is signed. A
future signed workflow must obtain that receipt from the native signature verifier for the exact
same bytes.

The current Linux lane remains explicitly unsigned. GitHub artifact attestations are the planned
provenance mechanism for a future hosted workflow. Native RPM signing and a detached OpenPGP-signed
final SHA-256 manifest for the AppImage remain later gates. This local staging command does not
claim that any of those mechanisms has run or that a hosted artifact exists.

## Linux artifacts

`pnpm run pack:linux` writes these versioned files under `release/`:

- `Threadleaf-<version>-linux-x86_64.AppImage`
- `Threadleaf-<version>-linux-x86_64.rpm`

`pnpm run test:linux-packages` extracts the exact AppImage, verifies and loads the ELF x64 addon,
runs independent-process `CLI-LOCK-01`, launches the packaged Electron native probe, verifies the
RPM identity and payload, then writes `Threadleaf-<version>-linux-x86_64.sha256` for both native
artifacts.

`pnpm run test:package-reproducible` builds the unpacked Linux application twice in independent
temporary directories. It compares every file, symlink, mode, size, and SHA-256 hash, then creates
two normalized tar.xz archives and requires identical bytes. From a clean source tree,
`pnpm run release:linux` also writes:

- `Threadleaf-<version>-linux-x64-reproducible.tar.xz`
- its complete JSON file manifest
- its SHA-256 checksum

This proves reproducibility of the unpacked application and normalized archive. It does not yet
claim bit-for-bit reproducibility of the AppImage or RPM containers, whose builder metadata and
native packaging toolchains still need deterministic release work.

## macOS artifacts

Run the command matching the native machine:

```sh
pnpm run pack:mac:arm64
THREADLEAF_PACKAGE_ARCH=arm64 pnpm run test:macos-package
```

or:

```sh
pnpm run pack:mac:x64
THREADLEAF_PACKAGE_ARCH=x64 pnpm run test:macos-package
```

The verifier runs the packaged executable, checks its Mach-O architecture and exact unpacked native
addon, runs independent-process `CLI-LOCK-01` and the packaged Electron native probe, checks the
bundle identifier, version, external demo vault, license, application archive, and GitHub update
provider. It fully tests the ZIP, verifies the DMG checksum, recomputes every update-metadata size
and SHA-512 digest, and writes SHA-256 checksums. The source and package contracts are configured
for native ARM64, Intel, and universal macOS hosts, but this candidate has no hosted macOS runtime
result yet. The Intel lifecycle gate additionally mounts
the DMG into a temporary root, launches a disposable vault through CDP, exercises create/edit/
restart, replaces the app with distinct candidate and baseline builds, removes the app, and proves
private state and vault bytes survive. Its evidence is retained as a CI artifact; the first hosted
run remains pending.

Contributor macOS packages explicitly disable identity discovery and hardened runtime because they
are unsigned. This makes the boundary visible: Gatekeeper should reject them. A release candidate
instead uses a universal binary, requires a Developer ID Application signature, enables hardened
runtime, submits the app through Apple's notary service, validates the stapled ticket, and requires
Gatekeeper assessment to pass.

## Windows artifacts

On native x64 Windows:

```powershell
pnpm run pack:windows
pnpm run test:windows-package
```

The verifier runs the unpacked application, expands and runs the ZIP, silently installs the NSIS
package into an isolated temporary directory, runs that installed executable, uninstalls it, and
requires the installation directory to disappear. It also inventories the extracted PE x64 native
addon, runs the independent-process `CLI-LOCK-01` proof, exercises the packaged Electron
`--native-lock-probe`, checks the external demo and license, recomputes update-metadata sizes and
SHA-512 digests, inspects Authenticode state, and writes SHA-256 checksums. Windows packages are
built only on native Windows x64 hosts; Linux cross-build claims are rejected. The hosted lifecycle
gate uses the real NSIS installer, a disposable user-data root and vault, a forced process
interruption, a distinct candidate and baseline build, rollback, uninstall, and residue checks. Its
first hosted run remains pending because this repository has no public remote.

## Hosted native CI

`.github/workflows/ci.yml` runs a local lifecycle-integrity fixture plus the complete source gate and
native package verifier on Ubuntu 24.04, Windows Server 2025, macOS 15 ARM64, and macOS 15 Intel.
The Windows x64 and Intel macOS jobs run the installed lifecycle gate and upload its privacy-safe
logs, screenshots, manifests, and failure evidence even when that gate fails. Every third-party
action is pinned to an immutable commit, repository authority is read-only, jobs have explicit
timeouts, and artifacts expire after 14 days. The integrity fixture parses both workflow files and
the package contract, rejects mutable or unreviewed action references, and fails if a native
lifecycle step is removed or made skippable. The same workflows also pass `actionlint` 1.7.12
locally.

The CI workflow can run on pull requests, pushes to `main`, or manual dispatch. It never signs,
publishes, or receives release credentials.

## Signed release candidate

`.github/workflows/release.yml` can run only through manual dispatch against an existing tag that
exactly matches `v<package version>`. Its `publish` input defaults to `false`. When false, it builds
and retains candidate artifacts in Actions without changing a GitHub release. When explicitly set
to true, it attests every artifact and creates or updates a draft release only after every native
gate passes.

The signed lanes require these repository secrets:

- `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` for the Developer ID Application certificate.
- `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` for notarization.
- `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` for the Authenticode certificate.

Missing credentials fail before packaging. macOS `forceCodeSigning`, notarization, code-signature,
stapling, and Gatekeeper checks all fail closed. Windows `forceCodeSigning` and Authenticode checks
do the same. Linux artifacts are reproducible and provenance-attested in this workflow, but Linux
native-container signing remains an open release gate.

## Manual signed updates

Threadleaf never checks for updates in the background. Opening Settings > About and updates reads
only local package policy. On an eligible release, the user separately chooses Check for updates,
Download update, and Restart and install. Download and install never begin merely because the app
started, opened Settings, or found a newer version.

The updater is fail-closed:

- Development builds do not initialize the update provider.
- Unsigned contributor packages do not initialize the update provider.
- Linux packages direct the user to the system package manager until Linux signing is complete.
- Only signed macOS and Windows release commands embed the exact
  `threadleafUpdateTrust=signed-release-v1` marker.
- Package verifiers run `--update-trust` and require signed candidates to report that marker while
  contributor packages report `none`.
- Raw provider failures stay in main-process diagnostics. The renderer receives a generic,
  retryable state and never receives a release URL, stack trace, or credential material.

Eligible packages use the generated GitHub release metadata through `electron-updater` 6.8.9 with
automatic download, install-on-quit, downgrade, and Windows web-installer behavior disabled. The
controller has unit coverage for explicit check, download, install, retry, duplicate-check
coalescing, progress normalization, and fail-closed eligibility. A real signed feed rehearsal still
requires a public remote and signed draft artifacts.

## Build and verify

The Linux lane requires Node.js 22 or newer, pnpm, Electron's Linux runtime dependencies,
`xvfb-run`, `rpm`, and the RPM build tools. Fedora 44 also needs `libxcrypt-compat` for the current
RPM toolchain. Hosted CI installs the FUSE 2 compatibility library and runs the exact AppImage.

Native state locking is built as a direct Node-API addon before the TypeScript main bundle. The
focused `test:native-lock-source`, `test:native-lock-electron`, `test:native-lock`, and
`test:native-lock-package` gates cover ABI surface, target-Electron loading, Linux child-process
behavior, atomic no-clobber rename, anonymous exact-byte publication without a target-side stage,
and the unpacked Electron module path. A local Linux pass does not claim macOS or Windows runtime or
installer proof; those remain pending native hosted lanes.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm run pack:linux
THREADLEAF_PACKAGED_SCREENSHOT_DIR=/tmp/threadleaf-package-visual pnpm run test:linux-packages
pnpm run test:package-reproducible
```

`pnpm run release:linux` is the clean-tree release command. It runs the complete repository check,
builds both native artifacts, verifies the exact AppImage and RPM, and writes the reproducible
archive and manifest. `release/` is intentionally ignored by Git.

## Packaged smoke contract

The smoke check proves all of the following against the packaged executable:

- `--version` exactly matches `package.json`.
- A development-only vault override cannot enter a package.
- First launch opens `resources/bundled-vault`, never a path inside `app.asar`.
- The bundled `.obsidian` fixture and Threadleaf license are present.
- The window reaches the real ready state with the expected notes and network-denying CSP.
- A second process using the same GUI profile exits while the first instance stays alive.
- The demo is visibly read-only and CodeMirror is not content-editable.
- Note, move, trash, save, and plugin-package controls are disabled.
- A direct preload `createNote` request is rejected by the workspace backend and writes no file.
- About and updates reports the installed version and the correct fail-closed platform policy.
- A disabled update policy exposes no enabled network action or inactive progress indicator.
- A disposable writable vault exposes properties in source order and accepts typed text, list,
  number, checkbox, date, and datetime add and edit actions through the real Electron bridge.
- Explicit property removal preserves every unrelated Markdown byte, and the packaged run exits
  without a stale-write warning after its own successful filesystem update.
- The application renders both dark and light appearances, including update settings at 1180x820
  and property add, edit, and removal dialogs at the minimum 860x640 viewport, and exits cleanly.

The bundled resource is intentionally read-only. It is a safe first-run tour, not a starter vault.
The user must explicitly open a local folder before Threadleaf permits writes or plugin-package
changes.

## Installed RPM check

On Fedora, the built RPM can be exercised through the same contract after installation:

```sh
sudo dnf install ./release/Threadleaf-0.1.0-beta.3-linux-x86_64.rpm
THREADLEAF_PACKAGED_EXECUTABLE=/opt/Threadleaf/threadleaf \
  THREADLEAF_PACKAGED_SCREENSHOT_DIR=/tmp/threadleaf-installed-visual \
  xvfb-run -a node scripts/check-packaged-app.mjs
rpm -V threadleaf
desktop-file-validate /usr/share/applications/threadleaf.desktop
```

An empty `rpm -V` result means the installed payload still matches the RPM database. The desktop
entry validation must also exit successfully.

## Linux upgrade and rollback rehearsal

`pnpm run test:upgrade-rollback` archives the pinned pre-handoff baseline source, builds it as
`0.1.0-alpha.0`, builds the current source as its declared version, and requires byte-distinct
AppImages. It then runs baseline, candidate, and baseline again against one isolated writable vault
and one persistent Threadleaf user-data directory.

The gate makes and verifies a note save in every package, leaves a second note byte-identical,
restores the selected vault and open tabs, and carries a custom hotkey and appearance choice both
forward and backward. It also requires private settings and workspace documents to remain mode
0600, proves candidate-only UI appears after upgrade and disappears after rollback, and rejects any
Threadleaf-private entry in the vault. This proves portable AppImage upgrade and rollback. It does
not substitute for the remaining signed-update-feed or native package-manager transaction gates.

## Native installer lifecycle evidence

The hosted Windows and Intel macOS lifecycle verifier is intentionally separate from the Linux
reproducibility proof. It builds a version-distinct unsigned baseline from the already-built
application, records artifact SHA-256 digests and a deterministic unpacked-tree digest, then runs
the actual target-platform install path. One synthetic vault and one private application-data root
are reused across baseline, restart-after-interruption, candidate, rollback, and removal. The
verifier calls only the packaged preload contract through a real renderer CDP target, so create and
save remain the same main-process write boundary used by the desktop. No user vault or installed
application path is used.

Run it only on a native x64 Windows or Intel macOS runner after the matching package command:

```sh
THREADLEAF_PACKAGE_ARCH=x64 \
THREADLEAF_LIFECYCLE_ARTIFACT_DIR=lifecycle-artifacts/native \
pnpm run test:installer-lifecycle
```

The contributor lane explicitly disables certificate identity discovery and requires the packaged
update policy to report `unsigned-package`. A successful lifecycle run therefore proves installation,
state continuity, vault preservation, rollback, and cleanup only. It does not prove Authenticode,
Developer ID, notarization, Gatekeeper, a public update feed, or store publication. The manual
signed workflow keeps those gates separate and fails closed when credentials are absent.

## Remaining release gates

Signed public releases still require the first hosted Intel macOS and Windows runs, real signing
authority, a successful signed release and update-feed rehearsal, Linux native-container signing,
native package-manager upgrade and downgrade tests, and published support and security-response
procedures. Until those gates pass, every local package remains clearly labeled unsigned.
