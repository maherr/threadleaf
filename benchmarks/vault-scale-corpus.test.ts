import { describe, expect, it } from "vitest";
import { buildVaultScaleManifest, vaultScaleSeed } from "./vault-scale-corpus";

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
});
