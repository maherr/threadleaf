import { createHash, sign, verify } from "node:crypto";
import canonicalize from "canonicalize";

export const level4ReceiptSchemaVersion = 2;
export const level4ObservationSchemaVersion = 1;
export const level4ReplaySchemaVersion = 1;
export const level4ReceiptSignatureAlgorithm = "Ed25519";
export const level4ReceiptDomain = "threadleaf-level4-receipt-v2\0";
export const level4AttemptDomain = "threadleaf-level4-attempt-v2\0";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const sha256Pattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const noncePattern = /^[a-f0-9]{64}$/u;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const screenshotArtifactIdPattern = /^sha256:[a-f0-9]{64}$/u;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function fail(message) {
  throw new Error(`Level 4 receipt: ${message}`);
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainRecord(value, label) {
  if (!isPlainRecord(value)) fail(`${label} must be a plain JSON object.`);
  return value;
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains missing or unknown fields.`);
  }
}

function assertOneLine(value, label, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    fail(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !idPattern.test(value)) {
    fail(`${label} is not a valid identifier.`);
  }
  return value;
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertSafeInteger(value, label, { minimum = undefined } = {}) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    fail(`${label} must be a safe integer.`);
  }
  if (minimum !== undefined && value < minimum) fail(`${label} is below its minimum.`);
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    fail(`${label} must be a valid UTC RFC 3339 timestamp.`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail(`${label} must name a real Gregorian UTC calendar instant.`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be boolean.`);
  return value;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertStringList(value, label, { allowEmpty = true, maximum = 256 } = {}) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be a bounded string array.`);
  }
  const result = value.map((item, index) => assertOneLine(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates.`);
  return result;
}

function assertHashOrNull(value, label) {
  if (value !== null) assertSha256(value, label);
  return value;
}

