# Release engineering

Threadleaf 0.1.0-beta.1 is a maintainer-led daily-drive beta. Native contributor lanes create
unsigned Linux x64, macOS ARM64 and x64, and Windows x64 artifacts. These remain contributor builds,
not signed public releases. A separate manual workflow fails closed unless Windows signing and
Apple Developer ID plus notarization credentials are present. Nothing publishes automatically.

## Linux artifacts

`pnpm run pack:linux` writes these versioned files under `release/`:

- `Threadleaf-<version>-linux-x86_64.AppImage`
- `Threadleaf-<version>-linux-x86_64.rpm`

`pnpm run test:linux-packages` launches the exact AppImage, verifies the RPM identity and payload,
then writes `Threadleaf-<version>-linux-x86_64.sha256` for both native artifacts.

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

The verifier runs the packaged executable, checks its Mach-O architecture, bundle identifier,
version, external demo vault, license, application archive, and GitHub update provider. It fully
tests the ZIP, verifies the DMG checksum, recomputes every update-metadata size and SHA-512 digest,
and writes SHA-256 checksums. The ARM64 lane has passed on an M4 Mac. Intel packaging is configured
for its native hosted runner and still needs its first hosted run.

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
requires the installation directory to disappear. It also checks the external demo and license,
recomputes update-metadata sizes and SHA-512 digests, inspects Authenticode state, and writes
SHA-256 checksums. Linux can cross-build the Windows ZIP, but NSIS requires Wine there, so the real
installer gate intentionally runs on native Windows. That hosted gate is configured but has not yet
run because this repository has no public remote.

## Hosted native CI

`.github/workflows/ci.yml` runs the complete source gate and native package verifier on Ubuntu
24.04, Windows Server 2025, macOS 15 ARM64, and macOS 15 Intel. Every third-party action is pinned to
an immutable commit, repository authority is read-only, jobs have explicit timeouts, and artifacts
expire after 14 days. A repository test parses both workflow files and rejects mutable or unreviewed
action references. The same workflows also pass `actionlint` 1.7.12 locally.

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
sudo dnf install ./release/Threadleaf-0.1.0-beta.1-linux-x86_64.rpm
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

## Remaining release gates

Signed public releases still require the first hosted Intel macOS and Windows runs, real signing
authority, a successful signed release and update-feed rehearsal, Linux native-container signing,
native package-manager upgrade and downgrade tests, and published support and security-response
procedures. Until those gates pass, every local package remains clearly labeled unsigned.
