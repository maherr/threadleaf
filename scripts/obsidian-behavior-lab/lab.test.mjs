import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  FIXTURE_ID,
  FIXTURE_PREDICATE,
  generateFixture,
  verifyFixtureManifest,
} from "./fixture.mjs";
import { snapshotAllowlistedProfile, snapshotTree } from "./manifest.mjs";
import {
  assertFlatpakContainmentArgs,
  assertReferenceReceipt,
  assertRendererX11,
  assertRunPathContainment,
  markedProcesses,
  terminateMarkedProcesses,
  waitForExit,
  writeHelperScript,
} from "./process.mjs";

const roots = [];
const scratchRoot = path.join(os.tmpdir(), "threadleaf-obsidian-lab");

async function tempRoot(prefix = "threadleaf-obsidian-lab-test-") {
  await fs.mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(scratchRoot, `test-${prefix}`));
  await fs.chmod(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("synthetic fixture", () => {
  it("is deterministic and matches the committed manifest shape", async () => {
    const root = await tempRoot();
    const fixturePath = path.join(root, "vault");
    const generated = await generateFixture(fixturePath);
    const committed = JSON.parse(
      await fs.readFile(
        path.join(process.cwd(), "compatibility", "obsidian-lab-fixture.v1.json"),
        "utf8",
      ),
    );
    assert.equal(generated.manifest.fixtureId, FIXTURE_ID);
    assert.equal(generated.manifest.files.length, 21);
    assert.equal(
      generated.manifest.treeSha256,
      "fbaefb1895deadfdfe342aa437aef10781130ff00a9e40cfb6bc61fc5c10b353",
    );
    assert.match(
      await fs.readFile(path.join(fixturePath, "00 Overview.md"), "utf8"),
      new RegExp(FIXTURE_PREDICATE),
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(fixturePath, ".obsidian/community-plugins.json"))),
      [],
    );
    const snapshot = await snapshotTree(fixturePath, { label: "test" });
    assert.equal(snapshot.treeSha256, generated.manifest.treeSha256);
    assert.deepEqual(generated.manifest, committed);
    await assert.doesNotReject(() => verifyFixtureManifest(fixturePath, generated.manifest));
  });

  it("targets only the visible CodeMirror editor for synthetic input", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "scripts", "obsidian-behavior-lab", "sandbox-supervisor.py"),
      "utf8",
    );
    assert.match(source, /\.markdown-source-view\.mod-cm6 \.cm-content\[contenteditable="true"\]/u);
    assert.doesNotMatch(source, /querySelectorAll\('\[contenteditable="true"\]'\)/u);
    assert.match(source, /Browse vault in Restricted Mode/u);
    assert.match(source, /Input\.dispatchMouseEvent/u);
  });

  it("red control rejects one mutated source byte", async () => {
    const root = await tempRoot();
    const fixturePath = path.join(root, "vault");
    const generated = await generateFixture(fixturePath);
    await fs.appendFile(path.join(fixturePath, "00 Overview.md"), "RED-CONTROL\n");
    await assert.rejects(
      () => verifyFixtureManifest(fixturePath, generated.manifest),
      /Fixture tree hash changed/u,
    );
  });
});

