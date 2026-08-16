import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revisionOf } from "../kernel/durability";
import type { VaultAttachmentNativeActionRequest } from "../shared/contracts";
import {
  performVaultAttachmentNativeAction,
  type VaultAttachmentNativeActionContext,
  type VaultAttachmentShellPort,
} from "./vault-attachment-native-action";

let sandboxPath: string;
let vaultPath: string;
let activeVaultId: string;
let activeVaultPath: string;

const pdfBytes = Buffer.from("%PDF-1.7\nfixture\0", "binary");

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-native-attachment-"));
  vaultPath = path.join(sandboxPath, "vault");
  activeVaultId = "vault-a";
  activeVaultPath = vaultPath;
  await fs.mkdir(path.join(vaultPath, "Assets"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function context(overrides: Partial<VaultAttachmentNativeActionContext> = {}) {
  return {
    vaultId: "vault-a",
    vaultPath,
    getActiveVault: () => ({ vaultId: activeVaultId, vaultPath: activeVaultPath }),
    ...overrides,
  } satisfies VaultAttachmentNativeActionContext;
}

function request(
  action: VaultAttachmentNativeActionRequest["action"],
  overrides: Partial<VaultAttachmentNativeActionRequest> = {},
): VaultAttachmentNativeActionRequest {
  return {
    action,
    path: "Assets/report.pdf",
    expectedRevision: revisionOf(pdfBytes),
    expectedVaultId: "vault-a",
    ...overrides,
  };
}

function shell() {
  return {
    openPath: vi.fn(async () => ""),
    showItemInFolder: vi.fn(),
  } satisfies VaultAttachmentShellPort;
}

describe("native attachment actions", () => {
  it("opens only the exact revision of a contained, byte-and-suffix-approved file", async () => {
    const nativeShell = shell();

    await expect(
      performVaultAttachmentNativeAction(context(), request("open"), nativeShell),
    ).resolves.toEqual({
      status: "opened",
      vaultId: "vault-a",
      path: "Assets/report.pdf",
    });
    expect(nativeShell.openPath).toHaveBeenCalledOnce();
    expect(nativeShell.openPath).toHaveBeenCalledWith(
      await fs.realpath(path.join(vaultPath, "Assets", "report.pdf")),
    );
    expect(nativeShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals unknown bytes while keeping them ineligible for native open", async () => {
    const unknownBytes = Buffer.from([0xff, 0x00, 0x91, 0x22, 0x00]);
    await fs.writeFile(path.join(vaultPath, "Assets", "unknown.bin"), unknownBytes);
    const nativeShell = shell();
    const unknownRequest = request("reveal", {
      path: "Assets/unknown.bin",
      expectedRevision: revisionOf(unknownBytes),
    });

    await expect(
      performVaultAttachmentNativeAction(context(), unknownRequest, nativeShell),
    ).resolves.toEqual({
      status: "reveal-dispatched",
      vaultId: "vault-a",
      path: "Assets/unknown.bin",
    });
    expect(nativeShell.showItemInFolder).toHaveBeenCalledWith(
      await fs.realpath(path.join(vaultPath, "Assets", "unknown.bin")),
    );

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        { ...unknownRequest, action: "open" },
        nativeShell,
      ),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "unsupported",
    });
    expect(nativeShell.openPath).not.toHaveBeenCalled();
  });

  it("refuses an executable-looking suffix even when the bytes are a recognized PDF", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.desktop"), pdfBytes);
    const nativeShell = shell();

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("open", { path: "Assets/report.desktop" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "unsupported" });
    expect(nativeShell.openPath).not.toHaveBeenCalled();
  });

  it("resolves a contained leaf symlink to its canonical target before reveal", async () => {
    await fs.symlink("report.pdf", path.join(vaultPath, "Assets", "report-link.pdf"));
    const nativeShell = shell();

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { path: "Assets/report-link.pdf" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "reveal-dispatched", path: "Assets/report-link.pdf" });
    expect(nativeShell.showItemInFolder).toHaveBeenCalledWith(
      await fs.realpath(path.join(vaultPath, "Assets", "report.pdf")),
    );
  });

  it("checks the canonical suffix before opening a contained leaf symlink", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "launcher.desktop"), pdfBytes);
    await fs.symlink("launcher.desktop", path.join(vaultPath, "Assets", "safe-looking.pdf"));
    const nativeShell = shell();

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("open", { path: "Assets/safe-looking.pdf" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "unsupported" });
    expect(nativeShell.openPath).not.toHaveBeenCalled();
  });

  it.each([
    ["../outside.pdf", "invalid"],
    ["/tmp/outside.pdf", "invalid"],
    [".obsidian/private.pdf", "private"],
    ["Assets/.hidden/report.pdf", "private"],
  ] as const)("rejects unsafe path %s as %s", async (unsafePath, reason) => {
    const nativeShell = shell();
    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { path: unsafePath }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason });
    expect(nativeShell.openPath).not.toHaveBeenCalled();
    expect(nativeShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects a symlink that resolves outside the vault", async () => {
    const outsidePath = path.join(sandboxPath, "outside.pdf");
    await fs.writeFile(outsidePath, pdfBytes);
    await fs.symlink(outsidePath, path.join(vaultPath, "Assets", "outside.pdf"));
    const nativeShell = shell();

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { path: "Assets/outside.pdf" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "outside-vault" });
    expect(nativeShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects a public-looking symlink whose canonical target is hidden", async () => {
    await fs.mkdir(path.join(vaultPath, ".hidden"));
    await fs.writeFile(path.join(vaultPath, ".hidden", "secret.pdf"), pdfBytes);
    await fs.symlink("../.hidden/secret.pdf", path.join(vaultPath, "Assets", "visible.pdf"));
    const nativeShell = shell();

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { path: "Assets/visible.pdf" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "private" });
    expect(nativeShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("refuses missing, oversized, changed, and non-file targets before native dispatch", async () => {
    const nativeShell = shell();
    await fs.mkdir(path.join(vaultPath, "Assets", "folder"));
    await fs.writeFile(path.join(vaultPath, "Assets", "large.pdf"), pdfBytes);

    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { path: "Assets/missing.pdf" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "missing" });
    await expect(
      performVaultAttachmentNativeAction(
        context({ maxBytes: pdfBytes.length - 1 }),
        request("reveal", { path: "Assets/large.pdf" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "too-large" });
    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { expectedRevision: "0".repeat(64) }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "stale-revision" });
    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { path: "Assets/folder" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "not-file" });
    expect(nativeShell.openPath).not.toHaveBeenCalled();
    expect(nativeShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("rejects an invalid revision and a vault that is stale before or after validation", async () => {
    const nativeShell = shell();
    await expect(
      performVaultAttachmentNativeAction(
        context(),
        request("reveal", { expectedRevision: "not-a-revision" }),
        nativeShell,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "invalid" });

    activeVaultId = "vault-b";
    activeVaultPath = path.join(sandboxPath, "other-vault");
    await expect(
      performVaultAttachmentNativeAction(context(), request("reveal"), nativeShell),
    ).resolves.toEqual({ status: "stale-vault", vaultId: "vault-b" });

    let currentChecks = 0;
    await expect(
      performVaultAttachmentNativeAction(
        context({
          getActiveVault: () => {
            currentChecks += 1;
            return currentChecks === 1
              ? { vaultId: "vault-a", vaultPath }
              : { vaultId: "vault-b", vaultPath: path.join(sandboxPath, "other-vault") };
          },
        }),
        request("reveal"),
        nativeShell,
      ),
    ).resolves.toEqual({ status: "stale-vault", vaultId: "vault-b" });
    expect(nativeShell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("returns stable native failures without exposing operating-system details", async () => {
    const openShell = shell();
    openShell.openPath.mockResolvedValue("/private/path: no handler");
    await expect(
      performVaultAttachmentNativeAction(context(), request("open"), openShell),
    ).resolves.toEqual({
      status: "unavailable",
      vaultId: "vault-a",
      reason: "native-failed",
      message: "The operating system could not open this attachment.",
    });

    const revealShell = shell();
    revealShell.showItemInFolder.mockImplementation(() => {
      throw new Error("/private/path: no file manager");
    });
    await expect(
      performVaultAttachmentNativeAction(context(), request("reveal"), revealShell),
    ).resolves.toEqual({
      status: "unavailable",
      vaultId: "vault-a",
      reason: "native-failed",
      message: "The operating system could not reveal this attachment.",
    });
  });
});
