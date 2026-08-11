# Changelog

All notable changes to Threadleaf will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once public releases begin.

## [Unreleased]

### Added

- Initial project charter, architecture, compatibility contract, and execution roadmap.
- Read-only synthetic Markdown vault fixture.
- Independently implemented compatibility API for plugin, vault, command, file, and notice behavior.
- Trusted CommonJS plugin host with observable load, command, unload, and reload lifecycles.
- Isolated Electron renderer with light and dark runtime-inspection surfaces.
- Tests proving the fixture remains byte-for-byte unchanged and rejecting plugin paths outside the
  active vault.
- Build verification for Electron entry points and relative `file://` renderer assets.
- Safe vault-kernel foundation with canonical path containment, stable content revisions,
  single-writer serialization, durable recovery journals, no-clobber writes, explicit conflict
  copies, recoverable renames, and interruption-matrix tests.
