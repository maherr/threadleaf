import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildVaultScaleManifest,
  type VaultScaleManifest,
  vaultScaleSeed,
} from "./vault-scale-corpus";

const checkedInManifestPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "vault-scale-manifest.json",
);

// The checked-in manifest is a summary: it omits the per-variant sampleFiles and
// mutationPaths that buildVaultScaleManifest also returns. Project onto the same
// shape so drift between the generator and the checked-in file fails here instead
// of only showing up as a runtime mismatch in check-vault-scale.mjs.
function checkedInShape(manifest: VaultScaleManifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    generatorVersion: manifest.generatorVersion,
    seed: manifest.seed,
    variant: manifest.variant,
    fileCount: manifest.fileCount,
    visibleFileCount: manifest.visibleFileCount,
    hiddenFileCount: manifest.hiddenFileCount,
    markdownFileCount: manifest.markdownFileCount,
    ballastFileCount: manifest.ballastFileCount,
    totalBytes: manifest.totalBytes,
    extensionCounts: manifest.extensionCounts,
    depthProfile: manifest.depthProfile,
    noteSizeDistribution: manifest.noteSizeDistribution,
    sampleHash: manifest.sampleHash,
  };
}

describe("vault-scale corpus generator", () => {
  it("produces identical sample hashes from the same seed", () => {
    const first = buildVaultScaleManifest("notes-only");
    const second = buildVaultScaleManifest("notes-only");
    expect(first.seed).toBe(vaultScaleSeed);
    expect(second.seed).toBe(first.seed);
    expect(second.sampleHash).toBe(first.sampleHash);
    expect(second.sampleFiles).toEqual(first.sampleFiles);
  });

  it("keeps the notes-only variant byte-shape aligned with the full notes", () => {
    const full = buildVaultScaleManifest("full");
    const notesOnly = buildVaultScaleManifest("notes-only");
    expect(notesOnly.markdownFileCount).toBe(full.markdownFileCount);
    expect(notesOnly.noteSizeDistribution).toEqual(full.noteSizeDistribution);
    expect(notesOnly.mutationPaths).toEqual(full.mutationPaths);
  });

  it("keeps the checked-in manifest in sync with the generator", () => {
    const checkedIn = JSON.parse(readFileSync(checkedInManifestPath, "utf8")) as {
      variants: Record<string, unknown>;
    };
    for (const variant of ["full", "notes-only"] as const) {
      expect(checkedInShape(buildVaultScaleManifest(variant))).toEqual(checkedIn.variants[variant]);
    }
  });
});
