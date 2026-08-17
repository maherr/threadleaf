import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorityJsonSha256 } from "../src/shared/authority-json-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trustDirectory = path.join(projectRoot, "scripts", "compatibility", "trust");
const fixtureProfileName = "inspection-safe-0.1.0.authority-profile.json";

function authorityDigest(profile) {
  const payload = {
    schemaVersion: profile.schemaVersion,
    profileId: profile.profileId,
    profileRevision: profile.profileRevision,
    packageIdentity: profile.packageIdentity,
    packageIdentityDigest: profile.packageIdentityDigest,
    expectedStaticCapabilities: profile.expectedStaticCapabilities,
    requiredAuthorities: profile.requiredAuthorities,
    executionProfile: profile.executionProfile,
    allowedPlatforms: profile.allowedPlatforms,
  };
  return authorityJsonSha256(payload);
}

async function copyFileIntoFixture(source, fixtureRoot, relativePath) {
  const target = path.join(fixtureRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(source, relativePath), target);
}

async function createFixture(mutateProfile) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "threadleaf-registry-digest-"));
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const evidence = JSON.parse(
    await readFile(path.join(projectRoot, "compatibility", "plugin-evidence.v1.json"), "utf8"),
  );
  const profile = JSON.parse(await readFile(path.join(trustDirectory, fixtureProfileName), "utf8"));
  mutateProfile(profile);

  const template = structuredClone(evidence.entries.at(-1));
  assert(template, "Plugin evidence source has no reusable workflow fixture.");
  template.plugin = {
    ...template.plugin,
    id: profile.packageIdentity.pluginId,
    name: "Synthetic reviewed authority fixture",
    version: profile.packageIdentity.manifestVersion,
    bundleSha256: profile.packageIdentity.mainSha256,
  };
  template.threadleafVersion = packageJson.version;
  template.compatibilityLevel = 4;
  template.summary = "Synthetic Level 4 row for reviewed authority digest rejection.";
  template.requiredCapabilities = [...profile.expectedStaticCapabilities];

  await copyFileIntoFixture(projectRoot, fixtureRoot, "package.json");
  await copyFileIntoFixture(
    projectRoot,
    fixtureRoot,
    "scripts/generate-plugin-compatibility-registry.mjs",
  );
  for (const relativePath of [
    "scripts/compatibility/level4-verifier.mjs",
    "scripts/compatibility/level4-artifacts.mjs",
    "src/shared/level4-receipt-boundary.mjs",
  ]) {
    await copyFileIntoFixture(projectRoot, fixtureRoot, relativePath);
  }
  await cp(
    path.join(projectRoot, "node_modules", "canonicalize"),
    path.join(fixtureRoot, "node_modules", "canonicalize"),
    { recursive: true },
  );
  await copyFileIntoFixture(projectRoot, fixtureRoot, "src/shared/authority-json-runtime.mjs");
  for (const gate of template.workflows.flatMap((workflow) => workflow.gates)) {
    await copyFileIntoFixture(projectRoot, fixtureRoot, gate.path);
  }
  const trustNames = (await readdir(trustDirectory)).filter((name) =>
    name.endsWith(".authority-profile.json"),
  );
  for (const name of trustNames) {
    const target = path.join(fixtureRoot, "scripts", "compatibility", "trust", name);
    await mkdir(path.dirname(target), { recursive: true });
    if (name === fixtureProfileName) {
      await writeFile(target, `${JSON.stringify(profile, null, 2)}\n`);
    } else {
      await cp(path.join(trustDirectory, name), target);
    }
  }
  const evidencePath = path.join(fixtureRoot, "compatibility", "plugin-evidence.v1.json");
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify({ schemaVersion: 2, entries: [template] }, null, 2)}\n`,
  );
  return fixtureRoot;
}

async function runGenerate(fixtureRoot) {
  const child = spawn(process.execPath, ["scripts/generate-plugin-compatibility-registry.mjs"], {
    cwd: fixtureRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
    });
  }
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}

async function expectDigestRejection(label, expectedMessage, mutateProfile) {
  const fixtureRoot = await createFixture(mutateProfile);
  try {
    const result = await runGenerate(fixtureRoot);
    assert.notEqual(
      result.code,
      0,
      `${label} unexpectedly promoted forged Level 4 evidence:\n${result.output}`,
    );
    assert.match(result.output, expectedMessage);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await expectDigestRejection(
  "package identity digest mismatch",
  /packageIdentityDigest is stale/u,
  (profile) => {
    profile.packageIdentityDigest = "0".repeat(64);
    profile.authorityDigest = authorityDigest(profile);
  },
);
await expectDigestRejection("authority digest mismatch", /authorityDigest is stale/u, (profile) => {
  profile.authorityDigest = "0".repeat(64);
});

console.log("compatibility registry rejected forged Level 4 identity and authority digests");