describe("profile and process containment", () => {
  it("hashes only captured profile files and reports an unexpected path without reading it", async () => {
    const root = await tempRoot();
    const profilePath = path.join(root, "profile");
    await fs.mkdir(path.join(profilePath, "Default"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(profilePath, "Default", "Preferences"), "{}\n", { mode: 0o600 });
    const unexpected = path.join(profilePath, "secret.db");
    await fs.writeFile(unexpected, "private fixture canary", { mode: 0o600 });
    await fs.chmod(unexpected, 0);
    const snapshot = await snapshotAllowlistedProfile(profilePath, { label: "test" });
    assert.equal(snapshot.safe, false);
    assert.deepEqual(
      snapshot.unexpected.map((entry) => entry.path),
      ["secret.db"],
    );
    assert.ok(snapshot.captured.some((entry) => entry.path === "Default/Preferences"));
  });

  it("cleans marked detached descendants and red-controls Wayland", async () => {
    const root = await tempRoot();
    const helperPath = await writeHelperScript(root);
    const outputPath = path.join(root, "helper.json");
    const marker = `THREADLEAF_OBSIDIAN_LAB_TEST_${path.basename(root).slice(-8)}`;
    const child = spawn(process.execPath, [helperPath, outputPath], {
      env: { ...process.env, [marker]: "1" },
      stdio: "ignore",
    });
    const exit = await waitForExit(child, 5_000);
    assert.equal(exit.code, 0);
    const before = await markedProcesses(marker);
    assert.ok(before.length > 0);
    const cleanup = await terminateMarkedProcesses(marker);
    assert.equal(cleanup.clean, true);
    assert.deepEqual(await markedProcesses(marker), []);
    assert.throws(
      () => assertRendererX11(["obsidian --type=renderer --ozone-platform=wayland"], "red control"),
      /x11|wayland/iu,
    );
  });

  it("red-controls any weakened Flatpak launch policy", () => {
    const runRoot = "/tmp/threadleaf-obsidian-lab-scratch/run-1";
    const safe = [
      "run",
      "--sandbox",
      "--die-with-parent",
      "--unshare=network",
      "--nofilesystem=home",
      `--filesystem=${runRoot}:rw`,
      "--socket=x11",
      "--nosocket=wayland",
      "--command=/usr/bin/python3",
    ];
    assert.equal(assertFlatpakContainmentArgs(safe, { runRoot }), true);
    assert.throws(
      () => assertFlatpakContainmentArgs(safe.filter((flag) => flag !== "--unshare=network")),
      /unshare=network/u,
    );
    assert.throws(
      () => assertFlatpakContainmentArgs([...safe, "--share=network"]),
      /shares network/u,
    );
    assert.throws(
      () => assertFlatpakContainmentArgs([...safe, "--parent-share-pids"]),
      /host PID visibility/u,
    );
    assert.throws(
      () => assertFlatpakContainmentArgs([...safe, "--filesystem=home"]),
      /exactly one filesystem|broad host filesystem/u,
    );
    assert.throws(
      () =>
        assertFlatpakContainmentArgs(
          safe.map((flag) => (flag === "--socket=x11" ? "--socket=wayland" : flag)),
          { runRoot },
        ),
      /missing|unexpected host socket/u,
    );
    assert.throws(
      () =>
        assertFlatpakContainmentArgs(
          safe.map((flag) => (flag.startsWith("--filesystem=") ? "--filesystem=/tmp:rw" : flag)),
          { runRoot },
        ),
      /dedicated run root/u,
    );
    assert.throws(
      () => assertFlatpakContainmentArgs([...safe, "--device=all"]),
      /broad host device/u,
    );
  });

  it("red-controls live profile, vault, and workspace paths", () => {
    const scratch = "/tmp/threadleaf-obsidian-lab-scratch";
    assert.doesNotThrow(() =>
      assertRunPathContainment(
        {
          scratchRoot: scratch,
          runRoot: `${scratch}/run-1`,
          profilePath: `${scratch}/run-1/profile`,
          vaultPath: `${scratch}/run-1/vault`,
        },
        "positive control",
      ),
    );
    assert.throws(
      () =>
        assertRunPathContainment(
          {
            scratchRoot: scratch,
            runRoot: `${scratch}/run-1`,
            profilePath: `${scratch}/run-1/profile`,
            vaultPath: `${process.env.HOME}/MEGA/real-vault`,
          },
          "wrong vault",
        ),
      /vault is not below the run root|live application or workspace/u,
    );
    assert.throws(
      () =>
        assertRunPathContainment(
          {
            scratchRoot: scratch,
            runRoot: `${scratch}/run-1`,
            profilePath: `${process.env.HOME}/.var/app/md.obsidian.Obsidian`,
            vaultPath: `${scratch}/run-1/vault`,
          },
          "live profile",
        ),
      /profile is not below the run root|live application or workspace/u,
    );
  });

  it("red-controls wrong process/version/profile/vault/display/network and truncation", async () => {
    const root = await tempRoot();
    const profilePath = path.join(root, "profile");
    const vaultPath = path.join(root, "vault");
    const hostNamespace = "net:[100]";
    const isolatedNamespace = "net:[200]";
    const cdpPort = 1234;
    const appUri = `obsidian://open?path=${encodeURIComponent(path.join(vaultPath, "00 Overview.md"))}`;
    const baseline = {
      status: "observed",
      reference: {
        flatpakId: "md.obsidian.Obsidian",
        version: "1.13.7",
        runtime: "org.freedesktop.Platform/x86_64/25.08",
        commit: "b".repeat(64),
      },
      appProcess: {
        pid: 3,
        parentPid: 2,
        start: { epochSeconds: 1 },
        markerPresent: false,
        executable: "/app/obsidian",
        argv: [
          "/app/obsidian",
          "--ozone-platform=x11",
          "--disable-gpu",
          "--no-first-run",
          "--window-size=800,650",
          `--remote-debugging-port=${cdpPort}`,
          "--remote-debugging-address=127.0.0.1",
          `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
          `--user-data-dir=${profilePath}`,
          vaultPath,
          appUri,
        ],
        networkNamespace: isolatedNamespace,
        commandLine: `/app/obsidian --ozone-platform=x11 --disable-gpu --no-first-run --window-size=800,650 --remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1 --remote-allow-origins=http://127.0.0.1:${cdpPort} --user-data-dir=${profilePath} ${vaultPath} ${appUri}`,
      },
      supervisorPid: 2,
      uriDispatch: {
        argv: [
          "/app/obsidian",
          "--ozone-platform=x11",
          "--disable-gpu",
          "--no-first-run",
          "--window-size=800,650",
          `--remote-debugging-port=${cdpPort}`,
          "--remote-debugging-address=127.0.0.1",
          `--remote-allow-origins=http://127.0.0.1:${cdpPort}`,
          `--user-data-dir=${profilePath}`,
          vaultPath,
          appUri,
        ],
        parentPid: 2,
        accepted: true,
        source: "in-sandbox initial app argv",
        private: true,
      },
      paths: {
        profile: { realpath: profilePath, treeSha256: "profile-before" },
        vault: { realpath: vaultPath, treeSha256: "fixture" },
      },
      pathsAfterCleanup: {
        profile: { realpath: profilePath, treeSha256: "profile-after" },
        vault: { realpath: vaultPath, treeSha256: "mutated" },
      },
      network: {
        namespace: isolatedNamespace,
        hostNamespace,
        routes: [],
        devices: ["lo"],
        noEgressEvidence: true,
      },
      display: { value: ":123", wayland: null },
      rendererProcesses: [
        {
          pid: 4,
          parentPid: 3,
          start: { epochSeconds: 2 },
          markerPresent: false,
          argv: [
            "/app/obsidian",
            "--type=renderer",
            "--ozone-platform=x11",
            `--user-data-dir=${profilePath}`,
            `--remote-debugging-port=${cdpPort}`,
          ],
          commandLine: `/app/obsidian --type=renderer --ozone-platform=x11 --user-data-dir=${profilePath} --remote-debugging-port=${cdpPort}`,
          networkNamespace: isolatedNamespace,
        },
      ],
      target: {
        type: "page",
        address: "127.0.0.1",
        port: cdpPort,
        webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/page/fixture",
      },
      cdp: {
        browserVersion: {
          product: "Chrome/136.0.0.0",
          userAgent: "Mozilla/5.0 Obsidian/1.13.7",
        },
      },
      visible: {
        viewport: { width: 800, height: 650, deviceScaleFactor: 1, pageScale: 1 },
      },
      roundtrip: {
        status: "observed",
        exact: true,
        beforeSha256: "before-note",
        mutatedSha256: "mutated-note",
        reopenedSha256: "mutated-note",
      },
      screenshot: {
        complete: true,
        fromSurface: true,
        captureBeyondViewport: false,
        bytes: 2048,
        sha256: "a".repeat(64),
        pngWidth: 800,
        pngHeight: 650,
      },
      cleanup: { clean: true },
      processesAfterCleanup: [],
      appProcessesAfterCleanup: [],
      referenceProcessesAfterCleanup: [],
      hostCleanup: {
        markerBefore: [],
        finalMarked: [],
        flatpakBefore: { entries: [] },
        flatpakAfter: { entries: [] },
        clean: true,
      },
    };
    const expected = {
      runRoot: root,
      profilePath,
      vaultPath,
      vaultTreeSha256: "fixture",
      vaultAfterTreeSha256: "mutated",
      profileBeforeTreeSha256: "profile-before",
      profileAfterTreeSha256: "profile-after",
      referenceVersion: "1.13.7",
      referenceRuntime: "org.freedesktop.Platform/x86_64/25.08",
      referenceCommit: "b".repeat(64),
      hostNetworkNamespace: hostNamespace,
    };
    assert.doesNotThrow(() => assertReferenceReceipt(baseline, expected));
    const controls = [
      ["process", (value) => (value.appProcess.executable = "/wrong"), /executable/iu],
      ["lineage", (value) => (value.appProcess.parentPid = 99), /direct child/iu],
      ["argv", (value) => value.appProcess.argv.pop(), /exact .*launch/iu],
      ["version", (value) => (value.reference.version = "0.0.0"), /version/iu],
      [
        "runtime",
        (value) => (value.reference.runtime = "org.freedesktop.Platform/x86_64/24.08"),
        /app\/runtime/iu,
      ],
      ["profile", (value) => (value.paths.profile.realpath = "/wrong/profile"), /realpaths/iu],
      ["vault", (value) => (value.paths.vault.realpath = "/wrong/vault"), /realpaths/iu],
      ["profile hash", (value) => (value.paths.profile.treeSha256 = "wrong"), /hashes/iu],
      [
        "profile after hash",
        (value) => (value.pathsAfterCleanup.profile.treeSha256 = "wrong"),
        /hashes/iu,
      ],
      ["vault hash", (value) => (value.paths.vault.treeSha256 = "wrong"), /hashes/iu],
      ["display", (value) => (value.display.wayland = ":0"), /display/iu],
      ["network", (value) => (value.network.namespace = hostNamespace), /network/iu],
      ["user agent", (value) => (value.cdp.browserVersion.userAgent = "Chrome"), /user agent/iu],
      ["viewport", (value) => (value.visible.viewport.width = 1180), /viewport/iu],
      ["roundtrip", (value) => (value.roundtrip.exact = false), /roundtrip/iu],
      ["orphan", (value) => value.referenceProcessesAfterCleanup.push({ pid: 9 }), /cleanup/iu],
      ["truncated", (value) => (value.screenshot.complete = false), /truncated|partial/iu],
    ];
    for (const [label, mutate, message] of controls) {
      const candidate = structuredClone(baseline);
      mutate(candidate);
      assert.throws(
        () => assertReferenceReceipt(candidate, expected),
        message,
        `red control did not reject ${label}`,
      );
    }
  });
});
