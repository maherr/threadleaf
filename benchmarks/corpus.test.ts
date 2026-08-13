import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MetadataIndex } from "../src/kernel/metadata-index";
import { FixedStateRoot } from "../src/kernel/ports";
import { VaultKernel } from "../src/kernel/vault-kernel";
import {
  buildCorpusFiles,
  corpusProfiles,
  loadExpectedCorpusManifestHash,
  verifyCorpus,
  writeCorpus,
} from "./corpus";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function expectedHash(profile: keyof typeof corpusProfiles): Promise<string> {
  const contents = await fs.readFile(
    path.join(process.cwd(), "benchmarks", "corpus-manifests.json"),
    "utf8",
  );
  const value = JSON.parse(contents) as { profiles: Record<string, { manifestHash: string }> };
  return value.profiles[profile]?.manifestHash ?? "";
}

describe("public benchmark corpus", () => {
  it("generates identical bytes and the checked-in manifest for the smoke profile", async () => {
    const first = buildCorpusFiles("smoke");
    const second = buildCorpusFiles("smoke");
    expect(first.map((file) => [file.path, file.kind, file.bytes.toString("hex")])).toEqual(
      second.map((file) => [file.path, file.kind, file.bytes.toString("hex")]),
    );

    const root = await temporaryRoot("threadleaf-public-corpus-");
    const written = await writeCorpus(path.join(root, "vault"), "smoke");
    expect(written.manifest.manifestHash).toBe(await expectedHash("smoke"));
    await expect(
      verifyCorpus(written.rootPath, written.manifest.manifestHash),
    ).resolves.toMatchObject({
      profile: "smoke",
      noteCount: corpusProfiles.smoke.noteCount,
      attachmentCount: 4,
    });
  });

  it("rejects changed bytes and missing files instead of measuring a partial corpus", async () => {
    const root = await temporaryRoot("threadleaf-public-corpus-corrupt-");
    const corrupt = await writeCorpus(path.join(root, "corrupt"), "smoke");
    await fs.appendFile(path.join(corrupt.rootPath, "Topics", "Shared.md"), "corruption\n");
    await expect(verifyCorpus(corrupt.rootPath)).rejects.toThrow("bytes changed");

    const missing = await writeCorpus(path.join(root, "missing"), "smoke");
    await fs.rm(path.join(missing.rootPath, "Archive", "Shared.md"));
    await expect(verifyCorpus(missing.rootPath)).rejects.toThrow("missing");
  });

  it("covers index correctness shapes independently of timing budgets", async () => {
    const root = await temporaryRoot("threadleaf-public-corpus-index-");
    const written = await writeCorpus(path.join(root, "vault"), "smoke");
    const stateRoot = path.join(root, "state");
    const kernel = await VaultKernel.open({
      vaultRoot: written.rootPath,
      stateRoot: new FixedStateRoot(stateRoot),
      readOnly: true,
    });
    const index = await MetadataIndex.build(kernel);
    const snapshot = index.snapshot();
    expect(snapshot.documents).toHaveLength(corpusProfiles.smoke.noteCount);
    expect(snapshot.duplicateNames).toEqual([
      { name: "shared", paths: ["Archive/Shared.md", "Topics/Shared.md"] },
    ]);
    expect(snapshot.documents.flatMap((document) => document.links)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolution: { status: "unresolved" } }),
        expect.objectContaining({
          resolution: {
            status: "ambiguous",
            candidates: ["Archive/Shared.md", "Topics/Shared.md"],
          },
        }),
      ]),
    );
    expect(snapshot.backlinks.some((entry) => entry.sources.length > 0)).toBe(true);
    expect(index.search("singular-lighthouse").results).toHaveLength(1);
    expect(index.search("singular-lighthouse").results[0]?.path).toBe("Long/Corpus.md");
  });

  it("fails loud when the checked-in manifest registry is absent or malformed", async () => {
    const root = await temporaryRoot("threadleaf-public-corpus-registry-");
    await expect(
      loadExpectedCorpusManifestHash(path.join(root, "missing.json"), "smoke"),
    ).rejects.toThrow("could not be read");

    const malformedPath = path.join(root, "malformed.json");
    await fs.writeFile(malformedPath, '{"schemaVersion":1,"profiles":{}}\n');
    await expect(loadExpectedCorpusManifestHash(malformedPath, "smoke")).rejects.toThrow(
      "unsupported",
    );
  });
});
