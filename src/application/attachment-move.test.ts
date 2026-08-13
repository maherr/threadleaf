import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { moveBinaryAttachment, planBinaryAttachmentMove } from "./attachment-move";

const pdfBytes = Buffer.from("%PDF-1.7\nbyte-preserved", "ascii");

let sandboxPath: string;
let vaultPath: string;
let statePath: string;
let kernel: VaultKernel;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-attachment-move-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Assets", "Other"), { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Assets", "Report PDF.bin"), pdfBytes);
  await fs.writeFile(
    path.join(vaultPath, "Notes", "Index.md"),
    "![[Report PDF.bin]]\n[download](../Assets/Report%20PDF.bin)\n",
    "utf8",
  );
  await fs.writeFile(path.join(vaultPath, "Notes", "Other.md"), "No attachment here.\n", "utf8");
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(statePath),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("attachment move planning", () => {
  it("rewrites relative Markdown links and wiki embeds in one recoverable plan", async () => {
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed Report.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({
      status: "planned",
      from: "Assets/Report PDF.bin",
      to: "Archive/Renamed Report.pdf",
      blockers: [],
      writes: [{ path: "Notes/Index.md" }],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    expect(plan.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          syntax: "wiki",
          embed: true,
          afterTarget: "Archive/Renamed Report.pdf",
        }),
        expect.objectContaining({
          syntax: "markdown",
          afterTarget: "../Archive/Renamed%20Report.pdf",
        }),
      ]),
    );
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed Report.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(result).toMatchObject({
      status: "committed",
      from: "Assets/Report PDF.bin",
      to: "Archive/Renamed Report.pdf",
    });
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Renamed Report.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[Archive/Renamed Report.pdf]]\n[download](../Archive/Renamed%20Report.pdf)\n",
    );
  });

  it("refuses ambiguous duplicate basenames rather than guessing a link winner", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "Other", "Report PDF.bin"), pdfBytes);
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({ status: "planned", blockers: [{ reason: "ambiguous" }] });
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("blocked");
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
  });

  it("returns a revision conflict after an external note edit and never overwrites it", async () => {
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    await fs.writeFile(path.join(vaultPath, "Notes", "Index.md"), "external winner\n", "utf8");
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
      { plan, ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}) },
    );
    expect(result).toMatchObject({ status: "conflict" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "external winner\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
  });

  it("matches attachment links by Unicode NFC and case without changing external URLs", async () => {
    const unicodeBytes = Buffer.from("%PDF-1.7\nRésumé", "utf8");
    await fs.writeFile(path.join(vaultPath, "Assets", "Résumé.PDF"), unicodeBytes);
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Unicode.md"),
      "[local](../assets/re\u0301sum\u00e9.pdf) [web](https://example.test/re\u0301sum\u00e9.pdf)\n",
      "utf8",
    );
    const source = await kernel.readBinary("Assets/Résumé.PDF", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected Unicode fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "assets/résumé.pdf",
      "Archive/Резюме.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a Unicode move plan.");
    expect(plan.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentPath: "Notes/Unicode.md", syntax: "markdown" }),
      ]),
    );
    const result = await moveBinaryAttachment(
      kernel,
      "assets/résumé.pdf",
      "Archive/Резюме.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("committed");
    await expect(fs.readFile(path.join(vaultPath, "Archive", "Резюме.pdf"))).resolves.toEqual(
      unicodeBytes,
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Unicode.md"), "utf8")).resolves.toBe(
      "[local](../Archive/%D0%A0%D0%B5%D0%B7%D1%8E%D0%BC%D0%B5.pdf) [web](https://example.test/re\u0301sum\u00e9.pdf)\n",
    );
  });
});
