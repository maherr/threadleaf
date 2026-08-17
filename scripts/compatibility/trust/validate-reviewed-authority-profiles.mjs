import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLevel4Json } from "../../../src/shared/level4-receipt-boundary.mjs";

const trustDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(trustDirectory, "..", "..", "..");
const schemaPath = path.join(trustDirectory, "reviewed-authority-profile.v1.schema.json");
const ambientNodeAuthorities = ["network", "filesystem", "subprocess"];

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(`[reviewed-authority-profiles] ${message}`);
}

async function readJson(filePath) {
  try {
    return parseLevel4Json(await fs.readFile(filePath));
  } catch (error) {
    fail(`cannot read ${path.relative(appRoot, filePath)}: ${error.message}`);
  }
}

async function loadAjv2020() {
  try {
    const hoisted = await import("ajv/dist/2020.js");
    return hoisted.default?.default ?? hoisted.default ?? hoisted.Ajv2020;
  } catch {
    // Strict pnpm layouts do not expose transitive dependencies by bare specifier.
  }
  const storeDirectory = path.join(appRoot, "node_modules", ".pnpm");
  let entries;
  try {
    entries = await fs.readdir(storeDirectory);
  } catch (error) {
    fail(`cannot read the pnpm store to resolve ajv: ${error.message}`);
  }
  const candidate = entries
    .filter((entry) => /^ajv@8\./u.test(entry))
    .sort()
    .at(-1);
  if (candidate === undefined) {
    fail("ajv 8 is not installed; run pnpm install before this check");
  }
  const modulePath = path.join(storeDirectory, candidate, "node_modules", "ajv", "dist", "2020.js");
  const loaded = await import(pathToFileURL(modulePath).href);
  return loaded.default?.default ?? loaded.default ?? loaded.Ajv2020;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    fail("canonical authority JSON does not admit undefined or non-JSON values");
  }
  return serialized;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function authorityPayload(profile) {
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

function checkProfileSemantics(name, profile) {
  const identityDigest = sha256(canonicalJson(profile.packageIdentity));
  if (profile.packageIdentityDigest !== identityDigest) {
    fail(`${name} packageIdentityDigest is stale; expected ${identityDigest}`);
  }
  const authorityDigest = sha256(canonicalJson(authorityPayload(profile)));
  if (profile.authorityDigest !== authorityDigest) {
    fail(`${name} authorityDigest is stale; expected ${authorityDigest}`);
  }
  if (
    profile.expectedStaticCapabilities.some(
      (capability) => !profile.requiredAuthorities.includes(capability),
    )
  ) {
    fail(`${name} requiredAuthorities must include every expected static capability`);
  }
  for (const capability of ambientNodeAuthorities) {
    if (!profile.requiredAuthorities.includes(capability)) {
      fail(`${name} must disclose ambient Node authority ${capability}`);
    }
  }
  if (
    profile.packageIdentity.pluginId === "templater-obsidian" &&
    (!profile.expectedStaticCapabilities.includes("subprocess") ||
      !profile.requiredAuthorities.includes("subprocess") ||
      profile.executionProfile !== "trusted-desktop-escape")
  ) {
    fail("Templater 2.25.0 must retain subprocess in both sets and trusted-desktop-escape");
  }
}

async function main() {
  const profileNames = (await fs.readdir(trustDirectory))
    .filter((name) => name.endsWith(".authority-profile.json"))
    .sort();
  if (profileNames.length === 0) {
    fail("no reviewed authority profiles were discovered");
  }
  const schema = await readJson(schemaPath);
  const Ajv2020 = await loadAjv2020();
  if (typeof Ajv2020 !== "function") {
    fail("resolved ajv does not export a 2020-12 constructor");
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    fail(`the profile schema does not compile: ${error.message}`);
  }

  const profiles = [];
  for (const name of profileNames) {
    const profile = await readJson(path.join(trustDirectory, name));
    if (!validate(profile)) {
      fail(`${name} does not validate against the schema: ${ajv.errorsText(validate.errors)}`);
    }
    checkProfileSemantics(name, profile);
    profiles.push(profile);
  }

  const identities = profiles.map((profile) => profile.packageIdentityDigest);
  const profileIds = profiles.map((profile) => profile.profileId);
  if (
    new Set(identities).size !== identities.length ||
    new Set(profileIds).size !== profileIds.length
  ) {
    fail("profiles must have unique complete package identities and profile IDs");
  }

  const negative = structuredClone(profiles[0]);
  negative.packageIdentity.mainSha256 = "0".repeat(64);
  if (negative.packageIdentityDigest === sha256(canonicalJson(negative.packageIdentity))) {
    fail("digest-mismatch negative control did not become invalid");
  }
  negative.unreviewedAuthority = true;
  if (validate(negative)) {
    fail("schema accepted an unknown authority-bearing field");
  }

  let undefinedRejected = false;
  try {
    canonicalJson({ unexpected: undefined });
  } catch (error) {
    if (!(error instanceof CheckFailure)) {
      throw error;
    }
    undefinedRejected = true;
  }
  if (!undefinedRejected) {
    fail("undefined canonicalization negative control did not reject");
  }

  console.log(
    `reviewed authority profile schema compiled; ${profiles.length} identity-bound profiles and 3 negative controls passed`,
  );
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof CheckFailure
      ? error.message
      : `[reviewed-authority-profiles] unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
  );
}
