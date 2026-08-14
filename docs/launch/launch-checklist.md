# Launch checklist

Threadleaf is not affiliated with or endorsed by Obsidian. This is the operational runbook for
taking this repository from a private, local-only working copy to a public release. It is a
skeleton: every step below is a checklist item, not a command that has been run. Nothing in this
document has been executed while preparing it. No step here pushes, publishes, tags, or contacts
any external service.

Where a real repository command exists, it is shown so the maintainer can run it directly instead
of improvising one at launch time. Where a decision has not been made yet (a hosting destination, an
announcement channel), that is stated plainly instead of inventing one.

## 0. Before starting

- [ ] Confirm this checklist is being run against the exact commit intended for launch, not an
      older cached copy. A checklist prepared ahead of time can drift from reality by the time it
      is used; re-read `docs/charter.md` and `docs/roadmap.md` for current state before proceeding.
- [ ] Confirm the intended release version in `package.json` (`"version"`) and derive the release
      tag from it: `v<version>`.
- [ ] Confirm whether a git remote is already configured (`git remote -v`). If none is configured,
      this repository is still local-only and step 2 is a real first-time action, not a formality.

## 1. OPSEC history scan

Run before the repository is ever pushed anywhere public, and again if any history is rewritten
after an earlier scan.

- [ ] Scan full history, not only the current tree, for personal names, internal hostnames or IP
      addresses, absolute home-directory paths, API keys, and other credential-shaped strings:

  ```sh
  git grep -iE '<name-or-secret-pattern-to-check>' $(git rev-list --all)
  ```

- [ ] Confirm no database files, keystores, or private key material were ever committed:

  ```sh
  git log --all -- '*.db' '*.jks' '*.keystore' '*.p12' '*.pem'
  ```

- [ ] Confirm every commit's author and committer identity is the intended public identity, not a
      personal or internal one:

  ```sh
  git log --all --format='%an <%ae> / %cn <%ce>' | sort -u
  ```

- [ ] If anything unwanted is found, decide between a full history rewrite (`git-filter-repo` or
      equivalent) before any push, or a squash to a clean snapshot. Do not push first and clean up
      after; a public git host can retain pushed history and forks indefinitely, and CT logs
      already retain any hostname served over HTTPS.
