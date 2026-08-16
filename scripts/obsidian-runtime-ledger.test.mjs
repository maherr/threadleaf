import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
const ledger = read("compatibility/obsidian-runtime-ledger.v1.json");
const source = read("compatibility/obsidian-runtime-ledger-source.v1.json");
const testIndex = read("compatibility/obsidian-runtime-test-index.v1.json");

assert.equal(ledger.schemaVersion, 1);
assert.deepEqual(ledger.authority, source.authority);
assert.deepEqual(ledger.counts, {
  runtimeExports: 158,
  classes: 102,
  functions: 47,
  enums: 1,
  variables: 8,
  implemented: 4,
  partial: 1,
  unsupported: 0,
  missing: 153,
  ownMembers: 700,
  instanceMembers: 676,
  staticMembers: 24,
  heritageEdges: 89,
  implementedObligations: 15,
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
    ["BaseComponent", "implemented"],
    ["Component", "implemented"],
    ["normalizePath", "implemented"],
    ["Platform", "implemented"],
    ["Plugin", "partial"],
  ],
);

const markerIds = new Set(testIndex.markers.map((marker) => marker.id));
for (const entry of Object.values(source.exports)) {
  for (const reference of entry.evidence) {
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

console.log(
  `Obsidian runtime ledger test passed: ${ledger.counts.runtimeExports} exports, ${ledger.counts.ownMembers} own members.`,
);
