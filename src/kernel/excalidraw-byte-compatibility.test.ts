import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "./ports";
import { type KernelFaultPoint, VaultKernel } from "./vault-kernel";

const EXCALIDRAW_MARKDOWN = `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


## Drawing
\`\`\`compressed-json
N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MQHNsYfpwBGAOlT0AtmIBeNCtlQbs6RmPry6uA4wC0KDDgLFLUTJ2lH8MTDHQ0YNMWHRJMRZFFgBWRQBmMiRPVRhGMBoEAG0AXXJ0KCgAZQCwPlBJfDwc7A0+Rk5MTHIdGCIAIXRUAGtirkZcAGF6THp8BBAAYgAzcYmQAF8poA===
\`\`\`
`;

const EXCALIDRAW_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const EXCALIDRAW_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="M0 0h1v1H0z"/></svg>',
  "utf8",
);

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-excalidraw-bytes-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Excalidraw"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function openKernel(
  faultInjector?: (point: KernelFaultPoint) => void | Promise<void>,
): Promise<VaultKernel> {
  return VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
    ...(faultInjector ? { faultInjector } : {}),
  });
}

async function expectBinary(filePath: string, expected: Uint8Array): Promise<void> {
  await expect(fs.readFile(path.join(vaultPath, filePath))).resolves.toEqual(Buffer.from(expected));
}

describe("Excalidraw byte compatibility", () => {
  it("preserves standard Markdown plus PNG and SVG bytes through conflicts and crash recovery", async () => {
    const markdownPath = "Excalidraw/Scene.excalidraw.md";
    const pngPath = "Excalidraw/Scene.excalidraw.png";
    const svgPath = "Excalidraw/Scene.excalidraw.svg";
    await Promise.all([
      fs.writeFile(path.join(vaultPath, markdownPath), EXCALIDRAW_MARKDOWN, "utf8"),
      fs.writeFile(path.join(vaultPath, pngPath), EXCALIDRAW_PNG),
      fs.writeFile(path.join(vaultPath, svgPath), EXCALIDRAW_SVG),
    ]);

    const interrupted = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("simulated binary write interruption");
      }
    });
    const markdown = await interrupted.readText(markdownPath);
    const png = await interrupted.readBinary(pngPath, 1024 * 1024);
    expect(markdown.content).toBe(EXCALIDRAW_MARKDOWN);
    expect(png.status).toBe("ready");
    if (png.status !== "ready") {
      throw new Error("Expected the PNG fixture to fit within the read limit.");
    }
    expect(png.snapshot.bytes).toEqual(EXCALIDRAW_PNG);
    const proposedPng = Buffer.concat([EXCALIDRAW_PNG, Buffer.from([0, 0xff, 1, 2, 3])]);
    await expect(
      interrupted.writeBinary(pngPath, proposedPng, png.snapshot.revision),
    ).rejects.toThrow("simulated binary write interruption");

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "write", outcome: "conflict-copy", path: pngPath },
    ]);
    await expectBinary(pngPath, EXCALIDRAW_PNG);
    const recoveredConflictPath = recovered.startupRecoveryActions[0]?.conflictPath;
    expect(recoveredConflictPath).toBeTypeOf("string");
    await expectBinary(recoveredConflictPath ?? "missing", proposedPng);

    const svg = await recovered.readBinary(svgPath, 1024 * 1024);
    if (svg.status !== "ready") {
      throw new Error("Expected the SVG fixture to fit within the read limit.");
    }
    const externalSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>external winner</text></svg>',
      "utf8",
    );
    const proposedSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><text>Threadleaf proposal</text></svg>',
      "utf8",
    );
    await fs.writeFile(path.join(vaultPath, svgPath), externalSvg);
    const conflict = await recovered.writeBinary(svgPath, proposedSvg, svg.snapshot.revision);
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") {
      throw new Error("Expected the external SVG edit to win the stale write race.");
    }
    await expectBinary(svgPath, externalSvg);
    await expectBinary(conflict.conflictPath, proposedSvg);
    await expect(fs.readFile(path.join(vaultPath, markdownPath), "utf8")).resolves.toBe(
      EXCALIDRAW_MARKDOWN,
    );
  });

  it("recovers an interrupted attachment rename without changing a byte", async () => {
    const sourcePath = "Excalidraw/Scene.excalidraw.png";
    const targetPath = "Attachments/Renamed Scene.png";
    await fs.writeFile(path.join(vaultPath, sourcePath), EXCALIDRAW_PNG);
    const interrupted = await openKernel((point) => {
      if (point === "rename:after-link") {
        throw new Error("simulated attachment rename interruption");
      }
    });
    const source = await interrupted.readBinary(sourcePath, 1024 * 1024);
    if (source.status !== "ready") {
      throw new Error("Expected the PNG fixture to fit within the read limit.");
    }

    await expect(
      interrupted.renameFile(sourcePath, targetPath, source.snapshot.revision),
    ).rejects.toThrow("simulated attachment rename interruption");
    await expectBinary(sourcePath, EXCALIDRAW_PNG);
    await expectBinary(targetPath, EXCALIDRAW_PNG);

    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "rename", outcome: "committed", path: targetPath },
    ]);
    await expect(fs.stat(path.join(vaultPath, sourcePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectBinary(targetPath, EXCALIDRAW_PNG);
  });
});
