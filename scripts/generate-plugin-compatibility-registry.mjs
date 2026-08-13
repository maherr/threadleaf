import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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
const checkOnly = process.argv.includes("--check");
const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const platformStatuses = new Set(["verified", "packaged-only", "unverified"]);
const workflowStatuses = new Set(["passed", "failed", "unsupported"]);
const evidenceModes = new Set(["direct", "composed"]);
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
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
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

async function validateEntry(value, index, packageVersion) {
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
    evidenceMode: oneOf(value.evidenceMode, evidenceModes, `${label}.evidenceMode`),
    requiredCapabilities,
    platforms,
    workflows,
    failures: stringList(value.failures, `${label}.failures`),
    limitations: stringList(value.limitations, `${label}.limitations`),
  };
}

function escapeMarkdown(value) {
  return value.replaceAll("|", "\\|");
}

function markdownFor(registry) {
  const lines = [
    "# Generated plugin compatibility registry",
    "",
    "This document is generated from [`compatibility/plugin-evidence.v1.json`](../../compatibility/plugin-evidence.v1.json).",
    "Discovery in the external community package directory is separate from Threadleaf compatibility evidence.",
    "A row applies only to the exact plugin and Threadleaf versions shown.",
    "",
    `Registry schema: ${registry.schemaVersion}. Threadleaf version: ${registry.threadleafVersion}.`,
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
  return `// Generated by scripts/generate-plugin-compatibility-registry.mjs. Do not edit by hand.\nexport const pluginCompatibilityRegistry = ${JSON.stringify(registry, null, 2)} as const;\n\nexport type GeneratedPluginCompatibilityEntry = (typeof pluginCompatibilityRegistry.entries)[number];\n`;
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

const packageJson = await readJson(path.join(rootPath, "package.json"), "package.json");
const source = await readJson(sourcePath, "plugin evidence source");
if (!isRecord(packageJson) || !versionPattern.test(packageJson.version)) {
  fail("package.json has an invalid version.");
}
if (!isRecord(source) || source.schemaVersion !== 1 || !Array.isArray(source.entries)) {
  fail("source must contain schemaVersion 1 and an entries array.");
}
const entries = [];
for (const [index, entry] of source.entries.entries()) {
  entries.push(await validateEntry(entry, index, packageJson.version));
}
entries.sort((left, right) =>
  `${left.plugin.id}\0${left.plugin.version}`.localeCompare(
    `${right.plugin.id}\0${right.plugin.version}`,
  ),
);
const keys = entries.map((entry) => `${entry.plugin.id}@${entry.plugin.version}`);
if (new Set(keys).size !== keys.length) {
  fail("source contains duplicate plugin and version pairs.");
}
const registry = {
  schemaVersion: 1,
  generatedBy: "scripts/generate-plugin-compatibility-registry.mjs",
  threadleafVersion: packageJson.version,
  entries,
};
const outputs = new Map([
  [registryPath, `${JSON.stringify(registry, null, 2)}\n`],
  [generatedTypeScriptPath, typeScriptFor(registry)],
  [generatedMarkdownPath, markdownFor(registry)],
]);
for (const [filePath, content] of outputs) {
  if (/[\u2013\u2014]/u.test(content)) {
    fail(`${path.relative(rootPath, filePath)} contains a forbidden dash character.`);
  }
  if (checkOnly) {
    await assertCurrent(filePath, content);
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}
process.stdout.write(
  `${checkOnly ? "Verified" : "Generated"} ${entries.length} plugin compatibility entries.\n`,
);
