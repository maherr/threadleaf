# Release engineering

Threadleaf is pre-alpha. The current package lane creates unsigned Linux x64 contributor artifacts,
not a supported public release. Windows and macOS configuration is present for development, but
those native artifacts are not yet release-gated, signed, or notarized.

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

## Build and verify

The Linux lane requires Node.js 22 or newer, pnpm, Electron's Linux runtime dependencies,
`xvfb-run`, `rpm`, and the RPM build tools. Fedora 44 also needs `libxcrypt-compat` for the current
RPM toolchain.

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
- The application renders both dark and light appearances and exits cleanly.

The bundled resource is intentionally read-only. It is a safe first-run tour, not a starter vault.
The user must explicitly open a local folder before Threadleaf permits writes or plugin-package
changes.

## Installed RPM check

On Fedora, the built RPM can be exercised through the same contract after installation:

```sh
sudo dnf install ./release/Threadleaf-0.1.0-alpha.1-linux-x86_64.rpm
THREADLEAF_PACKAGED_EXECUTABLE=/opt/Threadleaf/threadleaf \
  THREADLEAF_PACKAGED_SCREENSHOT_DIR=/tmp/threadleaf-installed-visual \
  xvfb-run -a node scripts/check-packaged-app.mjs
rpm -V threadleaf
desktop-file-validate /usr/share/applications/threadleaf.desktop
```

An empty `rpm -V` result means the installed payload still matches the RPM database. The desktop
entry validation must also exit successfully.

## Remaining release gates

Public releases still require platform-native verification on Windows and macOS, signing authority,
macOS notarization, trusted update metadata, upgrade and downgrade tests, rollback, and published
support and security-response procedures. Until those gates pass, every local package remains
clearly labeled pre-alpha and unsigned.
