import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { moveBinaryAttachment, planBinaryAttachmentMove } from "./attachment-move";
import { loadVaultAttachment } from "./vault-attachment-service";

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
          afterTarget: "../Archive/Renamed Report.pdf",
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
      status: "published-source-retained",
      from: "Assets/Report PDF.bin",
      to: "Archive/Renamed Report.pdf",
    });
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Renamed Report.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[../Archive/Renamed Report.pdf]]\n[download](../Archive/Renamed%20Report.pdf)\n",
    );
  });

  it("uses relative-first then vault-root fallback for slash-containing wiki targets", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Nested.md"),
      "![[Assets/Report PDF.bin|root fallback]]\n",
      "utf8",
    );
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const listVisiblePaths = vi.spyOn(kernel, "listVisiblePaths");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Fallback.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    expect(listVisiblePaths).toHaveBeenCalledTimes(1);
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    expect(plan.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentPath: "Notes/Nested.md",
          syntax: "wiki",
          beforeTarget: "Assets/Report PDF.bin",
          afterTarget: "../Archive/Fallback.pdf",
        }),
      ]),
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
    expect(result.status).toBe("published-source-retained");
    await expect(fs.readFile(path.join(vaultPath, "Archive", "Резюме.pdf"))).resolves.toEqual(
      unicodeBytes,
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Unicode.md"), "utf8")).resolves.toBe(
      "[local](../Archive/%D0%A0%D0%B5%D0%B7%D1%8E%D0%BC%D0%B5.pdf) [web](https://example.test/re\u0301sum\u00e9.pdf)\n",
    );
  });

  it("preserves query and fragment suffixes across wiki, image, and ordinary links", async () => {
    const referencePath = path.join(vaultPath, "Notes", "References.md");
    await fs.writeFile(
      referencePath,
      [
        "![[Report%20PDF.bin?download=1%26preview=1#page=2|wiki image]]",
        '![image](../Assets/Report%20PDF.bin?download=1%26preview=1#page=3 "title")',
        "[ordinary](../Assets/Report%20PDF.bin?download=1%26preview=1#page=4)",
        "[external](https://example.test/Report%20PDF.bin?download=1#page=5)",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed Report.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("published-source-retained");
    await expect(fs.readFile(referencePath, "utf8")).resolves.toBe(
      [
        "![[../Archive/Renamed Report.pdf?download=1%26preview=1#page=2|wiki image]]",
        '![image](../Archive/Renamed%20Report.pdf?download=1%26preview=1#page=3 "title")',
        "[ordinary](../Archive/Renamed%20Report.pdf?download=1%26preview=1#page=4)",
        "[external](https://example.test/Report%20PDF.bin?download=1#page=5)",
      ].join("\n"),
    );
  });

  it("rewrites angle and escaped balanced-parenthesis destinations with byte ranges", async () => {
    const sourcePath = "Assets/Report (draft).pdf";
    await fs.writeFile(path.join(vaultPath, sourcePath), pdfBytes);
    const anglePath = path.join(vaultPath, "Notes", "Angle.md");
    const escapedPath = path.join(vaultPath, "Notes", "Escaped.md");
    await fs.writeFile(anglePath, "[valid](<../Assets/Report (draft).pdf>)\n", "utf8");
    await fs.writeFile(
      escapedPath,
      '[escaped](../Assets/Report\\ \\(draft\\).pdf?download=1#page=2 "title")\n',
      "utf8",
    );
    const source = await kernel.readBinary(sourcePath, Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const result = await moveBinaryAttachment(
      kernel,
      sourcePath,
      "Archive/Report final.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("published-source-retained");
    await expect(fs.readFile(anglePath, "utf8")).resolves.toBe(
      "[valid](<../Archive/Report%20final.pdf>)\n",
    );
    await expect(fs.readFile(escapedPath, "utf8")).resolves.toBe(
      '[escaped](../Archive/Report%20final.pdf?download=1#page=2 "title")\n',
    );
  });

  it("rewrites reference-style definitions and leaves YAML frontmatter source-only", async () => {
    const definitionPath = path.join(vaultPath, "Notes", "Definitions.md");
    await fs.writeFile(
      definitionPath,
      [
        "---",
        "[asset]: Hidden.pdf",
        "---",
        "",
        "See [report][asset].",
        '[asset]: <../Assets/Report%20PDF.bin> "Report title"',
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed Report.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("published-source-retained");
    await expect(fs.readFile(definitionPath, "utf8")).resolves.toBe(
      [
        "---",
        "[asset]: Hidden.pdf",
        "---",
        "",
        "See [report][asset].",
        '[asset]: <../Archive/Renamed%20Report.pdf> "Report title"',
      ].join("\n"),
    );
  });

  it("rewrites visible reference-style image definitions and blocks source-only definitions", async () => {
    const visiblePath = path.join(vaultPath, "Notes", "Visible Reference.md");
    await fs.writeFile(
      visiblePath,
      [
        "![report image][report-asset]",
        "![shortcut]",
        "",
        "[report-asset]: ../Assets/Report%20PDF.bin",
        "[shortcut]: ../Assets/Report%20PDF.bin",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const visibleMove = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Reference.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );
    expect(visibleMove.status).toBe("published-source-retained");
    await expect(fs.readFile(visiblePath, "utf8")).resolves.toBe(
      [
        "![report image][report-asset]",
        "![shortcut]",
        "",
        "[report-asset]: ../Archive/Reference.pdf",
        "[shortcut]: ../Archive/Reference.pdf",
      ].join("\n"),
    );

    const hiddenSource = path.join(vaultPath, "Assets", "Report PDF.bin");
    await fs.writeFile(hiddenSource, pdfBytes);
    const hiddenPath = path.join(vaultPath, "Notes", "Hidden Reference.md");
    await fs.writeFile(
      hiddenPath,
      [
        "---",
        "[report-asset]: ../Assets/Report%20PDF.bin",
        "---",
        "",
        "![report image][report-asset]",
      ].join("\n"),
      "utf8",
    );
    const hidden = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (hidden.status !== "ready") throw new Error("Expected hidden binary fixture.");
    const hiddenPlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Hidden Reference.pdf",
      hidden.snapshot.revision,
    );
    expect(hiddenPlan).toMatchObject({ status: "planned", blockers: [{ reason: "unsupported" }] });
    const hiddenMove = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Hidden Reference.pdf",
      hidden.snapshot.revision,
      { plan: hiddenPlan, acceptCurrentRewrites: true },
    );
    expect(hiddenMove.status).toBe("blocked");
    await expect(fs.readFile(hiddenSource)).resolves.toEqual(pdfBytes);
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "Hidden Reference.pdf")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects case and NFC-normalized source collisions before reading", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report PDF.BIN"), pdfBytes);
    await expect(
      planBinaryAttachmentMove(kernel, "Assets/Report PDF.bin", "Archive/Renamed.pdf"),
    ).rejects.toThrow("ambiguous after case and Unicode normalization");

    const composed = "Caf\u00e9.pdf";
    const decomposed = "Cafe\u0301.pdf";
    await fs.writeFile(path.join(vaultPath, "Assets", composed), pdfBytes);
    await fs.writeFile(path.join(vaultPath, "Assets", decomposed), pdfBytes);
    await expect(
      planBinaryAttachmentMove(kernel, `Assets/${composed}`, "Archive/Cafe.pdf"),
    ).rejects.toThrow("ambiguous after case and Unicode normalization");
  });

  it("blocks local-looking references that cannot be safely resolved", async () => {
    const blockedPath = path.join(vaultPath, "Notes", "Blocked.md");
    await fs.writeFile(blockedPath, "[private local](../.obsidian/Report%20PDF.bin)\n", "utf8");
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({
      status: "planned",
      blockers: [{ documentPath: "Notes/Blocked.md", reason: "unresolved" }],
    });
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
      { plan, acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("blocked");
    await expect(fs.stat(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(vaultPath, "Archive", "Renamed.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a Markdown file created immediately before the kernel move boundary", async () => {
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned" || !plan.confirmationId) throw new Error("Expected a plan.");
    let injected = false;
    const racingVault = {
      getName: kernel.getName.bind(kernel),
      listMarkdownPaths: kernel.listMarkdownPaths.bind(kernel),
      readMarkdownCorpus: kernel.readMarkdownCorpus.bind(kernel),
      listVisiblePaths: kernel.listVisiblePaths.bind(kernel),
      readText: kernel.readText.bind(kernel),
      readBinary: kernel.readBinary.bind(kernel),
      writeText: kernel.writeText.bind(kernel),
      renameFile: kernel.renameFile.bind(kernel),
      writeMany: kernel.writeMany.bind(kernel),
      moveWithWrites: async (request: Parameters<VaultKernel["moveWithWrites"]>[0]) => {
        if (!injected) {
          injected = true;
          await fs.writeFile(
            path.join(vaultPath, "Notes", "Created-at-kernel-boundary.md"),
            "created after preview\n",
            "utf8",
          );
        }
        return kernel.moveWithWrites(request);
      },
    };
    const result = await moveBinaryAttachment(
      racingVault,
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
      source.snapshot.revision,
      { plan, confirmationId: plan.confirmationId, acceptCurrentRewrites: true },
    );
    expect(result).toMatchObject({ status: "conflict", reason: "markdown-corpus-changed" });
    await expect(fs.stat(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(vaultPath, "Archive", "Renamed.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a legacy destructive move result instead of claiming source retention", async () => {
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Legacy-result.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");

    const legacyVault = {
      getName: kernel.getName.bind(kernel),
      listMarkdownPaths: kernel.listMarkdownPaths.bind(kernel),
      readMarkdownCorpus: kernel.readMarkdownCorpus.bind(kernel),
      listVisiblePaths: kernel.listVisiblePaths.bind(kernel),
      readText: kernel.readText.bind(kernel),
      readBinary: kernel.readBinary.bind(kernel),
      writeText: kernel.writeText.bind(kernel),
      renameFile: kernel.renameFile.bind(kernel),
      writeMany: kernel.writeMany.bind(kernel),
      moveWithWrites: async (request: Parameters<VaultKernel["moveWithWrites"]>[0]) => ({
        status: "committed" as const,
        from: request.sourcePath,
        to: request.targetPath,
        transactionId: "legacy-destructive-result",
        writes: [],
      }),
    };

    const result = await moveBinaryAttachment(
      legacyVault,
      plan.from,
      plan.to,
      source.snapshot.revision,
      {
        plan,
        ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
        acceptCurrentRewrites: true,
      },
    );

    expect(result).toMatchObject({
      status: "conflict",
      from: plan.from,
      to: plan.to,
      reason: "source-retention-not-supported",
    });
    await expect(fs.readFile(path.join(vaultPath, plan.from))).resolves.toEqual(pdfBytes);
    await expect(fs.stat(path.join(vaultPath, plan.to))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a corpus change after staging before the first child rewrite", async () => {
    const raceKernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:after-intent") {
          await fs.writeFile(
            path.join(vaultPath, "Notes", "Created-after-intent.md"),
            "created after staging\n",
            "utf8",
          );
        }
      },
    });
    const source = await raceKernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-intent.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");

    const result = await moveBinaryAttachment(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-intent.pdf",
      source.snapshot.revision,
      {
        plan,
        ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
        acceptCurrentRewrites: true,
      },
    );

    expect(result).toMatchObject({
      status: "conflict",
      reason: "markdown-corpus-changed-before-writes",
    });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[Report PDF.bin]]\n[download](../Assets/Report%20PDF.bin)\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "Renamed-after-intent.pdf")),
    ).resolves.toBeTruthy();
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Renamed-after-intent.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readdir(path.join(raceKernel.stateRoot, "journal"))).resolves.toEqual([]);
    const historyEntries = await fs.readdir(path.join(raceKernel.stateRoot, "history"));
    const histories = await Promise.all(
      historyEntries.map(
        async (entry) =>
          JSON.parse(
            await fs.readFile(path.join(raceKernel.stateRoot, "history", entry), "utf8"),
          ) as { kind?: unknown; outcome?: unknown; reason?: unknown },
      ),
    );
    expect(histories).toContainEqual(
      expect.objectContaining({
        kind: "move-with-writes",
        outcome: "rolled-back",
        reason: "markdown-corpus-changed-before-writes",
      }),
    );
  });

  it("detects a corpus mutation after the final preflight and rolls back exact writes", async () => {
    const raceKernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:after-corpus-preflight") {
          await fs.writeFile(
            path.join(vaultPath, "Notes", "Created-after-final-preflight.md"),
            "created after the final receipt\n",
            "utf8",
          );
        }
      },
    });
    const source = await raceKernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-final-preflight.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");

    const result = await moveBinaryAttachment(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-final-preflight.pdf",
      source.snapshot.revision,
      {
        plan,
        ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
        acceptCurrentRewrites: true,
      },
    );

    expect(result).toMatchObject({ status: "conflict", reason: "markdown-corpus-changed" });
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[Report PDF.bin]]\n[download](../Assets/Report%20PDF.bin)\n",
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Notes", "Created-after-final-preflight.md"), "utf8"),
    ).resolves.toBe("created after the final receipt\n");
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "Renamed-after-final-preflight.pdf")),
    ).resolves.toBeTruthy();
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Renamed-after-final-preflight.pdf")),
    ).resolves.toEqual(pdfBytes);
    const historyEntries = await fs.readdir(path.join(raceKernel.stateRoot, "history"));
    const histories = await Promise.all(
      historyEntries.map(
        async (entry) =>
          JSON.parse(
            await fs.readFile(path.join(raceKernel.stateRoot, "history", entry), "utf8"),
          ) as { kind?: unknown; outcome?: unknown; reason?: unknown },
      ),
    );
    expect(histories).toContainEqual(
      expect.objectContaining({
        kind: "move-with-writes",
        outcome: "rolled-back",
        reason: "markdown-corpus-changed",
      }),
    );
  });

  it("rechecks the corpus after the destination link and rolls back a new local reference", async () => {
    const raceKernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "rename:after-link") {
          await fs.writeFile(
            path.join(vaultPath, "Notes", "Created-after-link.md"),
            "![[Assets/Report PDF.bin]]\n",
            "utf8",
          );
        }
      },
    });
    const source = await raceKernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-link.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    const result = await moveBinaryAttachment(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-link.pdf",
      source.snapshot.revision,
      {
        plan,
        ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
        acceptCurrentRewrites: true,
      },
    );
    expect(result).toMatchObject({
      status: "conflict",
      reason: "markdown-corpus-changed-before-writes",
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "Renamed-after-link.pdf")),
    ).resolves.toBeTruthy();
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Renamed-after-link.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(
      fs.readFile(path.join(vaultPath, "Notes", "Created-after-link.md"), "utf8"),
    ).resolves.toBe("![[Assets/Report PDF.bin]]\n");
  });

  it("recovers an interrupted post-link corpus conflict without dropping source bytes", async () => {
    const raceKernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "rename:after-link") {
          await fs.writeFile(
            path.join(vaultPath, "Notes", "Created-before-recovery.md"),
            "![[Assets/Report PDF.bin]]\n",
            "utf8",
          );
          throw new Error("simulated post-link interruption");
        }
      },
    });
    const source = await raceKernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Renamed-after-recovery.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    await expect(
      moveBinaryAttachment(
        raceKernel,
        "Assets/Report PDF.bin",
        "Archive/Renamed-after-recovery.pdf",
        source.snapshot.revision,
        {
          plan,
          ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
          acceptCurrentRewrites: true,
        },
      ),
    ).rejects.toThrow("simulated post-link interruption");
    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "rolled-back",
      path: "Assets/Report PDF.bin",
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets/Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "Renamed-after-recovery.pdf")),
    ).resolves.toBeTruthy();
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Renamed-after-recovery.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(
      fs.readFile(path.join(vaultPath, "Notes", "Created-before-recovery.md"), "utf8"),
    ).resolves.toBe("![[Assets/Report PDF.bin]]\n");
  });

  it("recovers a publication crash before rewriting Markdown", async () => {
    const interrupted = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:after-publish") {
          throw new Error("simulated publication crash");
        }
      },
    });
    const source = await interrupted.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      interrupted,
      "Assets/Report PDF.bin",
      "Archive/Published-after-recovery.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");

    await expect(
      moveBinaryAttachment(
        interrupted,
        "Assets/Report PDF.bin",
        "Archive/Published-after-recovery.pdf",
        source.snapshot.revision,
        {
          plan,
          ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
          acceptCurrentRewrites: true,
        },
      ),
    ).rejects.toThrow("simulated publication crash");
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Published-after-recovery.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[Report PDF.bin]]\n[download](../Assets/Report%20PDF.bin)\n",
    );

    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "published-source-retained",
      path: "Archive/Published-after-recovery.pdf",
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Published-after-recovery.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[../Archive/Published-after-recovery.pdf]]\n[download](../Archive/Published-after-recovery.pdf)\n",
    );
  });

  it("keeps the source-retained receipt after a post-commit interruption", async () => {
    const interrupted = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:after-commit") {
          throw new Error("simulated post-commit interruption");
        }
      },
    });
    const source = await interrupted.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      interrupted,
      "Assets/Report PDF.bin",
      "Archive/Published-after-commit.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");

    await expect(
      moveBinaryAttachment(
        interrupted,
        "Assets/Report PDF.bin",
        "Archive/Published-after-commit.pdf",
        source.snapshot.revision,
        {
          plan,
          ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
          acceptCurrentRewrites: true,
        },
      ),
    ).rejects.toThrow("simulated post-commit interruption");

    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "published-source-retained",
      path: "Archive/Published-after-commit.pdf",
    });
    const historyEntries = await fs.readdir(path.join(recovered.stateRoot, "history"));
    const histories = await Promise.all(
      historyEntries.map((entry) =>
        fs.readFile(path.join(recovered.stateRoot, "history", entry), "utf8").then(JSON.parse),
      ),
    );
    expect(histories).toContainEqual(
      expect.objectContaining({
        kind: "move-with-writes",
        outcome: "published-source-retained",
      }),
    );
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Published-after-commit.pdf")),
    ).resolves.toEqual(pdfBytes);
  });

  it("reports manual recovery when an external source winner splits a renamed attachment", async () => {
    const raceKernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "rename:after-commit") {
          await fs.writeFile(
            path.join(vaultPath, "Assets", "Report PDF.bin"),
            Buffer.from("external source winner", "utf8"),
          );
          throw new Error("simulated split attachment recovery");
        }
      },
    });
    const source = await raceKernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      raceKernel,
      "Assets/Report PDF.bin",
      "Archive/Split-recovery.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");

    await expect(
      moveBinaryAttachment(
        raceKernel,
        "Assets/Report PDF.bin",
        "Archive/Split-recovery.pdf",
        source.snapshot.revision,
        {
          plan,
          ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
          acceptCurrentRewrites: true,
        },
      ),
    ).rejects.toThrow("simulated split attachment recovery");

    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "manual-conflict",
      path: "Assets/Report PDF.bin",
      conflictPath: "Assets/Report PDF.bin",
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      Buffer.from("external source winner", "utf8"),
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Split-recovery.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[../Archive/Split-recovery.pdf]]\n[download](../Archive/Split-recovery.pdf)\n",
    );
    const historyEntries = await fs.readdir(path.join(recovered.stateRoot, "history"));
    const parentHistory = await Promise.all(
      historyEntries.map(async (entry) => {
        const parsed = JSON.parse(
          await fs.readFile(path.join(recovered.stateRoot, "history", entry), "utf8"),
        ) as { kind?: unknown; outcome?: unknown; reason?: unknown };
        return parsed.kind === "move-with-writes" ? parsed : null;
      }),
    );
    expect(parentHistory).toContainEqual(
      expect.objectContaining({
        kind: "move-with-writes",
        outcome: "manual-conflict",
        reason: "publish-state-diverged",
      }),
    );
  });

  it("keeps Markdown unrepointed when recovery sees a corpus race", async () => {
    const interrupted = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:after-rename") {
          throw new Error("simulated restoration race");
        }
      },
    });
    const source = await interrupted.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      interrupted,
      "Assets/Report PDF.bin",
      "Archive/Restoration-race.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");

    await expect(
      moveBinaryAttachment(
        interrupted,
        "Assets/Report PDF.bin",
        "Archive/Restoration-race.pdf",
        source.snapshot.revision,
        {
          plan,
          ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
          acceptCurrentRewrites: true,
        },
      ),
    ).rejects.toThrow("simulated restoration race");
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Other.md"),
      "external corpus winner\n",
      "utf8",
    );

    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "rolled-back",
      path: "Assets/Report PDF.bin",
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Restoration-race.pdf")),
    ).resolves.toEqual(pdfBytes);
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[Report PDF.bin]]\n[download](../Assets/Report%20PDF.bin)\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Other.md"), "utf8")).resolves.toBe(
      "external corpus winner\n",
    );
    const historyEntries = await fs.readdir(path.join(recovered.stateRoot, "history"));
    const histories = await Promise.all(
      historyEntries.map(
        async (entry) =>
          JSON.parse(
            await fs.readFile(path.join(recovered.stateRoot, "history", entry), "utf8"),
          ) as { kind?: unknown; outcome?: unknown; reason?: unknown },
      ),
    );
    expect(histories).toContainEqual(
      expect.objectContaining({
        kind: "move-with-writes",
        outcome: "rolled-back",
        reason: "markdown-corpus-changed",
      }),
    );
  });

  it("preserves an external target winner at the final publish receipt", async () => {
    const interrupted = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:after-rename") {
          throw new Error("simulated restore-copy interruption");
        }
      },
    });
    const source = await interrupted.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");
    const plan = await planBinaryAttachmentMove(
      interrupted,
      "Assets/Report PDF.bin",
      "Archive/Restore-copy-race.pdf",
      source.snapshot.revision,
    );
    if (plan.status !== "planned") throw new Error("Expected a planned move.");
    await expect(
      moveBinaryAttachment(
        interrupted,
        "Assets/Report PDF.bin",
        "Archive/Restore-copy-race.pdf",
        source.snapshot.revision,
        {
          plan,
          ...(plan.confirmationId ? { confirmationId: plan.confirmationId } : {}),
          acceptCurrentRewrites: true,
        },
      ),
    ).rejects.toThrow("simulated restore-copy interruption");
    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: async (point) => {
        if (point === "move-with-writes:before-rename") {
          await fs.writeFile(
            path.join(vaultPath, "Archive", "Restore-copy-race.pdf"),
            Buffer.from("external target winner", "utf8"),
          );
        }
      },
    });

    expect(recovered.startupRecoveryActions.at(-1)).toMatchObject({
      kind: "move-with-writes",
      outcome: "rolled-back",
      path: "Assets/Report PDF.bin",
    });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "Report PDF.bin"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "Restore-copy-race.pdf")),
    ).resolves.toEqual(Buffer.from("external target winner", "utf8"));
    await expect(fs.readFile(path.join(vaultPath, "Notes", "Index.md"), "utf8")).resolves.toBe(
      "![[Report PDF.bin]]\n[download](../Assets/Report%20PDF.bin)\n",
    );
  });

  it("preserves BOM, CRLF, masked links, and unrelated Markdown bytes", async () => {
    const notePath = path.join(vaultPath, "Notes", "Byte-preserving.md");
    const before = Buffer.from(
      "\uFEFF# Keep\r\n\r\n![[Report%20PDF.bin]]\r\n`![[Report%20PDF.bin]]`\r\n<!-- ![[Report%20PDF.bin]] -->\r\n[unrelated](https://example.test/Report%20PDF.bin)\r\n",
      "utf8",
    );
    await fs.writeFile(notePath, before);
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");

    const result = await moveBinaryAttachment(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Byte-safe.pdf",
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );

    expect(result.status).toBe("published-source-retained");
    await expect(fs.readFile(notePath)).resolves.toEqual(
      Buffer.from(
        "\uFEFF# Keep\r\n\r\n![[../Archive/Byte-safe.pdf]]\r\n`![[Report%20PDF.bin]]`\r\n<!-- ![[Report%20PDF.bin]] -->\r\n[unrelated](https://example.test/Report%20PDF.bin)\r\n",
        "utf8",
      ),
    );
  });

  it("re-resolves generated wiki targets with literal path grammar bytes", async () => {
    const sourcePath = "Assets/Source?#%[]|.bin";
    const targetPath = "Archive/Target?#%[]|.bin";
    const referencePath = path.join(vaultPath, "Notes", "Grammar.md");
    await fs.writeFile(path.join(vaultPath, sourcePath), pdfBytes);
    await fs.writeFile(
      referencePath,
      "![[../Assets/Source%3F%23%25%5B%5D%7C.bin|fixture]]\n",
      "utf8",
    );
    const source = await kernel.readBinary(sourcePath, Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected binary fixture.");

    const result = await moveBinaryAttachment(
      kernel,
      sourcePath,
      targetPath,
      source.snapshot.revision,
      { acceptCurrentRewrites: true },
    );

    expect(result).toMatchObject({ status: "published-source-retained" });
    const content = await fs.readFile(referencePath, "utf8");
    expect(content).toBe("![[../Archive/Target%3F%23%25%5B%5D%7C.bin|fixture]]\n");
    const rawTarget = content.slice("![[".length, -"]]\n".length).split("|", 1)[0] ?? "";
    await expect(
      loadVaultAttachment(kernel, "Notes/Grammar.md", rawTarget, kernel.vaultId),
    ).resolves.toMatchObject({ status: "ready", attachment: { path: targetPath } });
  });
});
