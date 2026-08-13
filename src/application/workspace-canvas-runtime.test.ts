import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { WorkspaceRuntime } from "./workspace-runtime";

let sandboxPath: string;
let vaultPath: string;
let runtime: WorkspaceRuntime | undefined;

const canvas = `${JSON.stringify(
  {
    future: { keep: "yes" },
    nodes: [{ id: "text", type: "text", x: 0, y: 0, width: 160, height: 90, text: "Hello" }],
    edges: [],
  },
  null,
  2,
)}\n`;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-canvas-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Welcome\n", "utf8");
  await fs.writeFile(path.join(vaultPath, "Board.canvas"), canvas, "utf8");
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function openRuntime(selectionSource?: "bundled" | "direct"): Promise<WorkspaceRuntime> {
  runtime = await WorkspaceRuntime.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
    ...(selectionSource ? { selectionSource } : {}),
  });
  return runtime;
}

describe("WorkspaceRuntime JSON Canvas surface", () => {
  it("lists and opens Canvas files without putting them in the Markdown index", async () => {
    const workspace = await openRuntime();
    const initial = await workspace.getSnapshot();
    expect(initial.workspace?.files.map((file) => file.path)).toEqual(["Welcome.md"]);
    expect(initial.workspace?.canvasFiles).toEqual([{ path: "Board.canvas", title: "Board" }]);
    const opened = await workspace.openNote("Board.canvas");
    expect(opened.workspace?.activeNote).toBeNull();
    expect(opened.workspace?.panes[0]?.activeCanvas).toMatchObject({
      path: "Board.canvas",
      readOnly: false,
      document: { future: { keep: "yes" } },
    });
  });

  it("saves through the kernel and reports external-edit conflicts", async () => {
    const workspace = await openRuntime();
    const opened = await workspace.openNote("Board.canvas");
    const active = opened.workspace?.panes[0]?.activeCanvas;
    if (!active) throw new Error("Expected Board.canvas to open.");
    const edited = JSON.stringify({ nodes: [], edges: [], future: { keep: "changed" } });
    const saved = await workspace.saveCanvas(
      "Board.canvas",
      edited,
      active.revision,
      workspace.vaultId,
    );
    expect(saved.outcome.status).toBe("committed");
    await fs.writeFile(
      path.join(vaultPath, "Board.canvas"),
      '{"nodes":[],"edges":[],"external":true}\n',
      "utf8",
    );
    const conflict = await workspace.saveCanvas(
      "Board.canvas",
      edited.replace("changed", "proposal"),
      saved.outcome.status === "committed" ? saved.outcome.revision : active.revision,
      workspace.vaultId,
    );
    expect(conflict.outcome.status).toBe("conflict");
    if (conflict.outcome.status === "conflict") {
      expect(conflict.outcome.conflictPath).toContain("Board.threadleaf-conflict-");
      await expect(
        fs.readFile(path.join(vaultPath, conflict.outcome.conflictPath), "utf8"),
      ).resolves.toContain("proposal");
    }
  });

  it("keeps malformed canvases visible but non-writable", async () => {
    await fs.writeFile(path.join(vaultPath, "Broken.canvas"), "{oops", "utf8");
    const workspace = await openRuntime("bundled");
    const opened = await workspace.openNote("Broken.canvas");
    const active = opened.workspace?.panes[0]?.activeCanvas;
    expect(active).toMatchObject({ readOnly: true, diagnostics: [{ code: "invalid-json" }] });
    if (!active) throw new Error("Expected malformed canvas snapshot.");
    await expect(
      workspace.saveCanvas("Broken.canvas", canvas, active.revision, workspace.vaultId),
    ).resolves.toMatchObject({ outcome: { status: "read-only" } });
    await expect(fs.readFile(path.join(vaultPath, "Broken.canvas"), "utf8")).resolves.toBe("{oops");
  });

  it("keeps valid bundled canvases read-only before the writer is reached", async () => {
    const workspace = await openRuntime("bundled");
    const opened = await workspace.openNote("Board.canvas");
    const active = opened.workspace?.panes[0]?.activeCanvas;
    if (!active) throw new Error("Expected Board.canvas to open.");
    const saved = await workspace.saveCanvas(
      "Board.canvas",
      canvas.replace("Hello", "Would not write"),
      active.revision,
      workspace.vaultId,
    );
    expect(saved.outcome).toEqual({ status: "read-only", path: "Board.canvas" });
    await expect(fs.readFile(path.join(vaultPath, "Board.canvas"), "utf8")).resolves.toBe(canvas);
  });
});
