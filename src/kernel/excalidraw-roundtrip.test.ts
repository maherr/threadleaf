import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moveBinaryAttachment, planBinaryAttachmentMove } from "../application/attachment-move";
import {
  canonicalExcalidrawSceneDigest,
  compareExcalidrawMarkdown,
  createExcalidrawAttachmentManifest,
  parseExcalidrawMarkdown,
  parseUncompressedExcalidrawScene,
  replaceExcalidrawScene,
  rewriteExcalidrawAttachmentReference,
} from "./excalidraw-roundtrip";
import { FixedStateRoot } from "./ports";
import { VaultKernel } from "./vault-kernel";

const fixtureVault = path.resolve("fixtures/corpus/excalidraw-roundtrip-v1/vault");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function copyFixture(): Promise<{ root: string; vault: string; state: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-excalidraw-roundtrip-test-"));
  temporaryRoots.push(root);
  const vault = path.join(root, "vault");
  const state = path.join(root, "state");
  await fs.cp(fixtureVault, vault, { recursive: true });
  return { root, vault, state };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Excalidraw public-format round trip", () => {
  it("parses Unicode uncompressed and opaque compressed scenes", async () => {
    const uncompressed = await fs.readFile(
      path.join(fixtureVault, "Drawings/Unicode Scene.excalidraw.md"),
      "utf8",
    );
    const compressed = await fs.readFile(
      path.join(fixtureVault, "Drawings/Compressed Scene.excalidraw.md"),
      "utf8",
    );
    expect(parseExcalidrawMarkdown(uncompressed)).toMatchObject({
      frontmatter: expect.stringContaining("excalidraw-plugin: parsed"),
      scene: { encoding: "json" },
      attachmentReferences: ["Assets/Ébauche/diagram.svg"],
    });
    expect(parseExcalidrawMarkdown(compressed).scene).toMatchObject({
      encoding: "compressed-json",
      payload: expect.stringContaining("N4IgLgng"),
    });
  });

  it("allows only canonical semantic changes inside an uncompressed scene", async () => {
    const source = await fs.readFile(
      path.join(fixtureVault, "Drawings/Unicode Scene.excalidraw.md"),
      "utf8",
    );
    const scene = parseUncompressedExcalidrawScene(source);
    const elements = Array.isArray(scene.elements) ? scene.elements : [];
    const text = elements.find(
      (element): element is Record<string, unknown> =>
        typeof element === "object" && element !== null && element.id === "text-title",
    );
    expect(text).toBeDefined();
    if (text) {
      text.text = "Ébauche modifiée";
      text.originalText = "Ébauche modifiée";
    }
    const reordered = JSON.stringify({
      appState: scene.appState,
      files: scene.files,
      elements,
      version: scene.version,
      source: scene.source,
      type: scene.type,
    });
    const edited = replaceExcalidrawScene(source, reordered);
    const comparison = compareExcalidrawMarkdown(source, edited);
    expect(comparison).toMatchObject({
      equal: false,
      kind: "semantic",
      encoding: "json",
      nonSceneBytesEqual: true,
    });
    expect(canonicalExcalidrawSceneDigest(parseUncompressedExcalidrawScene(edited))).toBe(
      canonicalExcalidrawSceneDigest({ ...scene, elements }),
    );
    expect(edited.slice(0, edited.indexOf("```json"))).toBe(
      source.slice(0, source.indexOf("```json")),
    );
  });

  it("requires exact bytes for compressed scenes", async () => {
    const source = await fs.readFile(
      path.join(fixtureVault, "Drawings/Compressed Scene.excalidraw.md"),
      "utf8",
    );
    expect(compareExcalidrawMarkdown(source, source)).toMatchObject({
      equal: true,
      kind: "byte-exact",
      encoding: "compressed-json",
    });
    const changed = source.replace("N4Ig", "N4Ih");
    expect(compareExcalidrawMarkdown(source, changed)).toMatchObject({
      equal: false,
      kind: "unsupported-compressed-change",
      encoding: "compressed-json",
    });
  });

  it("hashes nested Unicode attachments and rewrites one exact image target", async () => {
    const manifest = await createExcalidrawAttachmentManifest(fixtureVault, [
      "Assets/Ébauche/notes.txt",
      "Assets/Ébauche/diagram.svg",
      "Assets/Ébauche/diagram.svg",
    ]);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "Assets/Ébauche/diagram.svg",
      "Assets/Ébauche/notes.txt",
    ]);
    expect(manifest.entries[0]).toMatchObject({
      mime: "image/svg+xml",
      size: 360,
      sha256: "dfdafe29fb9903f7a61cbdd11abc6447376a322c4ede7c4a0fc1a320a5584b11",
    });

    const source = await fs.readFile(
      path.join(fixtureVault, "Drawings/Unicode Scene.excalidraw.md"),
      "utf8",
    );
    const rewritten = rewriteExcalidrawAttachmentReference(
      source,
      "Assets/Ébauche/diagram.svg",
      "Assets/Ébauche/diagram-renamed.svg",
    );
    expect(rewritten.replacements).toBe(1);
    expect(parseExcalidrawMarkdown(rewritten.markdown).attachmentReferences).toEqual([
      "Assets/Ébauche/diagram-renamed.svg",
    ]);
    expect(rewritten.markdown).toContain("See also [the source note]");
    await expect(
      createExcalidrawAttachmentManifest(fixtureVault, ["../outside.txt"]),
    ).rejects.toThrow("escapes the vault");
  });

  it("moves the supplied Excalidraw wiki attachment through the real attachment boundary", async () => {
    const { vault, state } = await copyFixture();
    const kernel = await VaultKernel.open({
      vaultRoot: vault,
      stateRoot: new FixedStateRoot(state),
    });
    const sourcePath = "Assets/Ébauche/diagram.svg";
    const targetPath = "Assets/Ébauche/diagram-renamed.svg";
    const source = await kernel.readBinary(sourcePath, 1024 * 1024);
    if (source.status !== "ready") throw new Error("Expected the SVG attachment fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      sourcePath,
      targetPath,
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned attachment move.");
    expect(plan.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentPath: "Drawings/Unicode Scene.excalidraw.md",
          syntax: "wiki",
          beforeTarget: "Assets/Ébauche/diagram.svg",
        }),
      ]),
    );

    const result = await moveBinaryAttachment(
      kernel,
      sourcePath,
      targetPath,
      source.snapshot.revision,
      { plan, acceptCurrentRewrites: true },
    );
    expect(result).toMatchObject({
      status: "published-source-retained",
      from: sourcePath,
      to: targetPath,
    });
    await expect(fs.readFile(path.join(vault, targetPath))).resolves.toEqual(source.snapshot.bytes);
    await expect(fs.readFile(path.join(vault, sourcePath))).resolves.toEqual(source.snapshot.bytes);
    const movedDrawing = await fs.readFile(
      path.join(vault, "Drawings/Unicode Scene.excalidraw.md"),
      "utf8",
    );
    expect(parseExcalidrawMarkdown(movedDrawing).attachmentReferences).toEqual([
      "../Assets/Ébauche/diagram-renamed.svg",
    ]);
  });

  it("routes stale scene revisions to a retained conflict copy", async () => {
    const { vault, state } = await copyFixture();
    const kernel = await VaultKernel.open({
      vaultRoot: vault,
      stateRoot: new FixedStateRoot(state),
    });
    const relative = "Drawings/Unicode Scene.excalidraw.md";
    const original = await kernel.readText(relative);
    const absolute = path.join(vault, relative);
    const external = `${original.content}\nExternal editor winner.\n`;
    const temporary = `${absolute}.external-temp`;
    await fs.writeFile(temporary, external, "utf8");
    await fs.rename(temporary, absolute);
    const proposal = original.content.replace("Ébauche ouverte", "Threadleaf stale proposal");
    const result = await kernel.writeText(relative, proposal, original.revision);
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") {
      throw new Error("Expected a revision conflict.");
    }
    await expect(fs.readFile(absolute, "utf8")).resolves.toBe(external);
    await expect(fs.readFile(path.join(vault, result.conflictPath), "utf8")).resolves.toBe(
      proposal,
    );
    expect(digest(Buffer.from(external))).not.toBe(digest(Buffer.from(proposal)));
  });
});