- [ ] Confirm `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `README.md`, and `package.json` metadata
      (`name`, `description`, `license`, `repository` if added) read correctly for a first-time
      public visitor with no prior context.

## 2. Public flip

- [ ] Decide the public repository host and exact repository name. Keep it brand-neutral and
      consistent with whatever public identity was confirmed in step 1.
- [ ] Create the remote repository.
- [ ] Add the remote and push the reviewed branch and tags:

  ```sh
  git remote add origin <public-remote-url>
  git push origin main --follow-tags
  ```

- [ ] Flip repository visibility to public only after the OPSEC scan in step 1 is clean and after
      confirming the push contains exactly the reviewed history, nothing rewound or reordered by a
      race with local work.

## 3. CI green

- [ ] Confirm `.github/workflows/ci.yml` ("Native package CI") runs on the pushed branch and every
      job passes: `integrity` (`pnpm run test:installer-lifecycle-config`, validating the lifecycle
      workflow files and the package contract), `linux`, `macos` (both `arm64` and `x64`), and
      `windows`.
- [ ] Confirm the Linux job's committed visual regression matrix step passes, not only the package
      build.
- [ ] Confirm the Windows job's and the Intel-macOS matrix leg's installer lifecycle evidence
      uploads (logs, screenshots, manifests) are present even if a lifecycle step failed, and read
      them if so. The ARM64 macOS leg does not run this lifecycle gate.
- [ ] Separately, run `actionlint` locally against both workflow files; `docs/releases.md` notes
      Threadleaf was checked against actionlint 1.7.12 this way, and it is not currently a step
      inside the CI job itself.
- [ ] Do not proceed to tagging or release while any required job is red.

## 4. Tag

- [ ] Confirm `package.json` `"version"` is the exact intended release version.
- [ ] Create an annotated tag matching `v<package.json version>` exactly. `.github/workflows/release.yml`
      only runs through manual dispatch against an existing tag matching this pattern, so a
      mismatched tag will not be usable in step 5.

  ```sh
  git tag -a v<version> -m "Threadleaf <version>"
  git push origin v<version>
  ```

## 5. Signed release candidate

- [ ] Decide whether this launch ships a signed macOS/Windows candidate or Linux-only unsigned
      artifacts. Confirm the required repository secrets are present if signing is wanted:
      `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`, `APPLE_API_KEY_ID`,
      `APPLE_API_ISSUER`, `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` (see `docs/releases.md`).
      Missing credentials fail the signed lanes closed before packaging.
- [ ] Run `.github/workflows/release.yml` ("Signed release candidate") via manual dispatch against
      the pushed tag with `publish=false` first. This builds and retains candidate artifacts in
      Actions without touching a GitHub release.
- [ ] Review the candidate artifacts, checksums, and attestations before proceeding.
- [ ] Re-run with `publish=true` only after every native gate passes. This attests every artifact
      and creates or updates a draft release.
- [ ] Manually review and publish the draft release on the host. Publishing a draft release is a
      separate, deliberate maintainer action; the workflow does not do it automatically.
- [ ] Note for this launch specifically: Linux artifacts remain unsigned by design at this stage
      (native-container signing for the AppImage and RPM is an open release gate per
      `docs/releases.md`). Decide whether to launch with unsigned Linux artifacts clearly labeled as
      such, or hold Linux distribution until that gate closes.

## 6. Spec-site publish

- [ ] Regenerate and verify the public compatibility specification against the tagged commit:

  ```sh
  pnpm public-spec:build
  pnpm public-spec:check
  ```

- [ ] Decide a hosting destination for the generated static `public-spec/site/` directory. No
      destination is committed in this repository as of this checklist; `public-spec/README.md`
      states this explicitly: "Publishing the generated site is intentionally outside this local
      build and requires maintainer authorization."
- [ ] Publish `public-spec/site/` to the chosen destination.
- [ ] After publishing, spot-check that the live site's exact Threadleaf version and fixture
      references match the tagged release, not a later or earlier local build.

## 7. Registry publish

- [ ] Confirm the generated compatibility registry is current for the tagged commit:

  ```sh
  pnpm compatibility:generate
  pnpm compatibility:check
  ```

- [ ] No separate publish action is required for `docs/compatibility/registry.md` itself; it
      becomes readable the moment the repository goes public in step 2. This item exists to confirm
      it was regenerated against the tagged commit, not a stale local copy.
- [ ] Decide whether to submit Threadleaf to third-party discovery surfaces, for example the
      `awesome-obsidian-alternatives` directory referenced in
      `docs/research/alternatives-landscape.md`, or similar community lists. Undecided as of this
      checklist. If this happens, keep the same discipline `docs/launch/comparison.md` uses:
      Threadleaf's own compatibility contract explicitly refuses to treat "third-party directories,
      feature tables, stars, and README claims" as compatibility evidence, so any listing text
      should describe what is proven in this repository, not restate the directory's own framing.

## 8. Announcement surfaces

- [ ] No announcement channel is committed in this repository yet. The maintainer chooses at launch
      time.
- [ ] Draft launch-post content from `docs/launch/comparison.md` rather than writing new claims
      from scratch; every Threadleaf-side claim there is already cited to a file or command in this
      repository, which keeps a launch post honest under the same standard.
- [ ] Before posting anywhere, re-run `docs/launch/comparison.md`'s "Checking this yourself"
      commands against the tagged commit and confirm they still pass.
- [ ] After posting, watch the issue tracker and discussions (once enabled) for the first real user
      reports. `docs/roadmap.md` Phase 6, "Ecosystem and public launch," is the roadmap phase this
      launch begins; its own exit gate is that public releases are safe to recommend without
      maintainer caveats, which this checklist alone does not establish. A launch is the start of
      that phase, not the end of this checklist.

## Final gate

- [ ] Re-run this checklist top to bottom against the actual commit being launched immediately
      before step 2. A candidate written ahead of time, including this one, can drift from reality;
      confirm state rather than trusting the checklist's own age.
