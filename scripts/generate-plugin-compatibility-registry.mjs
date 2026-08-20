import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { authorityJsonSha256 } from "../src/shared/authority-json-runtime.mjs";
import {
  level4JsonSha256,
  parseLevel4TrustPolicyV1,
} from "../src/shared/level4-receipt-boundary.mjs";
import { readAuthorityJsonFile } from "./compatibility/level4-artifacts.mjs";
import { verifyLevel4Receipt } from "./compatibility/level4-verifier.mjs";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootPath, "compatibility", "plugin-evidence.v1.json");
const registryPath = path.join(rootPath, "compatibility", "registry.v1.json");
const generatedTypeScriptPath = path.join(
  rootPath,
  "src",
  "generated",
  "plugin-compatibility-registry.ts",
);
const generatedMarkdownPath = path.join(rootPath, "docs", "compatibility", "registry.md");
const reviewedAuthorityDirectory = path.join(rootPath, "scripts", "compatibility", "trust");
const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const platformStatuses = new Set(["verified", "packaged-only", "unverified"]);
const workflowStatuses = new Set(["passed", "failed", "unsupported"]);
const evidenceModes = new Set(["direct", "composed", "production-receipt"]);
const capabilityIds = new Set([
  "vault-read",
  "vault-write",
  "network",
  "filesystem",
  "subprocess",
  "host-environment",
  "clipboard",
  "external-navigation",
  "editor-extension",
  "workspace-ui",
  "dynamic-code",
]);

function fail(message) {
  throw new Error(`Plugin compatibility evidence: ${message}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value, label, maximum = 2_000) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\r\n\t]/u.test(value)
  ) {
    fail(`${label} must be one trimmed line no longer than ${maximum} characters.`);
  }
  return value;
}

function stringList(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array.`);
  }
  const result = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    fail(`${label} contains duplicates.`);
  }
  return result;
}

function oneOf(value, allowed, label) {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(`${label} has an unsupported value.`);
  }
  return value;
}

