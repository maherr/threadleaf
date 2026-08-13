import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  expandCanvasEmbeds,
  MAX_CANVAS_EMBED_COUNT,
  MAX_CANVAS_EMBED_DEPTH,
} from "./canvas-embed-service";

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

function canvas(file: string, nodes: unknown[]): string {
  return `${JSON.stringify({ nodes, edges: [], file }, null, 2)}\n`;
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-canvas-embed-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(path.join(vaultPath, "Boards"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Boards", "Root.canvas"),
    canvas("Root", [
      {
        id: "child",
        type: "file",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        file: "Boards/Child.canvas",
      },
      { id: "note", type: "file", x: 0, y: 0, width: 100, height: 80, file: "../Notes.md" },
    ]),
    "utf8",
  );
  await fs.writeFile(
    path.join(vaultPath, "Boards", "Child.canvas"),
    canvas("Child", [
      { id: "root", type: "file", x: 0, y: 0, width: 100, height: 80, file: "Boards/Root.canvas" },
    ]),
    "utf8",
  );
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("bounded canvas embeds", () => {
  it("expands nested canvases, excludes notes, and cuts cycles", async () => {
    const result = await expandCanvasEmbeds(kernel, "Boards/Root.canvas", kernel.vaultId);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.items.map((item) => item.path)).toEqual([
      "Boards/Root.canvas",
      "Boards/Child.canvas",
    ]);
    expect(result.items.map((item) => item.depth)).toEqual([0, 1]);
    expect(result.truncated).toBe(true);
  });

  it("caps caller-provided bounds at the published safety limits", async () => {
    const result = await expandCanvasEmbeds(kernel, "Boards/Root.canvas", kernel.vaultId, {
      maxDepth: 99,
      maxCount: 99,
    });
    expect(result.status).toBe("ready");
    expect(MAX_CANVAS_EMBED_DEPTH).toBe(4);
    expect(MAX_CANVAS_EMBED_COUNT).toBe(32);
  });
});
