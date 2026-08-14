import { promises as fs } from "node:fs";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const NOT_INSPECTED = [
  "Obsidian bundled JavaScript, source maps, private modules, and binary assets",
  "A real vault, real profile, account identity, credentials, telemetry, updater state, and network responses",
  "Private DOM fields, framework state, global enumeration, and unbounded HTML or script text",
  "Copied reference screenshots, fonts, logos, icons, CSS, or visual identity",
];

export function receiptFor(cellId, status, fields = {}) {
  assert(/^[A-Z]+-[0-9]{2}$/u.test(cellId), `Invalid behavior cell ID: ${cellId}`);
  assert(
    ["observed", "blocked", "unsupported", "unknown", "failed"].includes(status),
    `Invalid behavior cell status: ${status}`,
  );
  return {
    schemaVersion: 1,
    cellId,
    status,
    provenance: status === "observed" ? "observed" : status,
    input: fields.input ?? {},
    output: fields.output ?? {},
    artifacts: fields.artifacts ?? [],
    tolerance: fields.tolerance ?? {},
    redControl: fields.redControl ?? {},
    threadleafSeam: fields.threadleafSeam ?? [],
    notInspected: fields.notInspected ?? NOT_INSPECTED,
    reason: fields.reason,
  };
}

export async function writeReceipt(runRoot, receipt) {
  const destination = path.join(runRoot, "receipts", `${receipt.cellId}.v1.json`);
  const relativePath = path.relative(runRoot, destination).split(path.sep).join("/");
  const persisted = {
    ...receipt,
    artifacts: [...new Set([...(receipt.artifacts ?? []), relativePath])].sort(),
  };
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(destination, 0o600);
  Object.assign(receipt, persisted);
  return relativePath;
}

export async function writeRunManifest(runRoot, manifest) {
  const destination = path.join(runRoot, "manifest.v1.json");
  await fs.writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(destination, 0o600);
  return destination;
}

export function runManifest({ runId, reference, environment, fixtureId, profile }) {
  return {
    schemaVersion: 1,
    lab: "obsidian-behavior-lab",
    runId,
    reference,
    environment,
    fixtureId,
    profile,
    cells: [],
  };
}