async function readJson(filePath, label) {
  try {
    return await readAuthorityJsonFile(filePath, label);
  } catch (error) {
    fail(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateGate(value, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object.`);
  }
  const gatePath = text(value.path, `${label}.path`, 500);
  const command = text(value.command, `${label}.command`, 500);
  if (path.isAbsolute(gatePath) || gatePath.split("/").includes("..")) {
    fail(`${label}.path must stay inside the repository.`);
  }
  try {
    const stat = await fs.stat(path.join(rootPath, gatePath));
    if (!stat.isFile()) {
      fail(`${label}.path is not a file.`);
    }
  } catch (error) {
    fail(`${label}.path does not exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: gatePath, command };
}

function reviewedAuthorityPayload(profile) {
  return {
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
}

async function reviewedAuthorityIdentities() {
  const names = (await fs.readdir(reviewedAuthorityDirectory))
    .filter((name) => name.endsWith(".authority-profile.json"))
    .sort();
  const identities = [];
  for (const name of names) {
    const profile = await readJson(
      path.join(reviewedAuthorityDirectory, name),
      `reviewed authority profile ${name}`,
    );
    if (
      !isRecord(profile) ||
      profile.schemaVersion !== 1 ||
      !isRecord(profile.packageIdentity) ||
      typeof profile.packageIdentity.pluginId !== "string" ||
      typeof profile.packageIdentity.manifestVersion !== "string" ||
      typeof profile.packageIdentity.mainSha256 !== "string" ||
      typeof profile.packageIdentityDigest !== "string" ||
      typeof profile.authorityDigest !== "string" ||
      !sha256Pattern.test(profile.packageIdentity.mainSha256) ||
      !sha256Pattern.test(profile.packageIdentityDigest) ||
      !sha256Pattern.test(profile.authorityDigest)
    ) {
      fail(`reviewed authority profile ${name} has no complete validated identity tuple.`);
    }
    const expectedIdentityDigest = authorityJsonSha256(profile.packageIdentity);
    if (profile.packageIdentityDigest !== expectedIdentityDigest) {
      fail(
        `reviewed authority profile ${name} packageIdentityDigest is stale; expected ${expectedIdentityDigest}.`,
      );
    }
    const expectedAuthorityDigest = authorityJsonSha256(reviewedAuthorityPayload(profile));
    if (profile.authorityDigest !== expectedAuthorityDigest) {
      fail(
        `reviewed authority profile ${name} authorityDigest is stale; expected ${expectedAuthorityDigest}.`,
      );
    }
    identities.push({
      pluginId: profile.packageIdentity.pluginId,
      manifestVersion: profile.packageIdentity.manifestVersion,
      mainSha256: profile.packageIdentity.mainSha256,
    });
  }
  return identities;
}

const level4ReceiptPathKeys = [
  "receiptPath",
  "replayIndexPath",
  "trustPolicyPath",
  "trustedControllerManifestPath",
  "controllerExecutablePath",
  "harnessTreePath",
  "workflowDefinitionPath",
  "fixtureTreePath",
  "packagePath",
  "sealedPackageRootPath",
  "packagedArtifactPath",
  "installedApplicationTreePath",
  "canonicalBuildManifestPath",
  "relevantDistTreePath",
  "electronExecutablePath",
  "authorityProfilePath",
  "preconditionsPath",
  "startingFixturePath",
  "vaultTreeBeforePath",
  "vaultTreeAfterPath",
];

function resolveEvidencePath(value, label) {
  const raw = text(value, label, 1_000);
  if (!path.isAbsolute(raw) && raw.split(/[\\/]/u).includes("..")) {
    fail(`${label} must not traverse a parent.`);
  }
  return path.resolve(rootPath, raw);
}

function level4ReceiptConfig(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [
    ...level4ReceiptPathKeys,
    "distributionTag",
    "requiredDistPaths",
    "requiredInstalledPaths",
    "screenshots",
    "platform",
    "architecture",
    "sourceCommit",
    "threadleafVersion",
    "electronVersion",
  ].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unsupported or missing verifier inputs.`);
  }
  const artifactPaths = Object.fromEntries(
    level4ReceiptPathKeys.map((key) => [key, resolveEvidencePath(value[key], `${label}.${key}`)]),
  );
  artifactPaths.distributionTag = text(value.distributionTag, `${label}.distributionTag`, 100);
  artifactPaths.requiredDistPaths = stringList(
    value.requiredDistPaths,
    `${label}.requiredDistPaths`,
  );
  artifactPaths.requiredInstalledPaths = stringList(
    value.requiredInstalledPaths,
    `${label}.requiredInstalledPaths`,
  );
  if (!Array.isArray(value.screenshots)) fail(`${label}.screenshots must be an array.`);
  artifactPaths.screenshots = value.screenshots.map((item, index) => {
    if (!isRecord(item)) fail(`${label}.screenshots[${index}] must be an object.`);
    return {
      path: resolveEvidencePath(item.path, `${label}.screenshots[${index}].path`),
      purpose: text(item.purpose, `${label}.screenshots[${index}].purpose`, 512),
    };
  });
  return {
    receiptPath: artifactPaths.receiptPath,
    artifactPaths,
    expected: {
      platform: text(value.platform, `${label}.platform`, 100),
      architecture: text(value.architecture, `${label}.architecture`, 100),
      sourceCommit: text(value.sourceCommit, `${label}.sourceCommit`, 128),
      threadleafVersion: text(value.threadleafVersion, `${label}.threadleafVersion`, 100),
      electronVersion: text(value.electronVersion, `${label}.electronVersion`, 100),
    },
  };
}

async function trustStoreIdentity(trustPolicyPath) {
  const policy = parseLevel4TrustPolicyV1(await readJson(trustPolicyPath, "Level 4 trust policy"));
  return level4JsonSha256(policy);
}

async function validateLevel4Receipt(
  value,
  label,
  plugin,
  packageVersion,
  { reviewedIdentities, allowFixtureOnly },
) {
  const config = level4ReceiptConfig(value, label);
  if (config.expected.threadleafVersion !== packageVersion)
    fail(`${label}.threadleafVersion is not the current package version.`);
  const authorityRelative = path.relative(
    reviewedAuthorityDirectory,
    config.artifactPaths.authorityProfilePath,
  );
  const authorityIsFixed =
    authorityRelative === "" ||
    (!authorityRelative.startsWith("..") && !path.isAbsolute(authorityRelative));
  if (!allowFixtureOnly && !authorityIsFixed)
    fail(`${label}.authorityProfilePath must name a checked-in reviewed authority profile.`);
  const verified = await verifyLevel4Receipt(config);
  if (
    verified.receipt.payload.packageIdentity.pluginId !== plugin.id ||
    verified.receipt.payload.packageIdentity.manifestVersion !== plugin.version ||
    verified.receipt.payload.packageIdentity.mainSha256 !== plugin.bundleSha256
  ) {
    fail(`${label} was accepted for a different exact package identity.`);
  }
  if (!allowFixtureOnly) {
    const reviewed = reviewedIdentities.some(
      (identity) =>
        identity.pluginId === plugin.id &&
        identity.manifestVersion === plugin.version &&
        identity.mainSha256 === plugin.bundleSha256,
    );
    if (!reviewed)
      fail(`${label} requires a fixed reviewed profile for the exact plugin identity.`);
  }
  const beforePublicationTrustIdentity = await trustStoreIdentity(
    config.artifactPaths.trustPolicyPath,
  );
  if (beforePublicationTrustIdentity !== verified.issuerTrustStoreIdentitySha256)
    fail(`${label} trust policy changed before registry publication.`);
  return {
    receiptFileSha256: verified.receiptFileSha256,
    verificationTupleDigest: verified.verificationTupleDigest,
    workflowId: verified.receipt.payload.workflowId,
    issuerKeyId: verified.receipt.payload.issuerKeyId,
    issuerTrustStoreIdentitySha256: verified.issuerTrustStoreIdentitySha256,
    config,
  };
}

async function validateEntry(value, index, packageVersion, reviewedIdentities, allowFixtureOnly) {
  const label = `entries[${index}]`;
  if (!isRecord(value) || !isRecord(value.plugin)) {
    fail(`${label} and its plugin field must be objects.`);
  }
  const plugin = {
    id: text(value.plugin.id, `${label}.plugin.id`, 128),
    name: text(value.plugin.name, `${label}.plugin.name`, 200),
    version: text(value.plugin.version, `${label}.plugin.version`, 100),
    repository: text(value.plugin.repository, `${label}.plugin.repository`, 500),
    license: text(value.plugin.license, `${label}.plugin.license`, 100),
    bundleSha256: text(value.plugin.bundleSha256, `${label}.plugin.bundleSha256`, 64),
  };
  if (!pluginIdPattern.test(plugin.id)) {
    fail(`${label}.plugin.id is invalid.`);
  }
  if (!versionPattern.test(plugin.version)) {
    fail(`${label}.plugin.version is invalid.`);
  }
  if (!sha256Pattern.test(plugin.bundleSha256)) {
    fail(`${label}.plugin.bundleSha256 is invalid.`);
  }
  let repository;
  try {
    repository = new URL(plugin.repository);
  } catch {
    fail(`${label}.plugin.repository is not a URL.`);
  }
  if (repository.protocol !== "https:") {
    fail(`${label}.plugin.repository must use HTTPS.`);
  }
  const threadleafVersion = text(value.threadleafVersion, `${label}.threadleafVersion`, 100);
  if (threadleafVersion !== packageVersion) {
    fail(
      `${label}.threadleafVersion is ${threadleafVersion}, but package.json is ${packageVersion}. Re-run the evidence gates before carrying compatibility claims into a new release.`,
    );
  }
  const lastTested = text(value.lastTested, `${label}.lastTested`, 10);
  if (!datePattern.test(lastTested) || Number.isNaN(Date.parse(`${lastTested}T00:00:00Z`))) {
    fail(`${label}.lastTested is invalid.`);
  }
  if (
    !Number.isInteger(value.compatibilityLevel) ||
    value.compatibilityLevel < 0 ||
    value.compatibilityLevel > 4
  ) {
    fail(`${label}.compatibilityLevel must be an integer from 0 through 4.`);
  }
  const evidenceMode = oneOf(value.evidenceMode, evidenceModes, `${label}.evidenceMode`);
  let level4Evidence;
  if (value.compatibilityLevel === 4) {
    if (evidenceMode !== "production-receipt" || !isRecord(value.level4Receipt)) {
      fail(
        `${label}.compatibilityLevel 4 requires a dedicated production-receipt evidence mode and receipt verifier inputs.`,
      );
    }
    level4Evidence = await validateLevel4Receipt(
      value.level4Receipt,
      `${label}.level4Receipt`,
      plugin,
      packageVersion,
      { reviewedIdentities, allowFixtureOnly },
    );
  } else {
    if (evidenceMode === "production-receipt" || value.level4Receipt !== undefined) {
      fail(
        `${label} carries Level 4 receipt state without an accepted Level 4 compatibility level.`,
      );
    }
  }
  const requiredCapabilities = stringList(
    value.requiredCapabilities,
    `${label}.requiredCapabilities`,
  );
  for (const capability of requiredCapabilities) {
    if (!capabilityIds.has(capability)) {
      fail(`${label}.requiredCapabilities contains unknown capability ${capability}.`);
    }
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
    fail(`${label}.platforms must be a non-empty array.`);
  }
  const platforms = value.platforms.map((platform, platformIndex) => {
    const platformLabel = `${label}.platforms[${platformIndex}]`;
    if (!isRecord(platform)) {
      fail(`${platformLabel} must be an object.`);
    }
    return {
      id: text(platform.id, `${platformLabel}.id`, 100),
      status: oneOf(platform.status, platformStatuses, `${platformLabel}.status`),
      limits: stringList(platform.limits, `${platformLabel}.limits`, { allowEmpty: false }),
    };
  });
  if (new Set(platforms.map(({ id }) => id)).size !== platforms.length) {
    fail(`${label}.platforms contains duplicate identifiers.`);
  }
  if (!Array.isArray(value.workflows) || value.workflows.length === 0) {
    fail(`${label}.workflows must be a non-empty array.`);
  }
  const workflows = [];
  for (const [workflowIndex, workflow] of value.workflows.entries()) {
    const workflowLabel = `${label}.workflows[${workflowIndex}]`;
    if (!isRecord(workflow) || !Array.isArray(workflow.gates) || workflow.gates.length === 0) {
      fail(`${workflowLabel} must be an object with at least one evidence gate.`);
    }
    const gates = [];
    for (const [gateIndex, gate] of workflow.gates.entries()) {
      gates.push(await validateGate(gate, `${workflowLabel}.gates[${gateIndex}]`));
    }
    workflows.push({
      id: text(workflow.id, `${workflowLabel}.id`, 100),
      name: text(workflow.name, `${workflowLabel}.name`, 500),
      status: oneOf(workflow.status, workflowStatuses, `${workflowLabel}.status`),
      gates,
    });
  }
  if (new Set(workflows.map(({ id }) => id)).size !== workflows.length) {
    fail(`${label}.workflows contains duplicate identifiers.`);
  }
  return {
    plugin,
    threadleafVersion,
    lastTested,
    compatibilityLevel: value.compatibilityLevel,
    summary: text(value.summary, `${label}.summary`),
    evidenceMode,
    requiredCapabilities,
    platforms,
    workflows,
    failures: stringList(value.failures, `${label}.failures`),
    limitations: stringList(value.limitations, `${label}.limitations`),
    ...(level4Evidence ? { level4Evidence } : {}),
  };
}

function escapeMarkdown(value) {
  return value.replaceAll("|", "\\|");
}

function markdownFor(registry) {
  const lines = [
    "# Generated plugin compatibility registry",
    "",
    "This document is generated from the versioned receipt-aware source [`compatibility/plugin-evidence.v1.json`](../../compatibility/plugin-evidence.v1.json).",
    "Discovery in the external community package directory is separate from Threadleaf compatibility evidence.",
    "A row applies only to the exact plugin and Threadleaf versions shown.",
    "",
    `Registry schema: ${registry.schemaVersion}. Threadleaf version: ${registry.threadleafVersion}. Generation: ${registry.generationId}.`,
    "",
    "| Plugin | Plugin version | Threadleaf | Level | Evidence | Last tested |",
    "| --- | --- | --- | ---: | --- | --- |",
  ];
  for (const entry of registry.entries) {
    lines.push(
      `| [${escapeMarkdown(entry.plugin.name)}](${entry.plugin.repository}) | ${entry.plugin.version} | ${entry.threadleafVersion} | ${entry.compatibilityLevel} | ${entry.evidenceMode} | ${entry.lastTested} |`,
    );
  }
  for (const entry of registry.entries) {
    lines.push(
      "",
      `## ${entry.plugin.name} ${entry.plugin.version}`,
      "",
      entry.summary,
      "",
      `Bundle SHA-256: \`${entry.plugin.bundleSha256}\`. License: ${entry.plugin.license}.`,
      "",
      `Required static authority review: ${entry.requiredCapabilities.map((capability) => `\`${capability}\``).join(", ") || "none"}.`,
      "",
      "### Supported workflows",
      "",
    );
    for (const workflow of entry.workflows) {
      lines.push(`- **${workflow.name}** (${workflow.status})`);
      for (const gate of workflow.gates) {
        lines.push(`  - \`${gate.command}\` via [${gate.path}](../../${gate.path})`);
      }
    }
    lines.push("", "### Platform limits", "");
    for (const platform of entry.platforms) {
      lines.push(`- **${platform.id}**: ${platform.status}. ${platform.limits.join(" ")}`);
    }
    lines.push("", "### Known failures", "");
    if (entry.failures.length === 0) {
      lines.push("- No reproducible failure is recorded for the supported workflows above.");
    } else {
      lines.push(...entry.failures.map((failure) => `- ${failure}`));
    }
    lines.push("", "### Limitations", "", ...entry.limitations.map((item) => `- ${item}`));
  }
  lines.push(
    "",
    "## Regeneration",
    "",
    "Run `pnpm compatibility:generate` after updating reviewed evidence. `pnpm compatibility:check` validates schema, referenced gate paths, exact Threadleaf version binding, and generated-file drift without using the network.",
    "",
  );
  return lines.join("\n");
}

