import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveStatus } from "./generate-obsidian-runtime-ledger.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
const ledger = read("compatibility/obsidian-runtime-ledger.v1.json");
const source = read("compatibility/obsidian-runtime-ledger-source.v1.json");
const testIndex = read("compatibility/obsidian-runtime-test-index.v1.json");
const encodedAuthority = readFileSync(
  path.join(repositoryRoot, "compatibility/authority/obsidian-1.13.7.d.ts.base64"),
  "ascii",
);
const compactAuthority = encodedAuthority.replace(/\s+/gu, "");
const decodedAuthority = Buffer.from(compactAuthority, "base64");

assert.equal(ledger.schemaVersion, 1);
assert.deepEqual(ledger.authority, source.authority);
assert.equal(encodedAuthority.includes(String.fromCodePoint(0x2014)), false);
assert.equal(encodedAuthority.includes(String.fromCodePoint(0x2013)), false);
assert.equal(createHash("sha256").update(decodedAuthority).digest("hex"), ledger.authority.sha256);
assert.equal(decodedAuthority.byteLength, ledger.authority.bytes);
assert.equal(decodedAuthority.toString("utf8").split("\n").length - 1, ledger.authority.lines);
assert.deepEqual(ledger.counts, {
  runtimeExports: 158,
  classes: 102,
  functions: 47,
  enums: 1,
  variables: 8,
  implemented: 0,
  partial: 5,
  unsupported: 0,
  missing: 153,
  ownMembers: 700,
  instanceMembers: 676,
  staticMembers: 24,
  heritageEdges: 89,
  implementedObligations: 7,
});
assert.equal(ledger.factory.keys.length, 74);
assert.deepEqual(ledger.factory.internalExtras, ["sleep"]);
assert.equal(
  ledger.exports.some((entry) => entry.name === "sleep"),
  false,
);
assert.equal(ledger.extras.sleep.status, "internal-extra");
/** @compatibility-test-id obsidian-runtime.sleep-extra.v1 */
assert.equal(ledger.factory.internalExtras.includes("sleep"), true);
assert.deepEqual(
  ledger.exports
    .filter((entry) => entry.status !== "missing")
    .map((entry) => [entry.name, entry.status]),
  [
    ["BaseComponent", "partial"],
    ["Component", "partial"],
    ["normalizePath", "partial"],
    ["Platform", "partial"],
    ["Plugin", "partial"],
  ],
);

const markerIds = new Set(testIndex.markers.map((marker) => marker.id));
for (const entry of Object.values(source.exports)) {
  for (const reference of [...(entry.evidence ?? []), ...(entry.negativeEvidence ?? [])]) {
    const marker = testIndex.markers.find((candidate) => candidate.id === reference.id);
    assert.equal(markerIds.has(reference.id), true, reference.id);
    assert.equal(marker?.path, reference.path, reference.id);
  }
}
for (const reference of source.extras.sleep.evidence) {
  const marker = testIndex.markers.find((candidate) => candidate.id === reference.id);
  assert.equal(markerIds.has(reference.id), true, reference.id);
  assert.equal(marker?.path, reference.path, reference.id);
}
assert.equal(new Set(testIndex.markers.map((marker) => marker.id)).size, testIndex.markers.length);

const positiveMarkers = new Map([["positive.fixture", { status: "positive" }]]);
const syntheticClass = {
  name: "SyntheticClass",
  kind: "class",
  obligations: [{ signatureHash: "member.signature" }],
};
const syntheticBinding = new Map([
  ["SyntheticClass", { kind: "class", members: new Set(["member"]) }],
]);
assert.equal(
  deriveStatus(
    syntheticClass,
    {
      status: "implemented",
      implementation: { source: "synthetic.ts", exportName: "SyntheticClass" },
      evidence: [{ id: "positive.fixture" }],
      coverage: { obligations: [] },
    },
    ["SyntheticClass"],
    syntheticBinding,
    positiveMarkers,
  ),
  "partial",
  "a manual implemented status and structural member match cannot replace obligation evidence",
);
assert.equal(
  deriveStatus(
    { name: "MissingFunction", kind: "function", obligations: [] },
    { status: "unsupported", negativeEvidence: [] },
    [],
    new Map(),
    new Map(),
  ),
  "missing",
  "a manual unsupported status cannot relabel an arbitrary missing export",
);
assert.equal(
  deriveStatus(
    { name: "UnsupportedFunction", kind: "function", obligations: [] },
    {
      status: "implemented",
      negativeEvidence: [{ id: "unsupported.fixture" }],
    },
    [],
    new Map(),
    new Map([["unsupported.fixture", { status: "unsupported" }]]),
  ),
  "unsupported",
  "unsupported requires an explicit negative marker, independent of manual status",
);

console.log(
  `Obsidian runtime ledger test passed: ${ledger.counts.runtimeExports} exports, ${ledger.counts.ownMembers} own members.`,
);
