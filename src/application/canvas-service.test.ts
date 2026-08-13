import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { type KernelFaultPoint, VaultKernel } from "../kernel/vault-kernel";
import { loadJsonCanvas, saveJsonCanvas } from "./canvas-service";

let sandboxPath: string;
let vaultPath: string;

const validCanvas = `${JSON.stringify({ nodes: [], edges: [], unknown: { keep: true } }, null, 2)}\n`;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-canvas-service-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Board.canvas"), validCanvas, "utf8");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function openKernel(faultInjector?: (point: KernelFaultPoint) => void): Promise<VaultKernel> {
  return VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
    ...(faultInjector ? { faultInjector } : {}),
  });
}

describe("JSON Canvas revision-aware service", () => {
  it("reports invalid and private Canvas paths explicitly", async () => {
    const kernel = await openKernel();
    await expect(loadJsonCanvas(kernel, "Board.md", kernel.vaultId)).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid",
    });
    await expect(
      loadJsonCanvas(kernel, ".obsidian/Board.canvas", kernel.vaultId),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "private",
    });
  });

  it("opens malformed JSON read-only with diagnostics and does not rewrite it", async () => {
    await fs.writeFile(path.join(vaultPath, "Broken.canvas"), "{oops", "utf8");
    const kernel = await openKernel();
    const response = await loadJsonCanvas(kernel, "Broken.canvas", kernel.vaultId);
    expect(response).toMatchObject({ status: "ready", canvas: { readOnly: true } });
    if (response.status !== "ready") return;
    expect(response.canvas.diagnostics[0]).toMatchObject({ code: "invalid-json", path: "$" });
    const outcome = await saveJsonCanvas(
      kernel,
      "Broken.canvas",
      validCanvas,
      response.canvas.revision,
      kernel.vaultId,
    );
    expect(outcome).toEqual({ status: "read-only", path: "Broken.canvas" });
    await expect(fs.readFile(path.join(vaultPath, "Broken.canvas"), "utf8")).resolves.toBe("{oops");
  });

  it("preserves external edits in a conflict copy instead of overwriting", async () => {
    const kernel = await openKernel();
    const loaded = await loadJsonCanvas(kernel, "Board.canvas", kernel.vaultId);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") return;
    await fs.writeFile(
      path.join(vaultPath, "Board.canvas"),
      '{"nodes":[],"edges":[],"external":true}\n',
      "utf8",
    );
    const outcome = await saveJsonCanvas(
      kernel,
      "Board.canvas",
      validCanvas.replace("keep", "proposal"),
      loaded.canvas.revision,
      kernel.vaultId,
    );
    expect(outcome.status).toBe("conflict");
    if (outcome.status !== "conflict") return;
    expect(outcome.conflictPath).toContain("Board.threadleaf-conflict-");
    await expect(fs.readFile(path.join(vaultPath, "Board.canvas"), "utf8")).resolves.toContain(
      "external",
    );
    await expect(
      fs.readFile(path.join(vaultPath, outcome.conflictPath), "utf8"),
    ).resolves.toContain("proposal");
  });

  it("lets the kernel recover an interrupted Canvas write", async () => {
    const interrupted = await openKernel((point) => {
      if (point === "write:after-stage") {
        throw new Error("simulated canvas interruption");
      }
    });
    const loaded = await loadJsonCanvas(interrupted, "Board.canvas", interrupted.vaultId);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") return;
    await expect(
      saveJsonCanvas(
        interrupted,
        "Board.canvas",
        validCanvas.replace("keep", "recovered"),
        loaded.canvas.revision,
        interrupted.vaultId,
      ),
    ).rejects.toThrow("simulated canvas interruption");
    const recovered = await openKernel();
    expect(recovered.startupRecoveryActions.length).toBeGreaterThan(0);
    await expect(fs.readFile(path.join(vaultPath, "Board.canvas"), "utf8")).resolves.toBe(
      validCanvas,
    );
  });
});
