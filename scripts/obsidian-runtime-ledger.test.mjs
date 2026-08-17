import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveStatus, validateEvidencePolarity } from "./generate-obsidian-runtime-ledger.mjs";

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
  implemented: 121,
  partial: 15,
  unsupported: 0,
  missing: 22,
  ownMembers: 700,
  instanceMembers: 676,
  staticMembers: 24,
  heritageEdges: 89,
  implementedObligations: 639,
});
assert.equal(ledger.factory.keys.length, 137);
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
    ["AbstractInputSuggest", "implemented"],
    ["AbstractTextComponent", "implemented"],
    ["addIcon", "implemented"],
    ["apiVersion", "implemented"],
    ["App", "implemented"],
    ["arrayBufferToBase64", "implemented"],
    ["arrayBufferToHex", "implemented"],
    ["base64ToArrayBuffer", "implemented"],
    ["BaseComponent", "implemented"],
    ["BooleanValue", "implemented"],
    ["ButtonComponent", "implemented"],
    ["ColorComponent", "implemented"],
    ["Component", "implemented"],
    ["ConfirmationButton", "implemented"],
    ["ConfirmationModal", "implemented"],
    ["DateValue", "implemented"],
    ["debounce", "implemented"],
    ["displayTooltip", "implemented"],
    ["DisplayValueComponent", "implemented"],
    ["DropdownComponent", "implemented"],
    ["DurationValue", "implemented"],
    ["Editor", "implemented"],
    ["EditorSuggest", "implemented"],
    ["Events", "implemented"],
    ["ExtraButtonComponent", "implemented"],
    ["FileManager", "partial"],
    ["FileSystemAdapter", "partial"],
    ["FileValue", "implemented"],
    ["FileView", "implemented"],
    ["finishRenderMath", "partial"],
    ["FuzzySuggestModal", "implemented"],
    ["getAllTags", "implemented"],
    ["getBlobArrayBuffer", "implemented"],
    ["getFrontMatterInfo", "implemented"],
    ["getIcon", "implemented"],
    ["getIconIds", "implemented"],
    ["getLanguage", "implemented"],
    ["getLinkpath", "implemented"],
    ["hexToArrayBuffer", "implemented"],
    ["htmlToMarkdown", "implemented"],
    ["HTMLValue", "partial"],
    ["IconValue", "partial"],
    ["ImageValue", "partial"],
    ["ItemView", "implemented"],
    ["iterateCacheRefs", "implemented"],
    ["iterateRefs", "implemented"],
    ["Keymap", "implemented"],
    ["LinkValue", "implemented"],
    ["ListValue", "implemented"],
    ["MarkdownEditView", "implemented"],
    ["MarkdownPreviewRenderer", "implemented"],
    ["MarkdownPreviewView", "implemented"],
    ["MarkdownRenderChild", "implemented"],
    ["MarkdownRenderer", "implemented"],
    ["MarkdownView", "implemented"],
    ["Menu", "implemented"],
    ["MenuItem", "implemented"],
    ["MenuSeparator", "partial"],
    ["MetadataCache", "implemented"],
    ["Modal", "implemented"],
    ["moment", "implemented"],
    ["MomentFormatComponent", "implemented"],
    ["normalizePath", "implemented"],
    ["Notice", "implemented"],
    ["NotNullValue", "partial"],
    ["NullValue", "implemented"],
    ["NumberValue", "implemented"],
    ["ObjectValue", "implemented"],
    ["parseFrontMatterAliases", "implemented"],
    ["parseFrontMatterEntry", "implemented"],
    ["parseFrontMatterStringArray", "implemented"],
    ["parseFrontMatterTags", "implemented"],
    ["parseLinktext", "implemented"],
    ["parsePropertyId", "implemented"],
    ["parseYaml", "implemented"],
    ["Platform", "implemented"],
    ["Plugin", "implemented"],
    ["PluginSettingTab", "implemented"],
    ["PopoverSuggest", "implemented"],
    ["prepareFuzzySearch", "implemented"],
    ["prepareSimpleSearch", "implemented"],
    ["PrimitiveValue", "implemented"],
    ["ProgressBarComponent", "implemented"],
    ["RegExpValue", "implemented"],
    ["RelativeDateValue", "partial"],
    ["removeIcon", "implemented"],
    ["RenderContext", "implemented"],
    ["renderMatches", "implemented"],
    ["renderMath", "partial"],
    ["renderResults", "implemented"],
    ["requireApiVersion", "implemented"],
    ["resolveSubpath", "implemented"],
    ["sanitizeHTMLToDom", "implemented"],
    ["Scope", "implemented"],
    ["SearchComponent", "implemented"],
    ["SecretComponent", "implemented"],
    ["SecretStorage", "implemented"],
    ["setIcon", "implemented"],
    ["Setting", "implemented"],
    ["SettingGroup", "implemented"],
    ["SettingPage", "implemented"],
    ["SettingTab", "implemented"],
    ["setTooltip", "implemented"],
    ["SliderComponent", "implemented"],
    ["sortSearchResults", "implemented"],
    ["stringifyYaml", "implemented"],
    ["StringValue", "implemented"],
    ["stripHeading", "implemented"],
    ["stripHeadingForLink", "implemented"],
    ["SuggestModal", "implemented"],
    ["TAbstractFile", "implemented"],
    ["TagValue", "implemented"],
    ["Tasks", "implemented"],
    ["TextAreaComponent", "implemented"],
    ["TextComponent", "implemented"],
    ["TextFileView", "implemented"],
    ["TFile", "implemented"],
    ["TFolder", "implemented"],
    ["ToggleComponent", "implemented"],
    ["UrlValue", "partial"],
    ["Value", "implemented"],
    ["ValueComponent", "implemented"],
    ["Vault", "partial"],
    ["View", "implemented"],
    ["Workspace", "partial"],
    ["WorkspaceContainer", "implemented"],
    ["WorkspaceItem", "implemented"],
    ["WorkspaceLeaf", "implemented"],
    ["WorkspaceMobileDrawer", "implemented"],
    ["WorkspaceParent", "partial"],
    ["WorkspaceRibbon", "partial"],
    ["WorkspaceRoot", "implemented"],
    ["WorkspaceSidedock", "implemented"],
    ["WorkspaceSplit", "implemented"],
    ["WorkspaceTabs", "implemented"],
    ["WorkspaceWindow", "implemented"],
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
/** @compatibility-test-id obsidian-runtime.marker-positive-adjacent.v1 */
/** @compatibility-test-id obsidian-runtime.marker-negative-adjacent.v1 @compatibility-status unsupported */
const adjacentMarkerProbe = true;
assert.equal(adjacentMarkerProbe, true);
assert.equal(
  testIndex.markers.find((marker) => marker.id === "obsidian-runtime.marker-positive-adjacent.v1")
    ?.status,
  "positive",
);
assert.equal(
  testIndex.markers.find((marker) => marker.id === "obsidian-runtime.marker-negative-adjacent.v1")
    ?.status,
  "unsupported",
);