function typeScriptFor(registry) {
  return `// Generated by scripts/generate-plugin-compatibility-registry.mjs. Do not edit by hand.\nimport authoritativeCompatibilityRegistry from "../../compatibility/registry.v1.json" with { type: "json" };\n\nexport const pluginCompatibilityRegistry = ${JSON.stringify(registry, null, 2)} as const;\nexport const pluginCompatibilityRegistryGenerationId = pluginCompatibilityRegistry.generationId;\nexport const pluginCompatibilityRegistryAuthorityGenerationId = authoritativeCompatibilityRegistry.generationId;\n\nexport function assertPluginCompatibilityRegistryCoherence(): void {\n  if (\n    pluginCompatibilityRegistryGenerationId !== pluginCompatibilityRegistryAuthorityGenerationId ||\n    pluginCompatibilityRegistryGenerationId !== authoritativeCompatibilityRegistry.generationId\n  ) {\n    throw new Error("Generated compatibility registry is not bound to the authoritative registry generation.");\n  }\n}\n\nassertPluginCompatibilityRegistryCoherence();\n\nexport type GeneratedPluginCompatibilityEntry = (typeof pluginCompatibilityRegistry.entries)[number];\n`;
}

async function assertCurrent(filePath, expected) {
  let actual;
  try {
    actual = await fs.readFile(filePath, "utf8");
  } catch (error) {
    fail(
      `${path.relative(rootPath, filePath)} is missing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actual !== expected) {
    fail(`${path.relative(rootPath, filePath)} is stale. Run pnpm compatibility:generate.`);
  }
}

async function syncDirectoryHandle(handle) {
  try {
    await handle.sync();
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error?.code === "EISDIR" || error?.code === "EPERM" || error?.code === "EINVAL")
    ) {
      return;
    }
    throw error;
  }
}

async function writeAtomicReplace(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    let directoryHandle;
    try {
      directoryHandle = await fs.open(path.dirname(filePath), "r");
      await syncDirectoryHandle(directoryHandle);
    } finally {
      await directoryHandle?.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function snapshotOutput(filePath) {
  try {
    return { exists: true, content: await fs.readFile(filePath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: null };
    throw error;
  }
}

async function restoreOutput(filePath, snapshot) {
  if (snapshot.exists) {
    await writeAtomicReplace(filePath, snapshot.content.toString("utf8"));
    return;
  }
  await fs.unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function publishOutputs(
  outputs,
  registryPathForCommit,
  { checkOnly, level4Entries, beforeOutputInstall, beforeAuthorityCommit },
) {
  if (checkOnly) {
    for (const [filePath, content] of outputs) await assertCurrent(filePath, content);
    return;
  }
  const snapshots = new Map();
  for (const [filePath] of outputs) snapshots.set(filePath, await snapshotOutput(filePath));
  const ordered = [...outputs].sort(
    (left, right) =>
      Number(left[0] === registryPathForCommit) - Number(right[0] === registryPathForCommit),
  );
  try {
    for (const [filePath, content] of ordered) {
      if (filePath === registryPathForCommit) {
        await beforeAuthorityCommit?.();
        for (const entry of level4Entries) {
          const currentIdentity = await trustStoreIdentity(
            entry.level4Evidence.config.artifactPaths.trustPolicyPath,
          );
          if (currentIdentity !== entry.level4Evidence.issuerTrustStoreIdentitySha256)
            fail("trust policy rotated or was revoked at the authority commit point.");
        }
      } else {
        await beforeOutputInstall?.({ filePath });
      }
      await writeAtomicReplace(filePath, content);
    }
  } catch (error) {
    for (const filePath of [...outputs.keys()].reverse()) {
      await restoreOutput(filePath, snapshots.get(filePath));
    }
    throw error;
  }
}

export async function generatePluginCompatibilityRegistry({
  checkOnly = process.argv.includes("--check"),
  sourcePathOverride = sourcePath,
  registryPathOverride = registryPath,
  generatedTypeScriptPathOverride = generatedTypeScriptPath,
  generatedMarkdownPathOverride = generatedMarkdownPath,
  beforePublication = undefined,
  beforeOutputInstall = undefined,
  beforeAuthorityCommit = undefined,
  fixtureOnly = false,
} = {}) {
  const packageJson = await readJson(path.join(rootPath, "package.json"), "package.json");
  const source = await readJson(sourcePathOverride, "plugin evidence source");
  const reviewedIdentities = await reviewedAuthorityIdentities();
  if (!isRecord(packageJson) || !versionPattern.test(packageJson.version)) {
    fail("package.json has an invalid version.");
  }
  if (!isRecord(source) || source.schemaVersion !== 2 || !Array.isArray(source.entries)) {
    fail("source must contain schemaVersion 2 and an entries array.");
  }
  if (fixtureOnly) {
    const outputPaths = [
      sourcePathOverride,
      registryPathOverride,
      generatedTypeScriptPathOverride,
      generatedMarkdownPathOverride,
    ];
    if (
      outputPaths.some((filePath) => {
        const relative = path.relative(rootPath, path.resolve(filePath));
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      })
    ) {
      fail("fixture-only registry generation must stay outside the repository.");
    }
  }
  const entries = [];
  for (const [index, entry] of source.entries.entries()) {
    entries.push(
      await validateEntry(entry, index, packageJson.version, reviewedIdentities, fixtureOnly),
    );
  }
  entries.sort((left, right) =>
    `${left.plugin.id}\0${left.plugin.version}`.localeCompare(
      `${right.plugin.id}\0${right.plugin.version}`,
    ),
  );
  const keys = entries.map(
    (entry) => `${entry.plugin.id}@${entry.plugin.version}@${entry.plugin.bundleSha256}`,
  );
  if (new Set(keys).size !== keys.length) {
    fail("source contains duplicate exact plugin identities.");
  }
  const registryBase = {
    schemaVersion: 2,
    generatedBy: "scripts/generate-plugin-compatibility-registry.mjs",
    threadleafVersion: packageJson.version,
    entries: entries.map((entry) => {
      if (!entry.level4Evidence) return entry;
      const { config: _config, ...publicLevel4Evidence } = entry.level4Evidence;
      return { ...entry, level4Evidence: publicLevel4Evidence };
    }),
  };
  const registry = {
    ...registryBase,
    generationId: level4JsonSha256(registryBase),
  };
  const outputs = new Map([
    [generatedTypeScriptPathOverride, typeScriptFor(registry)],
    [generatedMarkdownPathOverride, markdownFor(registry)],
    [registryPathOverride, `${JSON.stringify(registry, null, 2)}\n`],
  ]);
  const level4Entries = entries.filter((entry) => entry.compatibilityLevel === 4);
  if (beforePublication) await beforePublication({ registry, level4Entries });
  for (const [filePath, content] of outputs) {
    if (/[\u2013\u2014]/u.test(content)) {
      fail(`${path.relative(rootPath, filePath)} contains a forbidden dash character.`);
    }
  }
  await publishOutputs(outputs, registryPathOverride, {
    checkOnly,
    level4Entries,
    beforeOutputInstall,
    beforeAuthorityCommit,
  });
  return { registry, entries };
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("generate-plugin-compatibility-registry.mjs")
) {
  const result = await generatePluginCompatibilityRegistry();
  process.stdout.write(
    `${process.argv.includes("--check") ? "Verified" : "Generated"} ${result.entries.length} plugin compatibility entries.\n`,
  );
}