function assertStrictJsonValue(value, label = "value", depth = 0) {
  if (depth > 48) fail(`${label} exceeds the maximum JSON depth.`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && hasLoneSurrogate(value)) {
      fail(`${label} contains a lone surrogate.`);
    }
    return value;
  }
  if (typeof value === "number") {
    assertSafeInteger(value, label);
    return value;
  }
  if (typeof value !== "object") fail(`${label} contains a non-JSON value.`);
  const prototype = Object.getPrototypeOf(value);
  if (
    (Array.isArray(value) && prototype !== Array.prototype) ||
    (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
  ) {
    fail(`${label} has a non-plain object prototype.`);
  }
  if (Object.hasOwn(value, "toJSON")) fail(`${label} contains toJSON.`);
  if (prototype && Object.hasOwn(prototype, "toJSON"))
    fail(`${label} is affected by an inherited toJSON property.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail(`${label} contains a symbol property.`);
  }
  if (Array.isArray(value)) {
    const allowed = new Set(["length"]);
    for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
    for (const key of ownKeys) {
      if (!allowed.has(key)) fail(`${label} contains an extra array property.`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        fail(`${label} contains a sparse array.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        fail(`${label}[${index}] is not a plain data property.`);
      }
      assertStrictJsonValue(value[index], `${label}[${index}]`, depth + 1);
    }
    return value;
  }
  for (const key of ownKeys) {
    if (hasLoneSurrogate(key)) fail(`${label} contains a lone-surrogate property name.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail(`${label}.${key} is not a plain data property.`);
    }
    if (key === "toJSON") fail(`${label} contains toJSON.`);
    assertStrictJsonValue(value[key], `${label}.${key}`, depth + 1);
  }
  return value;
}

class JsonParser {
  #text;
  #index = 0;

  constructor(text) {
    this.#text = text;
  }

  parse() {
    this.#skipWhitespace();
    const value = this.#value("root");
    this.#skipWhitespace();
    if (this.#index !== this.#text.length) fail("raw JSON contains trailing data.");
    return value;
  }

  #peek() {
    return this.#text[this.#index] ?? "";
  }

  #skipWhitespace() {
    while (/[ \t\r\n]/u.test(this.#peek())) this.#index += 1;
  }

  #value(label) {
    const character = this.#peek();
    if (character === "{") return this.#object(label);
    if (character === "[") return this.#array(label);
    if (character === '"') return this.#string(label);
    if (character === "t" && this.#text.slice(this.#index, this.#index + 4) === "true") {
      this.#index += 4;
      return true;
    }
    if (character === "f" && this.#text.slice(this.#index, this.#index + 5) === "false") {
      this.#index += 5;
      return false;
    }
    if (character === "n" && this.#text.slice(this.#index, this.#index + 4) === "null") {
      this.#index += 4;
      return null;
    }
    if (character === "-" || /[0-9]/u.test(character)) return this.#number(label);
    fail(`${label} is not valid JSON at byte ${this.#index}.`);
  }

  #string(label) {
    const start = this.#index;
    this.#index += 1;
    while (this.#index < this.#text.length) {
      const code = this.#text.charCodeAt(this.#index);
      if (code <= 0x1f) fail(`${label} contains an unescaped control character.`);
      if (code === 0x22) {
        this.#index += 1;
        const token = this.#text.slice(start, this.#index);
        let value;
        try {
          value = JSON.parse(token);
        } catch {
          fail(`${label} contains an invalid JSON string.`);
        }
        assertStrictJsonValue(value, label);
        return value;
      }
      if (code === 0x5c) {
        this.#index += 1;
        if (this.#index >= this.#text.length) fail(`${label} has an incomplete escape.`);
        if (this.#text[this.#index] === "u") {
          this.#index += 4;
        }
      }
      this.#index += 1;
    }
    fail(`${label} has an unterminated string.`);
  }

  #number(label) {
    const start = this.#index;
    if (this.#peek() === "-") this.#index += 1;
    if (this.#peek() === "0") {
      this.#index += 1;
      if (/[0-9]/u.test(this.#peek())) fail(`${label} contains a leading zero.`);
    } else if (/[1-9]/u.test(this.#peek())) {
      while (/[0-9]/u.test(this.#peek())) this.#index += 1;
    } else {
      fail(`${label} has an invalid number.`);
    }
    if (this.#peek() === ".") {
      this.#index += 1;
      if (!/[0-9]/u.test(this.#peek())) fail(`${label} has an invalid fractional number.`);
      while (/[0-9]/u.test(this.#peek())) this.#index += 1;
    }
    if (this.#peek() === "e" || this.#peek() === "E") {
      this.#index += 1;
      if (this.#peek() === "+" || this.#peek() === "-") this.#index += 1;
      if (!/[0-9]/u.test(this.#peek())) fail(`${label} has an invalid exponent.`);
      while (/[0-9]/u.test(this.#peek())) this.#index += 1;
    }
    const token = this.#text.slice(start, this.#index);
    if (!/^(?:0|-?[1-9][0-9]*)$/u.test(token)) {
      fail(`${label} contains a float or exponent; receipts allow only integers.`);
    }
    const value = Number(token);
    assertSafeInteger(value, label);
    return value;
  }

  #array(label) {
    this.#index += 1;
    const values = [];
    this.#skipWhitespace();
    if (this.#peek() === "]") {
      this.#index += 1;
      return values;
    }
    while (true) {
      values.push(this.#value(`${label}[${values.length}]`));
      this.#skipWhitespace();
      if (this.#peek() === "]") {
        this.#index += 1;
        return values;
      }
      if (this.#peek() !== ",") fail(`${label} is missing a comma.`);
      this.#index += 1;
      this.#skipWhitespace();
    }
  }

  #object(label) {
    this.#index += 1;
    const record = Object.create(null);
    const keys = new Set();
    this.#skipWhitespace();
    if (this.#peek() === "}") {
      this.#index += 1;
      return record;
    }
    while (true) {
      if (this.#peek() !== '"') fail(`${label} has a non-string object key.`);
      const key = this.#string(`${label} key`);
      if (keys.has(key)) fail(`${label} contains a duplicate textual key ${JSON.stringify(key)}.`);
      keys.add(key);
      this.#skipWhitespace();
      if (this.#peek() !== ":") fail(`${label}.${key} is missing a colon.`);
      this.#index += 1;
      this.#skipWhitespace();
      record[key] = this.#value(`${label}.${key}`);
      this.#skipWhitespace();
      if (this.#peek() === "}") {
        this.#index += 1;
        return record;
      }
      if (this.#peek() !== ",") fail(`${label} is missing a comma.`);
      this.#index += 1;
      this.#skipWhitespace();
    }
  }
}

export function parseLevel4Json(value, { requireCanonical = false } = {}) {
  if (typeof value === "string" && hasLoneSurrogate(value))
    fail("JSON text contains a lone surrogate.");
  if (typeof value !== "string" && !(value instanceof Uint8Array))
    fail("JSON input must be a string or Uint8Array.");
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  let text;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    fail("JSON bytes are not valid UTF-8.");
  }
  const parsed = new JsonParser(text).parse();
  assertStrictJsonValue(parsed);
  if (requireCanonical) {
    const canonical = canonicalizeLevel4Json(parsed);
    if (!Buffer.from(canonical).equals(Buffer.from(bytes))) {
      fail("raw JSON bytes are not the exact RFC 8785 canonical bytes.");
    }
  }
  return parsed;
}

export function canonicalizeLevel4Json(value) {
  assertStrictJsonValue(value);
  let serialized;
  try {
    serialized = canonicalize(value);
  } catch (error) {
    fail(
      `RFC 8785 canonicalization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof serialized !== "string") fail("RFC 8785 canonicalization returned no JSON.");
  return textEncoder.encode(serialized);
}

export function level4JsonSha256(value) {
  return createHash("sha256").update(canonicalizeLevel4Json(value)).digest("hex");
}

function assertStringEnum(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) fail(`${label} is unsupported.`);
  return value;
}

function parsePackageIdentity(value, label = "packageIdentity") {
  const record = assertPlainRecord(value, label);
  assertExactKeys(
    record,
    [
      "pluginId",
      "manifestVersion",
      "distributionTag",
      "manifestSha256",
      "mainSha256",
      "stylesSha256",
      "packageTreeSha256",
    ],
    label,
  );
  assertIdentifier(record.pluginId, `${label}.pluginId`);
  assertOneLine(record.manifestVersion, `${label}.manifestVersion`, 100);
  assertOneLine(record.distributionTag, `${label}.distributionTag`, 100);
  assertSha256(record.manifestSha256, `${label}.manifestSha256`);
  assertSha256(record.mainSha256, `${label}.mainSha256`);
  assertHashOrNull(record.stylesSha256, `${label}.stylesSha256`);
  assertSha256(record.packageTreeSha256, `${label}.packageTreeSha256`);
  return {
    pluginId: record.pluginId,
    manifestVersion: record.manifestVersion,
    distributionTag: record.distributionTag,
    manifestSha256: record.manifestSha256,
    mainSha256: record.mainSha256,
    stylesSha256: record.stylesSha256,
    packageTreeSha256: record.packageTreeSha256,
  };
}

function parseObservation(value, label = "observation") {
  const record = assertPlainRecord(value, label);
  assertExactKeys(
    record,
    ["schemaVersion", "runId", "runNonce", "sequence", "kind", "source", "value", "observedAt"],
    label,
  );
  if (record.schemaVersion !== 1) fail(`${label}.schemaVersion is unsupported.`);
  if (typeof record.runId !== "string" || !runIdPattern.test(record.runId))
    fail(`${label}.runId is invalid.`);
  if (typeof record.runNonce !== "string" || !noncePattern.test(record.runNonce))
    fail(`${label}.runNonce is invalid.`);
  assertSafeInteger(record.sequence, `${label}.sequence`, { minimum: 1 });
  assertStringEnum(record.kind, ["probe", "step", "renderer", "host"], `${label}.kind`);
  assertOneLine(record.source, `${label}.source`);
  assertStrictJsonValue(record.value, `${label}.value`);
  assertTimestamp(record.observedAt, `${label}.observedAt`);
  return record;
}

export function parseLevel4RuntimeObservationV1(value) {
  assertStrictJsonValue(value, "observation");
  return parseObservation(value);
}

function parseEpoch(value, label) {
  const record = assertPlainRecord(value, label);
  assertExactKeys(
    record,
    [
      "checkpoint",
      "policyEpoch",
      "grantEpoch",
      "grantRevision",
      "safeModeEpoch",
      "packageStoreEpoch",
      "authorityProfileRevision",
    ],
    label,
  );
  assertOneLine(record.checkpoint, `${label}.checkpoint`);
  for (const key of [
    "policyEpoch",
    "grantEpoch",
    "grantRevision",
    "safeModeEpoch",
    "packageStoreEpoch",
    "authorityProfileRevision",
  ]) {
    assertSafeInteger(record[key], `${label}.${key}`, { minimum: 0 });
  }
  return record;
}

function parseAssertion(value, label) {
  const record = assertPlainRecord(value, label);
  assertExactKeys(
    record,
    ["id", "required", "passed", "observedValue", "source", "evidenceSha256"],
    label,
  );
  assertIdentifier(record.id, `${label}.id`);
  assertBoolean(record.required, `${label}.required`);
  assertBoolean(record.passed, `${label}.passed`);
  assertStrictJsonValue(record.observedValue, `${label}.observedValue`);
  assertOneLine(record.source, `${label}.source`);
  assertHashOrNull(record.evidenceSha256, `${label}.evidenceSha256`);
  return record;
}

function parseAssertions(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    fail(`${label} must contain bounded assertions.`);
  }
  const result = value.map((item, index) => parseAssertion(item, `${label}[${index}]`));
  if (new Set(result.map((item) => item.id)).size !== result.length)
    fail(`${label} contains duplicate IDs.`);
  return result;
}

function parseDeliveryAssertions(value, label) {
  if (!Array.isArray(value) || value.length > 128) fail(`${label} must be a bounded array.`);
  const result = value.map((item, index) => {
    const record = assertPlainRecord(item, `${label}[${index}]`);
    assertExactKeys(record, ["id", "required", "available", "detail"], `${label}[${index}]`);
    assertIdentifier(record.id, `${label}[${index}].id`);
    assertBoolean(record.required, `${label}[${index}].required`);
    assertBoolean(record.available, `${label}[${index}].available`);
    assertOneLine(record.detail, `${label}[${index}].detail`, 2_000);
    return record;
  });
  if (new Set(result.map((item) => item.id)).size !== result.length)
    fail(`${label} contains duplicate IDs.`);
  if (result.some((item) => item.required && !item.available))
    fail(`${label} has unavailable required delivery.`);
  return result;
}

function parseVaultChanges(value, label) {
  if (!Array.isArray(value) || value.length > 2_048) fail(`${label} must be a bounded array.`);
  return value.map((item, index) => {
    const record = assertPlainRecord(item, `${label}[${index}]`);
    assertExactKeys(record, ["path", "kind", "beforeSha256", "afterSha256"], `${label}[${index}]`);
    assertOneLine(record.path, `${label}[${index}].path`, 1_024);
    assertStringEnum(
      record.kind,
      ["created", "modified", "deleted", "renamed"],
      `${label}[${index}].kind`,
    );
    assertHashOrNull(record.beforeSha256, `${label}[${index}].beforeSha256`);
    assertHashOrNull(record.afterSha256, `${label}[${index}].afterSha256`);
    return record;
  });
}

function parseScreenshots(value, label) {
  if (!Array.isArray(value) || value.length > 256) fail(`${label} must be a bounded array.`);
  return value.map((item, index) => {
    const record = assertPlainRecord(item, `${label}[${index}]`);
    assertExactKeys(record, ["artifactId", "purpose", "sha256"], `${label}[${index}]`);
    if (
      typeof record.artifactId !== "string" ||
      !screenshotArtifactIdPattern.test(record.artifactId)
    )
      fail(`${label}[${index}].artifactId is not a portable content-addressed identifier.`);
    assertOneLine(record.purpose, `${label}[${index}].purpose`, 512);
    assertSha256(record.sha256, `${label}[${index}].sha256`);
    return record;
  });
}

export function parseLevel4ReceiptPayloadV2(value) {
  assertStrictJsonValue(value, "receipt payload");
  const record = assertPlainRecord(value, "receipt payload");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "workflowId",
      "workflowDefinitionSha256",
      "fixtureVersion",
      "fixtureTreeSha256",
      "runId",
      "runNonce",
      "packageIdentity",
      "packageIdentityDigest",
      "stagedPackageTreeSha256",
      "authorityProfileId",
      "authorityDigest",
      "constructionPolicyEpochs",
      "threadleafVersion",
      "sourceCommit",
      "packagedApplicationArtifactSha256",
      "installedApplicationTreeSha256",
      "canonicalBuildManifestSha256",
      "relevantDistTreeSha256",
      "electronExecutableSha256",
      "effectiveBuildIdentityDigest",
      "controllerVersion",
      "controllerExecutableSha256",
      "trustedExecutableClosureSha256",
      "trustedControllerManifestId",
      "trustedControllerManifestSha256",
      "evidenceHarnessVersion",
      "evidenceHarnessTreeSha256",
      "issuerKeyId",
      "issuerKeyIdentitySha256",
      "issuerTrustStoreVersion",
      "issuerTrustStoreIdentitySha256",
      "preconditionsSha256",
      "startingFixtureSha256",
      "observations",
      "terminalState",
      "assertions",
      "deliveryAssertions",
      "allowlistedVaultChanges",
      "vaultTreeBeforeSha256",
      "vaultTreeAfterSha256",
      "privateStateNamespaces",
      "rendererIdentityBeforeReload",
      "rendererIdentityAfterReload",
      "postReloadAssertions",
      "cancelControl",
      "errors",
      "screenshots",
      "platform",
      "architecture",
      "electronVersion",
    ],
    "receipt payload",
  );
  if (record.schemaVersion !== 2) fail("receipt payload schemaVersion is unsupported.");
  assertIdentifier(record.workflowId, "payload.workflowId");
  for (const key of [
    "workflowDefinitionSha256",
    "fixtureTreeSha256",
    "packageIdentityDigest",
    "stagedPackageTreeSha256",
    "authorityDigest",
    "packagedApplicationArtifactSha256",
    "installedApplicationTreeSha256",
    "canonicalBuildManifestSha256",
    "relevantDistTreeSha256",
    "electronExecutableSha256",
    "effectiveBuildIdentityDigest",
    "controllerExecutableSha256",
    "trustedExecutableClosureSha256",
    "trustedControllerManifestSha256",
    "evidenceHarnessTreeSha256",
    "issuerKeyIdentitySha256",
    "issuerTrustStoreIdentitySha256",
    "preconditionsSha256",
    "startingFixtureSha256",
    "vaultTreeBeforeSha256",
    "vaultTreeAfterSha256",
  ])
    assertSha256(record[key], `payload.${key}`);
  assertOneLine(record.fixtureVersion, "payload.fixtureVersion", 100);
  if (typeof record.runId !== "string" || !runIdPattern.test(record.runId))
    fail("payload.runId is invalid.");
  if (typeof record.runNonce !== "string" || !noncePattern.test(record.runNonce))
    fail("payload.runNonce is invalid.");
  const packageIdentity = parsePackageIdentity(record.packageIdentity);
  if (record.packageIdentityDigest !== level4JsonSha256(packageIdentity))
    fail("payload.packageIdentityDigest is stale.");
  assertOneLine(record.authorityProfileId, "payload.authorityProfileId", 256);
  if (
    !Array.isArray(record.constructionPolicyEpochs) ||
    record.constructionPolicyEpochs.length === 0
  )
    fail("payload.constructionPolicyEpochs is empty.");
  const epochs = record.constructionPolicyEpochs.map((item, index) =>
    parseEpoch(item, `payload.constructionPolicyEpochs[${index}]`),
  );
  assertOneLine(record.threadleafVersion, "payload.threadleafVersion", 100);
  assertOneLine(record.sourceCommit, "payload.sourceCommit", 128);
  assertOneLine(record.controllerVersion, "payload.controllerVersion", 100);
  assertIdentifier(record.trustedControllerManifestId, "payload.trustedControllerManifestId");
  assertOneLine(record.evidenceHarnessVersion, "payload.evidenceHarnessVersion", 100);
  assertIdentifier(record.issuerKeyId, "payload.issuerKeyId");
  assertSafeInteger(record.issuerTrustStoreVersion, "payload.issuerTrustStoreVersion", {
    minimum: 1,
  });
  assertOneLine(record.platform, "payload.platform", 100);
  assertOneLine(record.architecture, "payload.architecture", 100);
  assertOneLine(record.electronVersion, "payload.electronVersion", 100);
  if (
    !Array.isArray(record.observations) ||
    record.observations.length === 0 ||
    record.observations.length > 2_048
  )
    fail("payload.observations is not bounded.");
  const observations = record.observations.map((item, index) =>
    parseObservation(item, `payload.observations[${index}]`),
  );
  if (observations.some((item) => item.runId !== record.runId || item.runNonce !== record.runNonce))
    fail("payload observations are not bound to this run.");
  if (observations[0].sequence !== 1)
    fail("payload observations cannot fast-forward the sequence.");
  for (let index = 1; index < observations.length; index += 1) {
    if (observations[index].sequence !== observations[index - 1].sequence + 1)
      fail("payload observations are not contiguous.");
  }
  if (record.terminalState !== "completed")
    fail("only completed payloads are publishable receipts.");
  const assertions = parseAssertions(record.assertions, "payload.assertions");
  if (assertions.some((item) => item.required && !item.passed))
    fail("a required assertion did not pass.");
  const deliveryAssertions = parseDeliveryAssertions(
    record.deliveryAssertions,
    "payload.deliveryAssertions",
  );
  const allowlistedVaultChanges = parseVaultChanges(
    record.allowlistedVaultChanges,
    "payload.allowlistedVaultChanges",
  );
  const privateStateNamespaces = assertStringList(
    record.privateStateNamespaces,
    "payload.privateStateNamespaces",
    { maximum: 128 },
  );
  assertOneLine(record.rendererIdentityBeforeReload, "payload.rendererIdentityBeforeReload", 256);
  assertOneLine(record.rendererIdentityAfterReload, "payload.rendererIdentityAfterReload", 256);
  if (record.rendererIdentityBeforeReload === record.rendererIdentityAfterReload)
    fail("renderer identity did not change across reload.");
  const postReloadAssertions = parseAssertions(
    record.postReloadAssertions,
    "payload.postReloadAssertions",
  );
  if (postReloadAssertions.some((item) => item.required && !item.passed))
    fail("a required post-reload assertion did not pass.");
  const cancelControl = assertPlainRecord(record.cancelControl, "payload.cancelControl");
  assertExactKeys(
    cancelControl,
    ["stepId", "result", "provesNoCompletion", "evidenceSha256"],
    "payload.cancelControl",
  );
  assertIdentifier(cancelControl.stepId, "payload.cancelControl.stepId");
  if (cancelControl.result !== "canceled" || cancelControl.provesNoCompletion !== true)
    fail("payload cancel control is not a passing negative control.");
  assertHashOrNull(cancelControl.evidenceSha256, "payload.cancelControl.evidenceSha256");
  if (!Array.isArray(record.errors) || record.errors.length > 0)
    fail("completed payload contains errors.");
  const errors = [];
  if (!Array.isArray(record.screenshots) || record.screenshots.length > 256)
    fail("payload.screenshots is not bounded.");
  const screenshots = parseScreenshots(record.screenshots, "payload.screenshots");
  return {
    ...record,
    packageIdentity,
    constructionPolicyEpochs: epochs,
    observations,
    assertions,
    deliveryAssertions,
    allowlistedVaultChanges,
    privateStateNamespaces,
    postReloadAssertions,
    cancelControl,
    errors,
    screenshots,
  };
}

function parseIssuer(value, label = "issuer") {
  const record = assertPlainRecord(value, label);
  assertExactKeys(
    record,
    [
      "keyId",
      "keyIdentitySha256",
      "controllerVersion",
      "controllerExecutableSha256",
      "trustedExecutableClosureSha256",
      "trustedControllerManifestSha256",
      "issuerTrustStoreIdentitySha256",
    ],
    label,
  );
  assertIdentifier(record.keyId, `${label}.keyId`);
  assertSha256(record.keyIdentitySha256, `${label}.keyIdentitySha256`);
  assertOneLine(record.controllerVersion, `${label}.controllerVersion`, 100);
  assertSha256(record.controllerExecutableSha256, `${label}.controllerExecutableSha256`);
  assertSha256(record.trustedExecutableClosureSha256, `${label}.trustedExecutableClosureSha256`);
  assertSha256(record.trustedControllerManifestSha256, `${label}.trustedControllerManifestSha256`);
  assertSha256(record.issuerTrustStoreIdentitySha256, `${label}.issuerTrustStoreIdentitySha256`);
  return record;
}

function parseSignature(value, label = "signature") {
  const signature = assertPlainRecord(value, label);
  assertExactKeys(signature, ["algorithm", "valueBase64"], label);
  if (signature.algorithm !== "Ed25519") fail(`${label} algorithm is unsupported.`);
  if (typeof signature.valueBase64 !== "string" || !base64Pattern.test(signature.valueBase64))
    fail(`${label} is not canonical base64.`);
  const signatureBytes = Buffer.from(signature.valueBase64, "base64");
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64") !== signature.valueBase64)
    fail(`${label} is not a 64-byte canonical Ed25519 signature.`);
  return { algorithm: "Ed25519", valueBase64: signature.valueBase64 };
}

export function level4ReceiptUnsignedEnvelope(envelope) {
  return {
    schemaVersion: 2,
    payload: envelope.payload,
    payloadSha256: envelope.payloadSha256,
    issuer: envelope.issuer,
  };
}

export function level4ReceiptSigningPreimage(envelope) {
  const unsigned = level4ReceiptUnsignedEnvelope(envelope);
  return Buffer.concat([
    Buffer.from(level4ReceiptDomain, "utf8"),
    Buffer.from(canonicalizeLevel4Json(unsigned)),
  ]);
}

export function parseLevel4ReceiptEnvelopeV2(value) {
  assertStrictJsonValue(value, "receipt envelope");
  const record = assertPlainRecord(value, "receipt envelope");
  assertExactKeys(
    record,
    ["schemaVersion", "payload", "payloadSha256", "issuer", "signature"],
    "receipt envelope",
  );
  if (record.schemaVersion !== 2) fail("receipt envelope schemaVersion is unsupported.");
  const payload = parseLevel4ReceiptPayloadV2(record.payload);
  assertSha256(record.payloadSha256, "receipt.payloadSha256");
  if (record.payloadSha256 !== level4JsonSha256(payload)) fail("receipt.payloadSha256 is stale.");
  const issuer = parseIssuer(record.issuer);
  const signature = parseSignature(record.signature, "receipt.signature");
  if (
    payload.issuerKeyId !== issuer.keyId ||
    payload.issuerKeyIdentitySha256 !== issuer.keyIdentitySha256 ||
    payload.controllerVersion !== issuer.controllerVersion ||
    payload.controllerExecutableSha256 !== issuer.controllerExecutableSha256 ||
    payload.trustedExecutableClosureSha256 !== issuer.trustedExecutableClosureSha256 ||
    payload.trustedControllerManifestSha256 !== issuer.trustedControllerManifestSha256 ||
    payload.issuerTrustStoreIdentitySha256 !== issuer.issuerTrustStoreIdentitySha256
  )
    fail("duplicated issuer identities do not match.");
  assertStrictJsonValue(record);
  return {
    schemaVersion: 2,
    payload,
    payloadSha256: record.payloadSha256,
    issuer,
    signature,
  };
}

export function createLevel4ReceiptEnvelopeV2({ payload, issuer, privateKey }) {
  const normalizedPayload = parseLevel4ReceiptPayloadV2(payload);
  const normalizedIssuer = parseIssuer(issuer);
  const unsigned = {
    schemaVersion: 2,
    payload: normalizedPayload,
    payloadSha256: level4JsonSha256(normalizedPayload),
    issuer: normalizedIssuer,
  };
  const signature = sign(null, level4ReceiptSigningPreimage(unsigned), privateKey).toString(
    "base64",
  );
  return parseLevel4ReceiptEnvelopeV2({
    ...unsigned,
    signature: { algorithm: "Ed25519", valueBase64: signature },
  });
}

export function verifyLevel4ReceiptSignature(envelope, publicKey) {
  const normalized = parseLevel4ReceiptEnvelopeV2(envelope);
  return verify(
    null,
    level4ReceiptSigningPreimage(normalized),
    publicKey,
    Buffer.from(normalized.signature.valueBase64, "base64"),
  );
}

function parseControllerManifestShape(value, label) {
  const record = assertPlainRecord(value, label);
  assertExactKeys(
    record,
    [
      "manifestId",
      "manifestVersion",
      "controllerVersion",
      "controllerExecutableSha256",
      "executableClosureSha256",
      "executableClosure",
      "allowedReceiptSchemaVersions",
      "currentHarness",
    ],
    label,
  );
  assertIdentifier(record.manifestId, `${label}.manifestId`);
  assertSafeInteger(record.manifestVersion, `${label}.manifestVersion`, { minimum: 1 });
  assertOneLine(record.controllerVersion, `${label}.controllerVersion`, 100);
  assertSha256(record.controllerExecutableSha256, `${label}.controllerExecutableSha256`);
  assertSha256(record.executableClosureSha256, `${label}.executableClosureSha256`);
  const closure = assertPlainRecord(record.executableClosure, `${label}.executableClosure`);
  assertExactKeys(closure, ["schemaVersion", "roots", "entries"], `${label}.executableClosure`);
  if (closure.schemaVersion !== 1) fail(`${label}.executableClosure.schemaVersion is unsupported.`);
  if (
    JSON.stringify(closure.roots) !==
    JSON.stringify([
      "scripts/compatibility/level4-controller.mjs",
      "scripts/compatibility/level4-verifier.mjs",
    ])
  )
    fail(`${label}.executableClosure.roots are not the trusted controller and verifier roots.`);
  if (
    !Array.isArray(closure.entries) ||
    closure.entries.length === 0 ||
    closure.entries.length > 256
  )
    fail(`${label}.executableClosure.entries is not bounded.`);
  const closureEntries = closure.entries.map((item, index) => {
    const entry = assertPlainRecord(item, `${label}.executableClosure.entries[${index}]`);
    assertExactKeys(
      entry,
      ["path", "bytes", "sha256"],
      `${label}.executableClosure.entries[${index}]`,
    );
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path.includes("\\") ||
      entry.path.startsWith("/") ||
      entry.path.normalize("NFC") !== entry.path ||
      entry.path.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    )
      fail(`${label}.executableClosure.entries[${index}].path is not portable.`);
    assertSafeInteger(entry.bytes, `${label}.executableClosure.entries[${index}].bytes`, {
      minimum: 0,
    });
    assertSha256(entry.sha256, `${label}.executableClosure.entries[${index}].sha256`);
    return entry;
  });
  const sortedPaths = closureEntries.map((entry) => entry.path).sort();
  if (
    new Set(sortedPaths).size !== sortedPaths.length ||
    JSON.stringify(sortedPaths) !== JSON.stringify(closureEntries.map((entry) => entry.path))
  )
    fail(`${label}.executableClosure.entries must be unique and deterministically sorted.`);
  const normalizedClosure = {
    schemaVersion: 1,
    roots: [...closure.roots],
    entries: closureEntries,
  };
  if (level4JsonSha256(normalizedClosure) !== record.executableClosureSha256)
    fail(`${label}.executableClosureSha256 is stale.`);
  if (JSON.stringify(record.allowedReceiptSchemaVersions) !== "[2]")
    fail(`${label}.allowedReceiptSchemaVersions must be [2].`);
  const harness = assertPlainRecord(record.currentHarness, `${label}.currentHarness`);
  assertExactKeys(harness, ["version", "treeSha256"], `${label}.currentHarness`);
  assertOneLine(harness.version, `${label}.currentHarness.version`, 100);
  assertSha256(harness.treeSha256, `${label}.currentHarness.treeSha256`);
  return { ...record, executableClosure: normalizedClosure, currentHarness: harness };
}

export function parseLevel4TrustedControllerManifestV1(value) {
  assertStrictJsonValue(value, "trusted controller manifest");
  return parseControllerManifestShape(value, "trusted controller manifest");
}

export function parseLevel4TrustPolicyV1(value) {
  assertStrictJsonValue(value, "trust policy");
  const record = assertPlainRecord(value, "trust policy");
  assertExactKeys(
    record,
    ["schemaVersion", "trustStoreVersion", "trustedControllerManifest", "issuerKeys"],
    "trust policy",
  );
  if (record.schemaVersion !== 1) fail("trust policy schemaVersion is unsupported.");
  assertSafeInteger(record.trustStoreVersion, "trust policy.trustStoreVersion", { minimum: 1 });
  const trustedControllerManifest = parseControllerManifestShape(
    record.trustedControllerManifest,
    "trust policy.trustedControllerManifest",
  );
  if (!Array.isArray(record.issuerKeys) || record.issuerKeys.length > 128)
    fail("trust policy issuerKeys is not bounded.");
  const issuerKeys = record.issuerKeys.map((item, index) => {
    const key = assertPlainRecord(item, `trust policy.issuerKeys[${index}]`);
    assertExactKeys(
      key,
      ["keyId", "publicKeyBase64", "keyIdentitySha256", "status"],
      `trust policy.issuerKeys[${index}]`,
    );
    assertIdentifier(key.keyId, `trust policy.issuerKeys[${index}].keyId`);
    if (typeof key.publicKeyBase64 !== "string" || !base64Pattern.test(key.publicKeyBase64))
      fail(`trust policy.issuerKeys[${index}].publicKeyBase64 is not canonical base64.`);
    const bytes = Buffer.from(key.publicKeyBase64, "base64");
    if (bytes.length !== 44 || bytes.toString("base64") !== key.publicKeyBase64)
      fail(`trust policy.issuerKeys[${index}].publicKeyBase64 is not canonical Ed25519 SPKI.`);
    assertSha256(key.keyIdentitySha256, `trust policy.issuerKeys[${index}].keyIdentitySha256`);
    if (key.keyIdentitySha256 !== createHash("sha256").update(bytes).digest("hex"))
      fail(`trust policy.issuerKeys[${index}] key identity is stale.`);
    assertStringEnum(key.status, ["active", "revoked"], `trust policy.issuerKeys[${index}].status`);
    return key;
  });
  if (new Set(issuerKeys.map((key) => key.keyId)).size !== issuerKeys.length)
    fail("trust policy issuer key IDs are duplicated.");
  return {
    schemaVersion: 1,
    trustStoreVersion: record.trustStoreVersion,
    trustedControllerManifest,
    issuerKeys,
  };
}

export function parseLevel4WorkflowDefinitionV2(value) {
  assertStrictJsonValue(value, "workflow definition");
  const record = assertPlainRecord(value, "workflow definition");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "workflowId",
      "version",
      "pluginId",
      "packageIdentityDigest",
      "platform",
      "architecture",
      "requiredAssertionIds",
      "requiredPostReloadAssertionIds",
      "requiredDeliveryIds",
      "cancellationStepId",
      "fixtureVersion",
    ],
    "workflow definition",
  );
  if (record.schemaVersion !== 2) fail("workflow definition schemaVersion is unsupported.");
  assertIdentifier(record.workflowId, "workflow.workflowId");
  assertOneLine(record.version, "workflow.version", 100);
  assertIdentifier(record.pluginId, "workflow.pluginId");
  assertSha256(record.packageIdentityDigest, "workflow.packageIdentityDigest");
  assertOneLine(record.platform, "workflow.platform", 100);
  assertOneLine(record.architecture, "workflow.architecture", 100);
  const requiredAssertionIds = assertStringList(
    record.requiredAssertionIds,
    "workflow.requiredAssertionIds",
    { allowEmpty: false },
  );
  const requiredPostReloadAssertionIds = assertStringList(
    record.requiredPostReloadAssertionIds,
    "workflow.requiredPostReloadAssertionIds",
    { allowEmpty: false },
  );
  const requiredDeliveryIds = assertStringList(
    record.requiredDeliveryIds,
    "workflow.requiredDeliveryIds",
  );
  assertIdentifier(record.cancellationStepId, "workflow.cancellationStepId");
  assertOneLine(record.fixtureVersion, "workflow.fixtureVersion", 100);
  return { ...record, requiredAssertionIds, requiredPostReloadAssertionIds, requiredDeliveryIds };
}

export function parseLevel4VerificationTupleV2(value) {
  assertStrictJsonValue(value, "verification tuple");
  const record = assertPlainRecord(value, "verification tuple");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "effectiveBuildIdentityDigest",
      "packageIdentityDigest",
      "authorityDigest",
      "workflowDefinitionSha256",
      "fixtureTreeSha256",
      "platform",
      "architecture",
      "controllerExecutableSha256",
      "trustedExecutableClosureSha256",
      "trustedControllerManifestSha256",
      "evidenceHarnessVersion",
      "evidenceHarnessTreeSha256",
      "issuerKeyIdentitySha256",
      "issuerTrustStoreVersion",
      "issuerTrustStoreIdentitySha256",
    ],
    "verification tuple",
  );
  if (record.schemaVersion !== 2) fail("verification tuple schemaVersion is unsupported.");
  for (const key of [
    "effectiveBuildIdentityDigest",
    "packageIdentityDigest",
    "authorityDigest",
    "workflowDefinitionSha256",
    "fixtureTreeSha256",
    "controllerExecutableSha256",
    "trustedExecutableClosureSha256",
    "trustedControllerManifestSha256",
    "evidenceHarnessTreeSha256",
    "issuerKeyIdentitySha256",
    "issuerTrustStoreIdentitySha256",
  ])
    assertSha256(record[key], `tuple.${key}`);
  assertOneLine(record.platform, "tuple.platform", 100);
  assertOneLine(record.architecture, "tuple.architecture", 100);
  assertOneLine(record.evidenceHarnessVersion, "tuple.evidenceHarnessVersion", 100);
  assertSafeInteger(record.issuerTrustStoreVersion, "tuple.issuerTrustStoreVersion", {
    minimum: 1,
  });
  return record;
}

export function parseLevel4ReplayEntryV1(value) {
  assertStrictJsonValue(value, "replay entry");
  const record = assertPlainRecord(value, "replay entry");
  assertExactKeys(
    record,
    ["schemaVersion", "tupleDigest", "runNonce", "runId", "receiptFileSha256"],
    "replay entry",
  );
  if (record.schemaVersion !== 1) fail("replay entry schemaVersion is unsupported.");
  assertSha256(record.tupleDigest, "replay.tupleDigest");
  if (typeof record.runNonce !== "string" || !noncePattern.test(record.runNonce))
    fail("replay.runNonce is invalid.");
  if (typeof record.runId !== "string" || !runIdPattern.test(record.runId))
    fail("replay.runId is invalid.");
  assertSha256(record.receiptFileSha256, "replay.receiptFileSha256");
  return record;
}

const attemptRecordKeys = [
  "schemaVersion",
  "runId",
  "runNonce",
  "workflowId",
  "terminalState",
  "publishable",
  "failureReason",
  "observedAt",
  "observations",
  "issuer",
];

function parseAttemptUnsigned(value) {
  const record = assertPlainRecord(value, "controller attempt record");
  assertExactKeys(record, attemptRecordKeys, "controller attempt record");
  if (record.schemaVersion !== 2 || record.publishable !== false)
    fail("controller attempt record is invalid.");
  if (typeof record.runId !== "string" || !runIdPattern.test(record.runId))
    fail("attempt.runId is invalid.");
  if (typeof record.runNonce !== "string" || !noncePattern.test(record.runNonce))
    fail("attempt.runNonce is invalid.");
  assertIdentifier(record.workflowId, "attempt.workflowId");
  assertStringEnum(
    record.terminalState,
    ["canceled", "failed", "timed-out"],
    "attempt.terminalState",
  );
  assertOneLine(record.failureReason, "attempt.failureReason", 2_000);
  assertTimestamp(record.observedAt, "attempt.observedAt");
  if (!Array.isArray(record.observations) || record.observations.length > 2_048)
    fail("attempt.observations is not bounded.");
  const observations = record.observations.map((item, index) =>
    parseObservation(item, `attempt.observations[${index}]`),
  );
  if (observations.some((item) => item.runId !== record.runId || item.runNonce !== record.runNonce))
    fail("attempt observations are not bound to the attempt.");
  return { ...record, observations, issuer: parseIssuer(record.issuer, "attempt.issuer") };
}

export function parseLevel4ControllerAttemptRecordV2(value) {
  assertStrictJsonValue(value, "controller attempt record");
  const record = assertPlainRecord(value, "controller attempt record");
  assertExactKeys(record, [...attemptRecordKeys, "signature"], "controller attempt record");
  const { signature, ...unsigned } = record;
  return {
    ...parseAttemptUnsigned(unsigned),
    signature: parseSignature(signature, "attempt.signature"),
  };
}

export function level4ControllerAttemptSigningPreimage(record) {
  const unsigned = parseAttemptUnsigned(record);
  return Buffer.concat([
    Buffer.from(level4AttemptDomain, "utf8"),
    Buffer.from(canonicalizeLevel4Json(unsigned)),
  ]);
}

export function createLevel4ControllerAttemptRecordV2({ record, privateKey }) {
  const unsigned = parseAttemptUnsigned(record);
  const valueBase64 = sign(
    null,
    level4ControllerAttemptSigningPreimage(unsigned),
    privateKey,
  ).toString("base64");
  return parseLevel4ControllerAttemptRecordV2({
    ...unsigned,
    signature: { algorithm: "Ed25519", valueBase64 },
  });
}

export function verifyLevel4ControllerAttemptRecordSignature(record, publicKey) {
  const normalized = parseLevel4ControllerAttemptRecordV2(record);
  const { signature, ...unsigned } = normalized;
  return verify(
    null,
    level4ControllerAttemptSigningPreimage(unsigned),
    publicKey,
    Buffer.from(signature.valueBase64, "base64"),
  );
}