const positiveMarkers = new Map([["positive.fixture", { status: "positive" }]]);
const syntheticClass = {
  name: "SyntheticClass",
  kind: "class",
  obligations: [{ name: "member", signatureHash: "member.signature" }],
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
const fullSyntheticCoverage = {
  obligations: [{ signatureHash: "member.signature" }],
};
assert.equal(
  deriveStatus(
    syntheticClass,
    {
      status: "implemented",
      implementation: { source: "synthetic.ts", exportName: "SyntheticClass" },
      evidence: [],
      coverage: fullSyntheticCoverage,
    },
    ["SyntheticClass"],
    syntheticBinding,
    positiveMarkers,
  ),
  "missing",
  "empty positive evidence cannot promote a fully covered class",
);
assert.equal(
  deriveStatus(
    syntheticClass,
    {
      status: "implemented",
      implementation: { source: "synthetic.ts", exportName: "SyntheticClass" },
      negativeEvidence: [{ id: "unsupported.fixture" }],
      coverage: fullSyntheticCoverage,
    },
    ["SyntheticClass"],
    syntheticBinding,
    new Map([["unsupported.fixture", { status: "unsupported" }]]),
  ),
  "missing",
  "negative-only evidence with a binding cannot fall through to positive coverage",
);
assert.throws(
  () =>
    validateEvidencePolarity(
      {
        evidence: [{ id: "positive.fixture", path: "scripts/obsidian-runtime-ledger.test.mjs" }],
        negativeEvidence: [
          { id: "unsupported.fixture", path: "scripts/obsidian-runtime-ledger.test.mjs" },
        ],
      },
      "mixed fixture",
    ),
  /mutually exclusive/u,
  "positive and negative evidence cannot coexist",
);
assert.equal(
  deriveStatus(
    syntheticClass,
    {
      status: "implemented",
      implementation: { source: "synthetic.ts", exportName: "SyntheticClass" },
      evidence: [{ id: "positive.fixture" }],
      coverage: fullSyntheticCoverage,
    },
    ["SyntheticClass"],
    syntheticBinding,
    positiveMarkers,
  ),
  "implemented",
  "full executable signature coverage promotes a matching class",
);
assert.equal(
  deriveStatus(
    syntheticClass,
    {
      status: "implemented",
      implementation: { source: "synthetic.ts", exportName: "SyntheticClass" },
      evidence: [{ id: "positive.fixture" }],
      coverage: fullSyntheticCoverage,
    },
    ["SyntheticClass"],
    new Map([["SyntheticClass", { kind: "class", members: new Set() }]]),
    positiveMarkers,
  ),
  "partial",
  "full signature coverage cannot promote a class when its binding lacks the member",
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
