import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMarkdownLinks, parseMarkdownReferenceUsages } from "../kernel/markdown-links";
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
  await fs.mkdir(path.join(vaultPath, "Archive"), { recursive: true });
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
        "[hidden]: Hidden.pdf",
        "---",
        "",
        "See [report][asset].",
        "",
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
        "[hidden]: Hidden.pdf",
        "---",
        "",
        "See [report][asset].",
        "",
        '[asset]: <../Archive/Renamed%20Report.pdf> "Report title"',
      ].join("\n"),
    );
  });

  it("ignores an unrelated missing image reference while planning source references", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const referencePath = path.join(vaultPath, "Notes", "Reference scope.md");
    await fs.writeFile(
      referencePath,
      [
        "![unrelated broken image][missing-label]",
        "[direct report](../Assets/report.pdf)",
        "![reference report][report-asset]",
        "![external image][external-image]",
        "",
        "[report-asset]: ../Assets/report.pdf",
        "[external-image]: https://example.test/report.pdf",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected scoped attachment fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentPath: "Notes/Reference scope.md",
          beforeTarget: "../Assets/report.pdf",
          afterTarget: "../Archive/report.pdf",
        }),
      ]),
    );
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report.pdf",
        source.snapshot.revision,
      ),
    ).resolves.toMatchObject({ status: "requires-confirmation" });
  });

  it("ignores unrelated malformed and duplicate definitions without associating a same-line link", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const referencePath = path.join(vaultPath, "Notes", "Unrelated definitions.md");
    await fs.writeFile(
      referencePath,
      [
        "![unrelated malformed][broken-label]",
        "[broken-label]: <../Assets/not-report.pdf [direct report](../Assets/report.pdf)",
        "![unrelated duplicate][other-label]",
        "[other-label]: ../Assets/Other/other.pdf",
        "[other-label]: https://example.test/other.pdf",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected scoped attachment fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    const rewrites = plan.rewrites.filter(
      (rewrite) => rewrite.documentPath === "Notes/Unrelated definitions.md",
    );
    expect(rewrites).toEqual([
      expect.objectContaining({
        line: 2,
        beforeTarget: "../Assets/report.pdf",
        afterTarget: "../Archive/report.pdf",
      }),
    ]);
  });

  it("blocks a missing image label that plausibly identifies the moving source", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Missing source label.md"),
      "![report image][report]\n",
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Missing source label.md",
          reason: "unsupported",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.blockers).toHaveLength(1);
  });

  it("allows valid and malformed external definitions even when their labels resemble the source", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    await fs.writeFile(
      path.join(vaultPath, "Notes", "External source-like labels.md"),
      [
        "![valid external][report]",
        "",
        "[report]: https://example.test/report.pdf",
        "",
        "![malformed external][report-copy]",
        "[report-copy]: <https://example.test/report.pdf",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], rewrites: [] });
  });

  it("allows a malformed definition with a definitively unrelated local destination", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Unrelated source-like malformed label.md"),
      ["![unrelated malformed][report-copy]", "[report-copy]: <../Assets/Other/other.pdf"].join(
        "\n",
      ),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], rewrites: [] });
  });

  it("blocks opaque and duplicate source evidence even when a peer is external", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const opaquePath = path.join(vaultPath, "Notes", "Opaque source definition.md");
    const opaqueDuplicatePath = path.join(vaultPath, "Notes", "Opaque duplicate definition.md");
    const duplicatePath = path.join(vaultPath, "Notes", "Duplicate source definition.md");
    await fs.writeFile(
      opaquePath,
      ["![report image][report-asset]", "[report-asset]: <../Assets/report.pdf"].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const opaquePlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(opaquePlan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Opaque source definition.md",
          reason: "unsupported",
        }),
        expect.objectContaining({
          documentPath: "Notes/Opaque source definition.md",
          reason: "unsupported",
        }),
      ],
    });

    await fs.unlink(opaquePath);
    await fs.writeFile(
      opaqueDuplicatePath,
      [
        "![report image][report-asset]",
        "[report-asset]: <../Assets/report.pdf",
        "",
        "[report-asset]: https://example.test/report.pdf",
      ].join("\n"),
      "utf8",
    );
    const opaqueDuplicatePlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(opaqueDuplicatePlan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Opaque duplicate definition.md",
          reason: "ambiguous",
        }),
        expect.objectContaining({
          documentPath: "Notes/Opaque duplicate definition.md",
          reason: "ambiguous",
        }),
      ],
    });
    if (opaqueDuplicatePlan.status !== "planned")
      throw new Error("Expected a planned publication.");
    expect(opaqueDuplicatePlan.blockers).toHaveLength(2);

    await fs.unlink(opaqueDuplicatePath);
    await fs.writeFile(
      duplicatePath,
      [
        "![report image][report-asset]",
        "",
        "[report-asset]: ../Assets/report.pdf",
        "[report-asset]: https://example.test/report.pdf",
      ].join("\n"),
      "utf8",
    );
    const duplicatePlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(duplicatePlan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Duplicate source definition.md",
          reason: "ambiguous",
        }),
      ],
    });
    if (duplicatePlan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(duplicatePlan.writes).toEqual([]);
    await expect(fs.readFile(duplicatePath, "utf8")).resolves.toBe(
      [
        "![report image][report-asset]",
        "",
        "[report-asset]: ../Assets/report.pdf",
        "[report-asset]: https://example.test/report.pdf",
      ].join("\n"),
    );
  });

  it("does not rewrite paragraph-adjacent source-like reference definitions", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const forms = [
      { name: "Full", usage: "[visible report][asset]" },
      { name: "Collapsed", usage: "[asset][]" },
      { name: "Shortcut", usage: "[asset]" },
    ];
    for (const form of forms) {
      await fs.writeFile(
        path.join(vaultPath, "Notes", `${form.name} ordinary reference.md`),
        [form.usage, "[asset]: ../Assets/report.pdf"].join("\n"),
        "utf8",
      );
    }
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    for (const form of forms) {
      expect(plan.writes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: `Notes/${form.name} ordinary reference.md` }),
        ]),
      );
    }
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    for (const form of forms) {
      await expect(
        fs.readFile(path.join(vaultPath, "Notes", `${form.name} ordinary reference.md`), "utf8"),
      ).resolves.toBe([form.usage, "[asset]: ../Assets/report.pdf"].join("\n"));
    }
  });

  it("follows renderer reference-block contexts before rewriting attachment definitions", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const forms = [
      { name: "ordinary-full", usage: (label: string) => `[visible][${label}]` },
      { name: "ordinary-collapsed", usage: (label: string) => `[${label}][]` },
      { name: "ordinary-shortcut", usage: (label: string) => `[${label}]` },
      { name: "image-full", usage: (label: string) => `![visible][${label}]` },
      { name: "image-collapsed", usage: (label: string) => `![${label}][]` },
      { name: "image-shortcut", usage: (label: string) => `![${label}]` },
    ];
    const endings = ["\n", "\r\n", "\r"] as const;
    const target = "../Assets/report.pdf";
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const paragraphContent = endings
      .flatMap((ending, endingIndex) =>
        forms.map((form, formIndex) => {
          const label = `asset-paragraph-${endingIndex}-${formIndex}`;
          return [form.usage(label), `[${label}]: ${target}`].join(ending);
        }),
      )
      .join("\n\n");
    const paragraphPath = path.join(vaultPath, "Notes", "Paragraph reference contexts.md");
    await fs.writeFile(paragraphPath, paragraphContent, "utf8");
    const paragraphPlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/paragraph-contexts.pdf",
      source.snapshot.revision,
    );
    expect(paragraphPlan).toMatchObject({ status: "planned", blockers: [] });
    if (paragraphPlan.status !== "planned") throw new Error("Expected a paragraph plan.");
    expect(paragraphPlan.writes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Notes/Paragraph reference contexts.md" }),
      ]),
    );
    expect(paragraphPlan.rewrites).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentPath: "Notes/Paragraph reference contexts.md" }),
      ]),
    );
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/paragraph-contexts.pdf",
        source.snapshot.revision,
        { plan: paragraphPlan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(paragraphPath, "utf8")).resolves.toBe(paragraphContent);
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);

    const containerCases = (
      context: string,
      prefix: string,
      blank: string,
      definitionPrefix: string,
    ) =>
      endings
        .flatMap((ending, endingIndex) =>
          forms.map((form, formIndex) => {
            const label = `asset-${context}-${endingIndex}-${formIndex}`;
            return [
              `${prefix}${form.usage(label)}`,
              blank,
              `${definitionPrefix}[${label}]: ${target}`,
            ].join(ending);
          }),
        )
        .join("\n\n");
    const blockquotePath = path.join(vaultPath, "Notes", "Blockquote reference contexts.md");
    const nestedPath = path.join(vaultPath, "Notes", "Nested reference contexts.md");
    const blockquoteContent = containerCases("blockquote", "> ", ">", "> ");
    const nestedContent = containerCases("nested", "- > ", "  >", "  > ");
    await Promise.all([
      fs.writeFile(blockquotePath, blockquoteContent, "utf8"),
      fs.writeFile(nestedPath, nestedContent, "utf8"),
    ]);
    const containerPlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/container-contexts.pdf",
      source.snapshot.revision,
    );
    expect(containerPlan).toMatchObject({ status: "planned", blockers: [] });
    if (containerPlan.status !== "planned") throw new Error("Expected a container plan.");
    const replacement = "../Archive/container-contexts.pdf";
    expect(containerPlan.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "Notes/Blockquote reference contexts.md",
          content: blockquoteContent.replaceAll(target, replacement),
        }),
        expect.objectContaining({
          path: "Notes/Nested reference contexts.md",
          content: nestedContent.replaceAll(target, replacement),
        }),
      ]),
    );
    expect(
      containerPlan.rewrites.filter(
        (rewrite) =>
          rewrite.documentPath === "Notes/Blockquote reference contexts.md" ||
          rewrite.documentPath === "Notes/Nested reference contexts.md",
      ),
    ).toHaveLength(36);
  });

  it("rewrites a live reference after an odd-escaped pseudo-wiki opener", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const forms = [
      { name: "ordinary-full", usage: "[visible][report]" },
      { name: "ordinary-collapsed", usage: "[report][]" },
      { name: "ordinary-shortcut", usage: "[report]" },
      { name: "image-full", usage: "![visible][report]" },
      { name: "image-collapsed", usage: "![report][]" },
      { name: "image-shortcut", usage: "![report]" },
    ];
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");
    for (const form of forms) {
      const notePath = path.join(vaultPath, "Notes", `Odd escaped ${form.name}.md`);
      const before = [`\\[[a] ${form.usage}]`, "", "[report]: ../Assets/report.pdf"].join("\n");
      const after = before.replace("../Assets/report.pdf", `../Archive/${form.name}.pdf`);
      await fs.writeFile(notePath, before, "utf8");
      const plan = await planBinaryAttachmentMove(
        kernel,
        "Assets/report.pdf",
        `Archive/${form.name}.pdf`,
        source.snapshot.revision,
      );
      expect(plan).toMatchObject({ status: "planned", blockers: [] });
      if (plan.status !== "planned") throw new Error("Expected an odd-escaped pseudo-wiki plan.");
      expect(plan.writes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: `Notes/Odd escaped ${form.name}.md`, content: after }),
        ]),
      );
    }
  });

  it("keeps dormant source definitions inert inside inline titles while blocking a nested renderer-only event", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const titleDefinitionPath = path.join(vaultPath, "Notes", "Inline title dormant.md");
    const nestedDefinitionPath = path.join(vaultPath, "Notes", "Nested label dormant.md");
    const externalDefinitionTitlePath = path.join(
      vaultPath,
      "Notes",
      "External definition title dormant.md",
    );
    const localDefinitionTitlePath = path.join(
      vaultPath,
      "Notes",
      "Local definition title dormant.md",
    );
    const malformedInlineUnrelatedPath = path.join(
      vaultPath,
      "Notes",
      "Malformed inline unrelated dormant.md",
    );
    const externalDefinitionInlineTitlePath = path.join(
      vaultPath,
      "Notes",
      "External definition inline title dormant.md",
    );
    const autolinkTitlePath = path.join(vaultPath, "Notes", "Autolink dormant.md");
    const rawHtmlTitlePath = path.join(vaultPath, "Notes", "Raw HTML dormant.md");
    const indentedCodePath = path.join(vaultPath, "Notes", "Indented code dormant.md");
    const rawHtmlBlockPath = path.join(vaultPath, "Notes", "Raw HTML block dormant.md");
    const rawTextHtmlBlocksPath = path.join(vaultPath, "Notes", "Raw text HTML blocks dormant.md");
    const wikiBodyDefinitionPath = path.join(vaultPath, "Notes", "Wiki body definition dormant.md");
    const titleWithoutDefinitionPath = path.join(
      vaultPath,
      "Notes",
      "Inline title no definition.md",
    );
    const realSourcePath = path.join(vaultPath, "Notes", "Real source link.md");
    const titleDefinition = [
      '[external](https://example.test "literal [report] title")',
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\r\n");
    const nestedDefinition = [
      "[other [report]](https://example.test)",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const externalDefinitionTitle = [
      '[external]: https://example.test "literal [report] title"',
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const localDefinitionTitle = [
      '[local]: ../Assets/Other/local.pdf "literal [report] title"',
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const malformedInlineUnrelated = [
      '[external](https://example.test "unclosed [unrelated]"',
      "[unrelated]: ../Assets/Other/unrelated.pdf",
    ].join("\n");
    const externalDefinitionInlineTitle =
      '[external]: https://example.test "literal [report](../Assets/report.pdf) and ![[../Assets/report.pdf]]"';
    const autolinkTitle = [
      "<https://example.test/[report](../Assets/report.pdf)>",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const rawHtmlTitle = [
      '<span data-x="[report](../Assets/report.pdf)">x</span>',
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const indentedCode = [
      "    [direct](../Assets/report.pdf)",
      "    [report]",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const rawHtmlBlock = [
      "<div>",
      "[direct](../Assets/report.pdf)",
      "[report]",
      "</div>",
      "[still raw](../Assets/report.pdf)",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const rawTextHtmlBlocks = ["script", "style", "pre", "textarea"]
      .flatMap((tag) => [
        `<${tag.toLocaleUpperCase("en-US")}>`,
        `[${tag} raw](../Assets/report.pdf)`,
        `</${tag}>`,
        "",
      ])
      .join("\r\n");
    const wikiBodyDefinition = [
      "[[Target|alias[report]]]",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    const titleWithoutDefinition = '[external](https://example.test "literal [report] title")\n';
    const realSource = "[real source](../Assets/report.pdf)\n";
    await Promise.all([
      fs.writeFile(titleDefinitionPath, titleDefinition, "utf8"),
      fs.writeFile(nestedDefinitionPath, nestedDefinition, "utf8"),
      fs.writeFile(externalDefinitionTitlePath, externalDefinitionTitle, "utf8"),
      fs.writeFile(localDefinitionTitlePath, localDefinitionTitle, "utf8"),
      fs.writeFile(malformedInlineUnrelatedPath, malformedInlineUnrelated, "utf8"),
      fs.writeFile(externalDefinitionInlineTitlePath, externalDefinitionInlineTitle, "utf8"),
      fs.writeFile(autolinkTitlePath, autolinkTitle, "utf8"),
      fs.writeFile(rawHtmlTitlePath, rawHtmlTitle, "utf8"),
      fs.writeFile(indentedCodePath, indentedCode, "utf8"),
      fs.writeFile(rawHtmlBlockPath, rawHtmlBlock, "utf8"),
      fs.writeFile(rawTextHtmlBlocksPath, rawTextHtmlBlocks, "utf8"),
      fs.writeFile(wikiBodyDefinitionPath, wikiBodyDefinition, "utf8"),
      fs.writeFile(titleWithoutDefinitionPath, titleWithoutDefinition, "utf8"),
      fs.writeFile(realSourcePath, realSource, "utf8"),
    ]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-final.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Nested label dormant.md",
          reason: "unsupported",
          target: "[report][]",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      expect.objectContaining({
        path: "Notes/Real source link.md",
        content: "[real source](../Archive/report-final.pdf)\n",
      }),
    ]);
    expect(plan.rewrites).toEqual([
      expect.objectContaining({
        documentPath: "Notes/Real source link.md",
        beforeTarget: "../Assets/report.pdf",
        afterTarget: "../Archive/report-final.pdf",
      }),
    ]);
    expect(plan.writes.some((write) => write.path === "Notes/Nested label dormant.md")).toBe(false);
    expect(
      plan.rewrites.some((rewrite) => rewrite.documentPath === "Notes/Nested label dormant.md"),
    ).toBe(false);

    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-final.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(fs.readFile(titleDefinitionPath, "utf8")).resolves.toBe(titleDefinition);
    await expect(fs.readFile(nestedDefinitionPath, "utf8")).resolves.toBe(nestedDefinition);
    await expect(fs.readFile(externalDefinitionTitlePath, "utf8")).resolves.toBe(
      externalDefinitionTitle,
    );
    await expect(fs.readFile(localDefinitionTitlePath, "utf8")).resolves.toBe(localDefinitionTitle);
    await expect(fs.readFile(malformedInlineUnrelatedPath, "utf8")).resolves.toBe(
      malformedInlineUnrelated,
    );
    await expect(fs.readFile(externalDefinitionInlineTitlePath, "utf8")).resolves.toBe(
      externalDefinitionInlineTitle,
    );
    await expect(fs.readFile(autolinkTitlePath, "utf8")).resolves.toBe(autolinkTitle);
    await expect(fs.readFile(rawHtmlTitlePath, "utf8")).resolves.toBe(rawHtmlTitle);
    await expect(fs.readFile(indentedCodePath, "utf8")).resolves.toBe(indentedCode);
    await expect(fs.readFile(rawHtmlBlockPath, "utf8")).resolves.toBe(rawHtmlBlock);
    await expect(fs.readFile(rawTextHtmlBlocksPath, "utf8")).resolves.toBe(rawTextHtmlBlocks);
    await expect(fs.readFile(wikiBodyDefinitionPath, "utf8")).resolves.toBe(wikiBodyDefinition);
    await expect(fs.readFile(titleWithoutDefinitionPath, "utf8")).resolves.toBe(
      titleWithoutDefinition,
    );
    await expect(fs.readFile(realSourcePath, "utf8")).resolves.toBe(realSource);
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "report-final.pdf")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps raw-single-bracket wiki bodies from activating dormant source definitions", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Raw wiki bracket dormant.md");
    const before = [
      "[[../Assets/report]draft.pdf#section|alias [report] title]]",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    await fs.writeFile(notePath, before, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/raw-wiki-bracket.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], writes: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.rewrites).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/raw-wiki-bracket.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(before);
  });

  it("keeps recognized math-block attachment syntax byte-identical and dormant", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Math block dormant.md");
    const before = [
      "  $$ ",
      "[direct](../Assets/report.pdf)",
      "![[../Assets/report.pdf]]",
      "[report]",
      "$$",
      " \\[ ",
      "[second](../Assets/report.pdf)",
      "![[../Assets/report.pdf]]",
      "[report]",
      "\\] ",
      "[report]: ../Assets/report.pdf",
    ].join("\r\n");
    await fs.writeFile(notePath, before, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/math-block-dormant.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], writes: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.rewrites).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/math-block-dormant.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(before);
  });

  it("keeps renderer-recognized quoted math blocks byte-identical and dormant", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Quoted math block dormant.md");
    const before = [
      "> $$",
      "> [direct](../Assets/report.pdf)",
      "> ![[../Assets/report.pdf]]",
      "> [report]",
      "> $$",
      "",
      "- > $$",
      "  > [second](../Assets/report.pdf)",
      "  > ![[../Assets/report.pdf]]",
      "  > [report]",
      "  > $$",
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\r\n");
    await fs.writeFile(notePath, before, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/quoted-math-block-dormant.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], writes: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.rewrites).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/quoted-math-block-dormant.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(before);
  });

  it("rewrites only a referenced source definition destination when its title contains an inline-looking source link", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Reference definition title positive.md");
    const content = [
      "[doc][asset]",
      "",
      '[asset]: ../Assets/report.pdf "see [report](../Assets/report.pdf) and ![[../Assets/report.pdf]]"',
    ].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-definition.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      {
        path: "Notes/Reference definition title positive.md",
        expectedRevision: expect.any(String),
        content: [
          "[doc][asset]",
          "",
          '[asset]: ../Archive/report-definition.pdf "see [report](../Assets/report.pdf) and ![[../Assets/report.pdf]]"',
        ].join("\n"),
      },
    ]);
    expect(plan.rewrites).toHaveLength(1);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-definition.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(
      [
        "[doc][asset]",
        "",
        '[asset]: ../Archive/report-definition.pdf "see [report](../Assets/report.pdf) and ![[../Assets/report.pdf]]"',
      ].join("\n"),
    );
  });

  it("rewrites one source definition for a mid-prose colon shortcut reference", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Mid-prose reference colon.md");
    const content = ["Text [report]: later", "", "[report]: ../Assets/report.pdf"].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-prose.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      {
        path: "Notes/Mid-prose reference colon.md",
        expectedRevision: expect.any(String),
        content: ["Text [report]: later", "", "[report]: ../Archive/report-prose.pdf"].join("\n"),
      },
    ]);
    expect(plan.rewrites).toHaveLength(1);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-prose.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(
      ["Text [report]: later", "", "[report]: ../Archive/report-prose.pdf"].join("\n"),
    );
  });

  it("rewrites one blank-separated source definition after malformed inline title text", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Malformed inline source evidence.md");
    const content = [
      '[external](https://example.test "unclosed [report]"',
      "",
      "[report]: ../Assets/report.pdf",
    ].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-malformed-inline.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      {
        path: "Notes/Malformed inline source evidence.md",
        expectedRevision: expect.any(String),
        content: [
          '[external](https://example.test "unclosed [report]"',
          "",
          "[report]: ../Archive/report-malformed-inline.pdf",
        ].join("\n"),
      },
    ]);
    expect(plan.rewrites).toHaveLength(1);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-malformed-inline.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(
      [
        '[external](https://example.test "unclosed [report]"',
        "",
        "[report]: ../Archive/report-malformed-inline.pdf",
      ].join("\n"),
    );
  });

  it("rewrites source definitions for whitespace-separated shortcut references", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Whitespace reference delimiters.md");
    const content = [
      "[report] (../Assets/other.pdf)",
      "[visible] [asset]",
      "",
      "[report]: ../Assets/report.pdf",
      "[asset]: ../Assets/report.pdf",
    ].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-whitespace.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      {
        path: "Notes/Whitespace reference delimiters.md",
        expectedRevision: expect.any(String),
        content: [
          "[report] (../Assets/other.pdf)",
          "[visible] [asset]",
          "",
          "[report]: ../Archive/report-whitespace.pdf",
          "[asset]: ../Archive/report-whitespace.pdf",
        ].join("\n"),
      },
    ]);
    expect(plan.rewrites).toHaveLength(2);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-whitespace.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(
      [
        "[report] (../Assets/other.pdf)",
        "[visible] [asset]",
        "",
        "[report]: ../Archive/report-whitespace.pdf",
        "[asset]: ../Archive/report-whitespace.pdf",
      ].join("\n"),
    );
  });

  it("rewrites one source definition for an image shortcut followed by a colon", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Image shortcut colon.md");
    const content = ["![report]: ../Assets/other.pdf", "", "[report]: ../Assets/report.pdf"].join(
      "\n",
    );
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-image-colon.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      {
        path: "Notes/Image shortcut colon.md",
        expectedRevision: expect.any(String),
        content: [
          "![report]: ../Assets/other.pdf",
          "",
          "[report]: ../Archive/report-image-colon.pdf",
        ].join("\n"),
      },
    ]);
    expect(plan.rewrites).toHaveLength(1);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-image-colon.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(
      ["![report]: ../Assets/other.pdf", "", "[report]: ../Archive/report-image-colon.pdf"].join(
        "\n",
      ),
    );
  });

  it("blocks an unsupported multiline source definition continuation without publishing", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Multiline source definition.md");
    const content = ["[x][asset]", "", "[asset]:", "  ../Assets/report.pdf"].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-multiline.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Multiline source definition.md",
          reason: "unsupported",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.blockers).toHaveLength(1);
    expect(plan.writes).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-multiline.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(content);
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "report-multiline.pdf")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps an unrelated multiline definition continuation dormant", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Multiline unrelated definition.md");
    const content = ["[x][asset]", "", "[asset]:", "  ../Assets/Other/other.pdf"].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-multiline-unrelated.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-multiline-unrelated.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(content);
  });

  it("keeps escaped attachment openers literal while retaining even-escaped links", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "escaped.pdf"), pdfBytes);
    await fs.writeFile(path.join(vaultPath, "Assets", "even.pdf"), pdfBytes);
    const escapedPath = path.join(vaultPath, "Notes", "Escaped attachment openers.md");
    const escapedBangPath = path.join(vaultPath, "Notes", "Escaped wiki embed marker.md");
    const evenPath = path.join(vaultPath, "Notes", "Even escaped attachment openers.md");
    const escaped = ["\\[ordinary](../Assets/escaped.pdf)", "\\[[../Assets/escaped.pdf]]"].join(
      "\n",
    );
    const escapedBang = "\\![[../Assets/escaped.pdf]]";
    const even = [
      "\\\\[ordinary](../Assets/even.pdf)",
      "\\\\[[../Assets/even.pdf]]",
      "\\\\![[../Assets/even.pdf]]",
    ].join("\n");
    await Promise.all([
      fs.writeFile(escapedPath, escaped, "utf8"),
      fs.writeFile(escapedBangPath, escapedBang, "utf8"),
      fs.writeFile(evenPath, even, "utf8"),
    ]);
    const escapedSource = await kernel.readBinary("Assets/escaped.pdf", Number.MAX_SAFE_INTEGER);
    if (escapedSource.status !== "ready") throw new Error("Expected escaped source fixture.");
    const escapedPlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/escaped.pdf",
      "Archive/escaped-published.pdf",
      escapedSource.snapshot.revision,
    );

    expect(escapedPlan).toMatchObject({ status: "planned", blockers: [] });
    if (escapedPlan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(escapedPlan.writes).toEqual([
      {
        path: "Notes/Escaped wiki embed marker.md",
        expectedRevision: expect.any(String),
        content: "\\![[../Archive/escaped-published.pdf]]",
      },
    ]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/escaped.pdf",
        "Archive/escaped-published.pdf",
        escapedSource.snapshot.revision,
        { plan: escapedPlan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(escapedPath, "utf8")).resolves.toBe(escaped);
    await expect(fs.readFile(escapedBangPath, "utf8")).resolves.toBe(
      "\\![[../Archive/escaped-published.pdf]]",
    );

    const evenSource = await kernel.readBinary("Assets/even.pdf", Number.MAX_SAFE_INTEGER);
    if (evenSource.status !== "ready") throw new Error("Expected even source fixture.");
    const evenPlan = await planBinaryAttachmentMove(
      kernel,
      "Assets/even.pdf",
      "Archive/even-published.pdf",
      evenSource.snapshot.revision,
    );

    expect(evenPlan).toMatchObject({ status: "planned", blockers: [] });
    if (evenPlan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(evenPlan.writes).toEqual([
      {
        path: "Notes/Even escaped attachment openers.md",
        expectedRevision: expect.any(String),
        content: [
          "\\\\[ordinary](../Archive/even-published.pdf)",
          "\\\\[[../Archive/even-published.pdf]]",
          "\\\\![[../Archive/even-published.pdf]]",
        ].join("\n"),
      },
    ]);
    expect(evenPlan.rewrites).toHaveLength(3);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/even.pdf",
        "Archive/even-published.pdf",
        evenSource.snapshot.revision,
        { plan: evenPlan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(evenPath, "utf8")).resolves.toBe(
      [
        "\\\\[ordinary](../Archive/even-published.pdf)",
        "\\\\[[../Archive/even-published.pdf]]",
        "\\\\![[../Archive/even-published.pdf]]",
      ].join("\n"),
    );
  });

  it("treats an escaped image marker as an ordinary source reference", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Escaped image marker.md");
    const content = ["\\![report]", "", "[report]: ../Assets/report.pdf"].join("\n");
    await fs.writeFile(notePath, content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report-escaped-image.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([
      {
        path: "Notes/Escaped image marker.md",
        expectedRevision: expect.any(String),
        content: ["\\![report]", "", "[report]: ../Archive/report-escaped-image.pdf"].join("\n"),
      },
    ]);
    expect(plan.rewrites).toHaveLength(1);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/report-escaped-image.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(
      ["\\![report]", "", "[report]: ../Archive/report-escaped-image.pdf"].join("\n"),
    );
  });

  it("ignores unrelated rejected outside-vault inline and opaque reference destinations", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const inlinePath = path.join(vaultPath, "Notes", "Outside inline unrelated.md");
    const opaquePath = path.join(vaultPath, "Notes", "Outside opaque unrelated.md");
    const inline = "[x](../../unrelated.pdf)\n";
    const opaque = ["[x][bad]", "[bad]: <../../unrelated.pdf"].join("\n");
    await Promise.all([
      fs.writeFile(inlinePath, inline, "utf8"),
      fs.writeFile(opaquePath, opaque, "utf8"),
    ]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/unrelated-outside.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/unrelated-outside.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(inlinePath, "utf8")).resolves.toBe(inline);
    await expect(fs.readFile(opaquePath, "utf8")).resolves.toBe(opaque);
  });

  it("keeps rejected outside-vault source basenames conservative across case, encoding, and NFC", async () => {
    const fixtures = [
      {
        sourcePath: "Assets/report.pdf",
        targetPath: "Archive/blocked-case.pdf",
        rawTarget: "../../REPORT.PDF",
        documentPath: "Notes/Outside case source.md",
        content: "[x](../../REPORT.PDF)\n",
        bytes: pdfBytes,
      },
      {
        sourcePath: "Assets/Caf\u00e9.pdf",
        targetPath: "Archive/blocked-unicode.pdf",
        rawTarget: "../../CAFE%CC%81.PDF",
        documentPath: "Notes/Outside encoded Unicode source.md",
        content: "[x](../../CAFE%CC%81.PDF)\n",
        bytes: Buffer.from("%PDF-1.7\ncaf\u00e9", "utf8"),
      },
    ];
    for (const fixture of fixtures) {
      await fs.writeFile(path.join(vaultPath, fixture.sourcePath), fixture.bytes);
      await fs.writeFile(path.join(vaultPath, fixture.documentPath), fixture.content, "utf8");
    }

    for (const fixture of fixtures) {
      const source = await kernel.readBinary(fixture.sourcePath, Number.MAX_SAFE_INTEGER);
      if (source.status !== "ready") throw new Error("Expected source fixture.");
      const plan = await planBinaryAttachmentMove(
        kernel,
        fixture.sourcePath,
        fixture.targetPath,
        source.snapshot.revision,
      );

      expect(plan).toMatchObject({
        status: "planned",
        blockers: [
          expect.objectContaining({
            documentPath: fixture.documentPath,
            reason: "unresolved",
          }),
        ],
      });
      if (plan.status !== "planned") throw new Error("Expected a planned publication.");
      expect(plan.blockers).toHaveLength(1);
      expect(plan.writes).toEqual([]);
      const result = await moveBinaryAttachment(
        kernel,
        fixture.sourcePath,
        fixture.targetPath,
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      );
      expect(result.status).toBe("blocked");
      await expect(fs.readFile(path.join(vaultPath, fixture.sourcePath))).resolves.toEqual(
        fixture.bytes,
      );
      await expect(fs.stat(path.join(vaultPath, fixture.targetPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(vaultPath, fixture.documentPath), "utf8")).resolves.toBe(
        fixture.content,
      );
    }
  });

  it("acknowledges first-definition precedence while conservatively blocking source-related duplicates", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const firstSource = path.join(vaultPath, "Notes", "First source later external.md");
    const firstOther = path.join(vaultPath, "Notes", "First external later source.md");
    const duplicateSource = path.join(vaultPath, "Notes", "Ordinary duplicate source.md");
    await fs.writeFile(
      firstSource,
      [
        "[report][asset]",
        "",
        "[asset]: ../Assets/report.pdf",
        "[asset]: https://example.test/report.pdf",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      firstOther,
      [
        "[report][asset]",
        "",
        "[asset]: https://example.test/report.pdf",
        "[asset]: ../Assets/report.pdf",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      duplicateSource,
      [
        "[report][asset]",
        "",
        "[asset]: ../Assets/report.pdf",
        "[asset]: ../Assets/report.pdf",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({
      status: "planned",
      blockers: expect.arrayContaining([
        expect.objectContaining({
          documentPath: "Notes/First source later external.md",
          reason: "ambiguous",
        }),
        expect.objectContaining({
          documentPath: "Notes/First external later source.md",
          reason: "ambiguous",
        }),
        expect.objectContaining({
          documentPath: "Notes/Ordinary duplicate source.md",
          reason: "ambiguous",
        }),
      ]),
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).toEqual([]);
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
      { plan, acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("blocked");
    await expect(fs.stat(path.join(vaultPath, "Archive", "report.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(firstSource, "utf8")).resolves.toBe(
      [
        "[report][asset]",
        "",
        "[asset]: ../Assets/report.pdf",
        "[asset]: https://example.test/report.pdf",
      ].join("\n"),
    );
    await expect(fs.readFile(firstOther, "utf8")).resolves.toBe(
      [
        "[report][asset]",
        "",
        "[asset]: https://example.test/report.pdf",
        "[asset]: ../Assets/report.pdf",
      ].join("\n"),
    );
    await expect(fs.readFile(duplicateSource, "utf8")).resolves.toBe(
      [
        "[report][asset]",
        "",
        "[asset]: ../Assets/report.pdf",
        "[asset]: ../Assets/report.pdf",
      ].join("\n"),
    );
  });

  it("blocks ordinary missing, opaque, and source-only definitions before publication without rewriting their bytes", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const missingPath = path.join(vaultPath, "Notes", "Ordinary missing definition.md");
    const opaquePath = path.join(vaultPath, "Notes", "Ordinary opaque definition.md");
    const frontmatterPath = path.join(vaultPath, "Notes", "Ordinary frontmatter definition.md");
    const adversarialPath = path.join(vaultPath, "Notes", "Ordinary same line adversarial.md");
    const missing = "[report.pdf]\n";
    const opaque = ["[report][asset]", "[asset]: <../Assets/report.pdf"].join("\n");
    const frontmatter = ["---", "[asset]: ../Assets/report.pdf", "---", "[report][asset]"].join(
      "\n",
    );
    const adversarial = [
      "[report][asset]",
      "[asset]: <../Assets/report.pdf [inline](../Assets/report.pdf)",
    ].join("\n");
    await Promise.all([
      fs.writeFile(missingPath, missing, "utf8"),
      fs.writeFile(opaquePath, opaque, "utf8"),
      fs.writeFile(frontmatterPath, frontmatter, "utf8"),
      fs.writeFile(adversarialPath, adversarial, "utf8"),
    ]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({
      status: "planned",
      blockers: expect.arrayContaining([
        expect.objectContaining({
          documentPath: "Notes/Ordinary missing definition.md",
          reason: "unsupported",
        }),
        expect.objectContaining({
          documentPath: "Notes/Ordinary opaque definition.md",
          reason: "unsupported",
        }),
        expect.objectContaining({
          documentPath: "Notes/Ordinary frontmatter definition.md",
          reason: "unsupported",
        }),
        expect.objectContaining({
          documentPath: "Notes/Ordinary same line adversarial.md",
          reason: "unsupported",
        }),
      ]),
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
      { plan, acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("blocked");
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(fs.stat(path.join(vaultPath, "Archive", "report.pdf"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(missingPath, "utf8")).resolves.toBe(missing);
    await expect(fs.readFile(opaquePath, "utf8")).resolves.toBe(opaque);
    await expect(fs.readFile(frontmatterPath, "utf8")).resolves.toBe(frontmatter);
    await expect(fs.readFile(adversarialPath, "utf8")).resolves.toBe(adversarial);
  });

  it("preserves dormant, unrelated, and external ordinary definitions byte-for-byte", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Dormant ordinary definitions.md");
    const note = [
      "[unrelated]",
      "[unrelated]: ../Assets/Other/other.bin",
      "[external]: https://example.test/report.pdf",
      "[dormant-source]: ../Assets/report.pdf",
    ].join("\n");
    await fs.writeFile(notePath, note, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );
    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.writes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "Notes/Dormant ordinary definitions.md" }),
      ]),
    );
    const result = await moveBinaryAttachment(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
      { plan, acceptCurrentRewrites: true },
    );
    expect(result.status).toBe("published-source-retained");
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(note);
  });

  it("emits one blocker for a referenced definition that is unresolved by path policy", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Referenced unresolved definition.md"),
      ["![report image][report]", "", "[report]: ../.obsidian/report.pdf"].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Referenced unresolved definition.md",
          reason: "unresolved",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.blockers).toHaveLength(1);
  });

  it("blocks a CR-only source reference definition", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    await fs.writeFile(
      path.join(vaultPath, "Notes", "CR-only source definition.md"),
      "![report image][report]\r[report]: <../Assets/report.pdf",
      "utf8",
    );
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/report.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/CR-only source definition.md",
          reason: "unsupported",
        }),
        expect.objectContaining({
          documentPath: "Notes/CR-only source definition.md",
          reason: "unsupported",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.blockers).toHaveLength(2);
  });

  it("keeps source-only frontmatter definition evidence blocked", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Notes", "Frontmatter source definition.md"),
      [
        "---",
        "[report-asset]: ../Assets/Report%20PDF.bin",
        "---",
        "",
        "![report image][report-asset]",
      ].join("\n"),
      "utf8",
    );
    const source = await kernel.readBinary("Assets/Report PDF.bin", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/Report PDF.bin",
      "Archive/Frontmatter.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Frontmatter source definition.md",
          reason: "unsupported",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.blockers).toHaveLength(1);
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

  it("does not publish or apply a safe rewrite when another source reference blocks the plan", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const safePath = path.join(vaultPath, "Notes", "Mixed safe source.md");
    const blockedPath = path.join(vaultPath, "Notes", "Mixed missing source label.md");
    const safeContent = "[safe](../Assets/report.pdf)\n";
    const blockedContent = "[missing][report]\n";
    await Promise.all([
      fs.writeFile(safePath, safeContent, "utf8"),
      fs.writeFile(blockedPath, blockedContent, "utf8"),
    ]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/mixed-blocked.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      blockers: [
        expect.objectContaining({
          documentPath: "Notes/Mixed missing source label.md",
          reason: "unsupported",
        }),
      ],
      writes: [
        expect.objectContaining({
          path: "Notes/Mixed safe source.md",
          content: "[safe](../Archive/mixed-blocked.pdf)\n",
        }),
      ],
    });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");

    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/mixed-blocked.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(fs.readFile(safePath, "utf8")).resolves.toBe(safeContent);
    await expect(fs.readFile(blockedPath, "utf8")).resolves.toBe(blockedContent);
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(fs.access(path.join(vaultPath, "Archive", "mixed-blocked.pdf"))).rejects.toThrow();
  });

  it("rewrites a visible collapsed image reference definition exactly once", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = path.join(vaultPath, "Notes", "Collapsed image reference.md");
    const before = ["![report-asset][]", "", "[report-asset]: ../Assets/report.pdf"].join("\n");
    const after = ["![report-asset][]", "", "[report-asset]: ../Archive/collapsed-image.pdf"].join(
      "\n",
    );
    await fs.writeFile(notePath, before, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/collapsed-image.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected a planned publication.");
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.writes).toEqual([
      {
        path: "Notes/Collapsed image reference.md",
        expectedRevision: expect.any(String),
        content: after,
      },
    ]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/collapsed-image.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(notePath, "utf8")).resolves.toBe(after);
  });

  it("changes only valid definition destination bytes across CRLF and CR-only source", async () => {
    for (const [name, ending] of [
      ["CRLF", "\r\n"],
      ["CR-only", "\r"],
    ] as const) {
      await fs.writeFile(path.join(vaultPath, "Assets", `${name}.pdf`), pdfBytes);
      const notePath = path.join(vaultPath, "Notes", `${name} definition bytes.md`);
      const destination = `Archive/${name}-rewritten.pdf`;
      const beforeTarget = `../Assets/${name}.pdf`;
      const afterTarget = `../Archive/${name}-rewritten.pdf`;
      const before = [
        "# Keep",
        "[doc][asset]",
        "",
        `[asset]: ${beforeTarget} "literal title"`,
        "after definition",
      ].join(ending);
      const after = before.replace(beforeTarget, afterTarget);
      await fs.writeFile(notePath, before, "utf8");
      const source = await kernel.readBinary(`Assets/${name}.pdf`, Number.MAX_SAFE_INTEGER);
      if (source.status !== "ready") throw new Error("Expected source fixture.");

      const plan = await planBinaryAttachmentMove(
        kernel,
        `Assets/${name}.pdf`,
        destination,
        source.snapshot.revision,
      );

      expect(plan).toMatchObject({ status: "planned", blockers: [] });
      if (plan.status !== "planned") throw new Error("Expected a planned publication.");
      expect(plan.rewrites).toHaveLength(1);
      expect(plan.writes).toEqual([
        {
          path: `Notes/${name} definition bytes.md`,
          expectedRevision: expect.any(String),
          content: after,
        },
      ]);
      await expect(
        moveBinaryAttachment(kernel, `Assets/${name}.pdf`, destination, source.snapshot.revision, {
          plan,
          acceptCurrentRewrites: true,
        }),
      ).resolves.toMatchObject({ status: "published-source-retained" });
      const actual = await fs.readFile(notePath, "utf8");
      const targetStart = before.indexOf(beforeTarget);
      expect(actual).toBe(after);
      expect(actual.slice(0, targetStart)).toBe(before.slice(0, targetStart));
      expect(actual.slice(targetStart + afterTarget.length)).toBe(
        before.slice(targetStart + beforeTarget.length),
      );
    }
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

  it("rewrites every renderer-live wrapped-label definition exactly once", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const forms = [
      { name: "ordinary-full", usage: "[visible][asset]" },
      { name: "ordinary-collapsed", usage: "[asset][]" },
      { name: "ordinary-shortcut", usage: "[asset]" },
      { name: "image-full", usage: "![visible][asset]" },
      { name: "image-collapsed", usage: "![asset][]" },
      { name: "image-shortcut", usage: "![asset]" },
    ];
    const contexts = [
      {
        name: "top",
        lines: (usage: string, target: string) => [
          usage,
          "",
          "[asset",
          `]: ${target} "keep title"`,
        ],
      },
      {
        name: "blockquote",
        lines: (usage: string, target: string) => [
          `> ${usage}`,
          ">",
          "> [asset",
          `> ]: ${target} "keep title"`,
        ],
      },
      {
        name: "nested-list-blockquote",
        lines: (usage: string, target: string) => [
          `- > ${usage}`,
          "  >",
          "  > [asset",
          `  > ]: ${target} "keep title"`,
        ],
      },
    ];
    const target = "../Assets/report.pdf";
    const replacement = "../Archive/wrapped-labels.pdf";
    const notes: Array<{ path: string; before: string; after: string }> = [];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        for (const form of forms) {
          const name = `${context.name}-${form.name}-${
            ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr"
          }`;
          const before = context.lines(form.usage, target).join(ending);
          const after = context.lines(form.usage, replacement).join(ending);
          const note = { path: `Notes/Wrapped ${name}.md`, before, after };
          notes.push(note);
          await fs.writeFile(path.join(vaultPath, note.path), before, "utf8");
        }
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected wrapped-label source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/wrapped-labels.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected wrapped-label publication plan.");
    expect(plan.rewrites).toHaveLength(54);
    expect(plan.writes).toHaveLength(54);
    for (const note of notes) {
      expect(plan.writes).toContainEqual({
        path: note.path,
        expectedRevision: expect.any(String),
        content: note.after,
      });
    }

    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/wrapped-labels.pdf",
        source.snapshot.revision,
        {
          plan,
          acceptCurrentRewrites: true,
        },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    for (const note of notes) {
      await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(note.after);
    }
  });

  it("rewrites renderer title continuations exactly once across containers and endings", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const contexts = [
      {
        name: "top",
        lines: (target: string) => ["[visible][asset]", "", `[asset]: ${target}`, '  "keep title"'],
      },
      {
        name: "blockquote",
        lines: (target: string) => [
          "> [visible][asset]",
          ">",
          `> [asset]: ${target}`,
          '>   "keep title"',
        ],
      },
      {
        name: "nested-list-blockquote",
        lines: (target: string) => [
          "- > [visible][asset]",
          "  >",
          `  > [asset]: ${target}`,
          '  >   "keep title"',
        ],
      },
    ];
    const target = "../Assets/report.pdf";
    const replacement = "../Archive/title-continuations.pdf";
    const notes: Array<{ path: string; before: string; after: string }> = [];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        const suffix = ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr";
        const before = context.lines(target).join(ending);
        const after = context.lines(replacement).join(ending);
        const note = {
          path: `Notes/Title continuation ${context.name}-${suffix}.md`,
          before,
          after,
        };
        notes.push(note);
        await fs.writeFile(path.join(vaultPath, note.path), before, "utf8");
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected title-continuation source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/title-continuations.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected title-continuation publication plan.");
    expect(plan.rewrites).toHaveLength(9);
    expect(plan.writes).toHaveLength(9);
    for (const note of notes) {
      expect(plan.writes).toContainEqual({
        path: note.path,
        expectedRevision: expect.any(String),
        content: note.after,
      });
    }

    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/title-continuations.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    for (const note of notes) {
      await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(note.after);
    }
  });

  it("blocks renderer destination continuations across containers and endings", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const contexts = [
      {
        name: "top",
        lines: (target: string) => ["[visible][asset]", "", "[asset]:", `  ${target}`],
      },
      {
        name: "blockquote",
        lines: (target: string) => ["> [visible][asset]", ">", "> [asset]:", `>   ${target}`],
      },
      {
        name: "nested-list-blockquote",
        lines: (target: string) => [
          "- > [visible][asset]",
          "  >",
          "  > [asset]:",
          `  >   ${target}`,
        ],
      },
    ];
    const target = "../Assets/report.pdf";
    const notes: Array<{ path: string; content: string }> = [];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        const suffix = ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr";
        const content = context.lines(target).join(ending);
        const note = {
          path: `Notes/Destination continuation ${context.name}-${suffix}.md`,
          content,
        };
        notes.push(note);
        await fs.writeFile(path.join(vaultPath, note.path), content, "utf8");
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") {
      throw new Error("Expected destination-continuation source fixture.");
    }
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/destination-continuations.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned" });
    if (plan.status !== "planned") {
      throw new Error("Expected destination-continuation publication plan.");
    }
    expect(plan.blockers).toHaveLength(9);
    expect(plan.blockers).toEqual(
      expect.arrayContaining(
        notes.map((note) =>
          expect.objectContaining({ documentPath: note.path, reason: "unsupported" }),
        ),
      ),
    );
    expect(plan.writes).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/destination-continuations.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    for (const note of notes) {
      await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(
        note.content,
      );
    }
  });

  it("keeps a renderer-live wrapped external definition dormant", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = "Notes/Wrapped external definition.md";
    const content = [
      "[visible][asset]",
      "",
      "[asset",
      ']: https://example.test/report.pdf "external"',
    ].join("\n");
    await fs.writeFile(path.join(vaultPath, notePath), content, "utf8");
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected wrapped-external source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/wrapped-external.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], rewrites: [], writes: [] });
    await expect(fs.readFile(path.join(vaultPath, notePath), "utf8")).resolves.toBe(content);
  });

  it("exposes direct attachment links after renderer-recognized trimmed frontmatter closers", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const target = "../Assets/report.pdf";
    const replacement = "../Archive/frontmatter-closers.pdf";
    const notes: Array<{ path: string; before: string; after: string }> = [];
    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const closer of ["\t...\t", "    ---"]) {
        const name = `${closer.includes(".") ? "dots" : "spaces"}-${
          ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr"
        }`;
        const before = ["---", "title: 😀", closer, `[visible](${target})`].join(ending);
        const after = ["---", "title: 😀", closer, `[visible](${replacement})`].join(ending);
        const note = { path: `Notes/Trimmed frontmatter ${name}.md`, before, after };
        notes.push(note);
        await fs.writeFile(path.join(vaultPath, note.path), before, "utf8");
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected frontmatter source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/frontmatter-closers.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned")
      throw new Error("Expected trimmed-frontmatter publication plan.");
    expect(plan.rewrites).toHaveLength(6);
    expect(plan.writes).toHaveLength(6);
    for (const note of notes) {
      expect(plan.writes).toContainEqual({
        path: note.path,
        expectedRevision: expect.any(String),
        content: note.after,
      });
    }
  });

  it("rewrites every renderer-live hard-wrapped reference usage exactly once without rewriting its usage syntax", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const sourceTarget = "../Assets/report.pdf";
    const replacementTarget = "../Archive/hard-wrapped-reference.pdf";
    const forms = [
      { name: "ordinary-full", lines: ["[visible alias][asset", "]"], embed: false },
      { name: "ordinary-collapsed", lines: ["[asset", "][]"], embed: false },
      { name: "ordinary-shortcut", lines: ["[asset", "]"], embed: false },
      { name: "image-full", lines: ["![image alt][asset", "]"], embed: true },
      { name: "image-collapsed", lines: ["![asset", "][]"], embed: true },
      { name: "image-shortcut", lines: ["![asset", "]"], embed: true },
    ];
    const contexts = [
      {
        name: "top-level",
        lines: (usage: readonly string[]) => [...usage, "", `[asset]: ${sourceTarget}`],
      },
      {
        name: "blockquote",
        lines: (usage: readonly string[]) => [
          ...usage.map((line) => `> ${line}`),
          ">",
          `> [asset]: ${sourceTarget}`,
        ],
      },
      {
        name: "nested-list-blockquote",
        lines: (usage: readonly string[]) => [
          `- > ${usage[0] ?? ""}`,
          ...usage.slice(1).map((line) => `  > ${line}`),
          "  >",
          `  > [asset]: ${sourceTarget}`,
        ],
      },
    ];
    const notes: Array<{
      path: string;
      before: string;
      after: string;
      embed: boolean;
      label: string;
    }> = [];

    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const context of contexts) {
        for (const form of forms) {
          const suffix = ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr";
          const label = `${context.name} ${form.name} ${suffix}`;
          const before = context.lines(form.lines).join(ending);
          const after = before.replace(sourceTarget, replacementTarget);
          const note = {
            path: `Notes/Hard wrapped ${context.name}-${form.name}-${suffix}.md`,
            before,
            after,
            embed: form.embed,
            label,
          };
          notes.push(note);
          await fs.writeFile(path.join(vaultPath, note.path), before, "utf8");

          const targetAttribute = form.embed ? "src" : "href";
          expect(renderer.render(before), label).toContain(`${targetAttribute}="${sourceTarget}"`);
          expect(parseMarkdownReferenceUsages(before), label).toEqual([
            expect.objectContaining({ label: "asset", embed: form.embed, line: 1 }),
          ]);
          expect(parseMarkdownLinks(before), label).toEqual([
            expect.objectContaining({ target: sourceTarget, syntax: "markdown" }),
          ]);
        }
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready")
      throw new Error("Expected hard-wrapped reference source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/hard-wrapped-reference.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned")
      throw new Error("Expected hard-wrapped reference publication plan.");
    expect(plan.rewrites).toHaveLength(notes.length);
    expect(plan.writes).toHaveLength(notes.length);
    for (const note of notes) {
      const targetStart = note.before.indexOf(sourceTarget);
      const targetAttribute = note.embed ? "src" : "href";
      expect(
        plan.rewrites.filter((rewrite) => rewrite.documentPath === note.path),
        note.label,
      ).toEqual([
        expect.objectContaining({
          syntax: "markdown",
          embed: false,
          beforeTarget: sourceTarget,
          afterTarget: replacementTarget,
        }),
      ]);
      expect(plan.writes, note.label).toContainEqual(
        expect.objectContaining({ path: note.path, content: note.after }),
      );
      expect(note.after.slice(0, targetStart), note.label).toBe(note.before.slice(0, targetStart));
      expect(note.after.slice(targetStart + replacementTarget.length), note.label).toBe(
        note.before.slice(targetStart + sourceTarget.length),
      );
      expect(parseMarkdownReferenceUsages(note.after), note.label).toEqual([
        expect.objectContaining({ label: "asset", embed: note.embed, line: 1 }),
      ]);
      expect(parseMarkdownLinks(note.after), note.label).toEqual([
        expect.objectContaining({ target: replacementTarget, syntax: "markdown" }),
      ]);
      expect(renderer.render(note.after), note.label).toContain(
        `${targetAttribute}="${replacementTarget}"`,
      );
    }
  });

  it("blocks nested renderer-only source references before mutation while preserving outer rewrites", async () => {
    await Promise.all([
      fs.writeFile(path.join(vaultPath, "Assets", "a.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "b.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "other.pdf"), pdfBytes),
    ]);
    const forms = [
      { name: "image-full", usage: "[x ![y][b]][a]", embed: true },
      { name: "image-collapsed", usage: "[x ![b][]][a]", embed: true },
      { name: "image-shortcut", usage: "[x ![b]][a]", embed: true },
      { name: "ordinary-full", usage: "[x [y][b]][a]", embed: false },
    ];

    for (const form of forms) {
      const notePath = `Notes/Nested renderer ${form.name}.md`;
      const sourceDefinition = [
        form.usage,
        "",
        "[a]: ../Assets/a.pdf",
        "[b]: ../Assets/b.pdf",
      ].join("\n");
      await fs.writeFile(path.join(vaultPath, notePath), sourceDefinition, "utf8");
      expect(
        parseMarkdownReferenceUsages(sourceDefinition).filter(
          (usage) => usage.sourceMappable === false,
        ),
        form.name,
      ).toEqual([expect.objectContaining({ label: "b", embed: form.embed, line: 1 })]);

      const sourceB = await kernel.readBinary("Assets/b.pdf", Number.MAX_SAFE_INTEGER);
      if (sourceB.status !== "ready") throw new Error("Expected nested b attachment fixture.");
      const targetB = `Archive/nested-${form.name}-b.pdf`;
      const blockedPlan = await planBinaryAttachmentMove(
        kernel,
        "Assets/b.pdf",
        targetB,
        sourceB.snapshot.revision,
      );

      expect(blockedPlan).toMatchObject({ status: "planned" });
      if (blockedPlan.status !== "planned") throw new Error("Expected nested b publication plan.");
      expect(blockedPlan.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentPath: notePath,
            target: form.embed ? "![b][]" : "[b][]",
            reason: "unsupported",
          }),
        ]),
      );
      expect(blockedPlan.rewrites.some((rewrite) => rewrite.documentPath === notePath)).toBe(false);
      expect(blockedPlan.writes.some((write) => write.path === notePath)).toBe(false);
      await expect(
        moveBinaryAttachment(kernel, "Assets/b.pdf", targetB, sourceB.snapshot.revision, {
          plan: blockedPlan,
          acceptCurrentRewrites: true,
        }),
      ).resolves.toMatchObject({ status: "blocked" });
      await expect(fs.readFile(path.join(vaultPath, notePath), "utf8")).resolves.toBe(
        sourceDefinition,
      );
      await expect(fs.readFile(path.join(vaultPath, "Assets", "b.pdf"))).resolves.toEqual(pdfBytes);
      await expect(fs.stat(path.join(vaultPath, targetB))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const unrelatedNested = sourceDefinition.replace("../Assets/b.pdf", "../Assets/other.pdf");
      const expectedOuterRewrite = unrelatedNested.replace(
        "../Assets/a.pdf",
        "../Archive/outer-a.pdf",
      );
      await fs.writeFile(path.join(vaultPath, notePath), unrelatedNested, "utf8");
      const sourceA = await kernel.readBinary("Assets/a.pdf", Number.MAX_SAFE_INTEGER);
      if (sourceA.status !== "ready") throw new Error("Expected nested a attachment fixture.");
      const outerPlan = await planBinaryAttachmentMove(
        kernel,
        "Assets/a.pdf",
        "Archive/outer-a.pdf",
        sourceA.snapshot.revision,
      );

      expect(outerPlan).toMatchObject({ status: "planned", blockers: [] });
      if (outerPlan.status !== "planned")
        throw new Error("Expected nested outer publication plan.");
      expect(outerPlan.rewrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentPath: notePath,
            beforeTarget: "../Assets/a.pdf",
            afterTarget: "../Archive/outer-a.pdf",
          }),
        ]),
      );
      expect(outerPlan.writes).toContainEqual(
        expect.objectContaining({ path: notePath, content: expectedOuterRewrite }),
      );
      await fs.rm(path.join(vaultPath, notePath));
    }
  });

  it("scopes nested renderer-only b evidence to source-related definitions", async () => {
    await Promise.all([
      fs.writeFile(path.join(vaultPath, "Assets", "b.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "other.pdf"), pdfBytes),
    ]);
    const variants = [
      {
        name: "source",
        definitions: ["[a]: https://example.test/a.pdf", "[b]: ../Assets/b.pdf"],
        blocked: true,
      },
      {
        name: "opaque source",
        definitions: [
          "[a]: https://example.test/a.pdf",
          "[b]: https://example.test/b.pdf",
          "[b]: <../Assets/b.pdf",
        ],
        blocked: true,
      },
      {
        name: "source-only",
        definitions: [
          "---",
          "[b]: ../Assets/b.pdf",
          "---",
          "[a]: https://example.test/a.pdf",
          "[b]: https://example.test/b.pdf",
        ],
        blocked: true,
      },
      {
        name: "duplicate",
        definitions: [
          "[a]: https://example.test/a.pdf",
          "[b]: ../Assets/b.pdf",
          "[b]: https://example.test/b.pdf",
        ],
        blocked: true,
      },
      {
        name: "external",
        definitions: ["[a]: https://example.test/a.pdf", "[b]: https://example.test/b.pdf"],
        blocked: false,
      },
      {
        name: "unrelated",
        definitions: ["[a]: https://example.test/a.pdf", "[b]: ../Assets/other.pdf"],
        blocked: false,
      },
    ];

    for (const variant of variants) {
      const notePath = `Notes/Nested renderer b ${variant.name}.md`;
      const content = ["[x ![y][b]][a]", "", ...variant.definitions].join("\n");
      await fs.writeFile(path.join(vaultPath, notePath), content, "utf8");
      expect(
        parseMarkdownReferenceUsages(content).filter((usage) => usage.sourceMappable === false),
        variant.name,
      ).toEqual([expect.objectContaining({ label: "b", embed: true, line: 1 })]);

      const source = await kernel.readBinary("Assets/b.pdf", Number.MAX_SAFE_INTEGER);
      if (source.status !== "ready") throw new Error("Expected nested policy attachment fixture.");
      const plan = await planBinaryAttachmentMove(
        kernel,
        "Assets/b.pdf",
        `Archive/nested-policy-${variant.name}.pdf`,
        source.snapshot.revision,
      );

      expect(plan).toMatchObject({ status: "planned" });
      if (plan.status !== "planned") throw new Error("Expected nested policy publication plan.");
      expect(
        plan.blockers.some((blocker) => blocker.documentPath === notePath),
        variant.name,
      ).toBe(variant.blocked);
      expect(
        plan.rewrites.some((rewrite) => rewrite.documentPath === notePath),
        variant.name,
      ).toBe(false);
      expect(
        plan.writes.some((write) => write.path === notePath),
        variant.name,
      ).toBe(false);
      await fs.rm(path.join(vaultPath, notePath));
    }
  });

  it("blocks neutral-label unmappable reference evidence only when its definition may name the source", async () => {
    await Promise.all([
      fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "other.pdf"), pdfBytes),
    ]);
    const sourceRelatedPath = "Notes/Unmappable neutral source evidence.md";
    const unrelatedPath = "Notes/Unmappable neutral unrelated evidence.md";
    const sourceRelated = ["\\[[asset]] [asset", "][]", "", "[asset]: ../Assets/report.pdf"].join(
      "\n",
    );
    const unrelated = ["\\[[asset]] [asset", "][]", "", "[asset]: ../Assets/other.pdf"].join("\n");
    await Promise.all([
      fs.writeFile(path.join(vaultPath, sourceRelatedPath), sourceRelated, "utf8"),
      fs.writeFile(path.join(vaultPath, unrelatedPath), unrelated, "utf8"),
    ]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected neutral-label source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/unmappable-neutral.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned" });
    if (plan.status !== "planned") throw new Error("Expected neutral-label planner output.");
    expect(plan.blockers.filter((blocker) => blocker.documentPath === sourceRelatedPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          line: 1,
          target: "[asset][]",
          syntax: "markdown",
          reason: "unsupported",
        }),
      ]),
    );
    expect(plan.blockers.some((blocker) => blocker.documentPath === unrelatedPath)).toBe(false);
    expect(plan.rewrites.some((rewrite) => rewrite.documentPath === sourceRelatedPath)).toBe(false);
    expect(plan.writes.some((write) => write.path === sourceRelatedPath)).toBe(false);
    expect(plan.rewrites.some((rewrite) => rewrite.documentPath === unrelatedPath)).toBe(false);
    expect(plan.writes.some((write) => write.path === unrelatedPath)).toBe(false);
  });

  it("keeps source-like unmappable labels dormant when every definition is definitely non-source", async () => {
    await Promise.all([
      fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "other.pdf"), pdfBytes),
    ]);
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const notes: Array<{ path: string; content: string; target: string }> = [];
    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const [name, usage] of [
        ["one-backslash", "\\[[report]]"],
        ["wrapped", ["[[report", "]"].join(ending)],
      ] as const) {
        for (const [definition, target] of [
          ["[report]: https://example.test/report.pdf", "https://example.test/report.pdf"],
          ["[report]: ../Assets/other.pdf", "../Assets/other.pdf"],
        ] as const) {
          const suffix = ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr";
          const targetName = target.startsWith("http") ? "external" : "unrelated";
          const content = [usage, "", definition].join(ending);
          const note = {
            path: `Notes/Source-like dormant ${name}-${targetName}-${suffix}.md`,
            content,
            target,
          };
          notes.push(note);
          await fs.writeFile(path.join(vaultPath, note.path), content, "utf8");
          expect(renderer.render(content), note.path).toContain(`href="${target}"`);
          expect(
            parseMarkdownReferenceUsages(content).filter((usage) => usage.sourceMappable === false),
            note.path,
          ).toEqual([expect.objectContaining({ label: "report", embed: false, line: 1 })]);
        }
      }
    }
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source-like dormant fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/source-like-dormant.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [], rewrites: [], writes: [] });
    if (plan.status !== "planned") throw new Error("Expected source-like dormant plan.");
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/source-like-dormant.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Archive", "source-like-dormant.pdf")),
    ).resolves.toEqual(pdfBytes);
    for (const note of notes) {
      await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(
        note.content,
      );
    }
  });

  it("rewrites an independent source definition beside an unmatched unrelated renderer event", async () => {
    await Promise.all([
      fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "other.pdf"), pdfBytes),
    ]);
    const notePath = "Notes/Event-isolated reference.md";
    const before = [
      "[[other",
      "] [visible][asset]",
      "",
      "[other]: ../Assets/other.pdf",
      "[asset]: ../Assets/report.pdf",
    ].join("\n");
    const after = before.replace("../Assets/report.pdf", "../Archive/event-isolated.pdf");
    await fs.writeFile(path.join(vaultPath, notePath), before, "utf8");
    expect(parseMarkdownReferenceUsages(before)).toEqual([
      expect.objectContaining({ label: "other", sourceMappable: false, line: 1 }),
      expect.objectContaining({ label: "asset", line: 2 }),
    ]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected event-isolated source fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/event-isolated.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned") throw new Error("Expected event-isolated plan.");
    expect(plan.rewrites).toEqual([
      expect.objectContaining({
        documentPath: notePath,
        syntax: "markdown",
        embed: false,
        beforeTarget: "../Assets/report.pdf",
        afterTarget: "../Archive/event-isolated.pdf",
      }),
    ]);
    expect(plan.writes).toEqual([expect.objectContaining({ path: notePath, content: after })]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/event-isolated.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "published-source-retained" });
    await expect(fs.readFile(path.join(vaultPath, notePath), "utf8")).resolves.toBe(after);
  });

  it("does not authorize a source definition shared with unmatched same-label evidence", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = "Notes/Same-label unmatched reference.md";
    const before = ["[good][asset]", "[[asset", "]", "", "[asset]: ../Assets/report.pdf"].join(
      "\n",
    );
    await fs.writeFile(path.join(vaultPath, notePath), before, "utf8");
    const opaqueUsages = parseMarkdownReferenceUsages(before).filter(
      (usage) => usage.sourceMappable === false,
    );
    expect(opaqueUsages).toHaveLength(2);
    expect(opaqueUsages.every((usage) => usage.label === "asset")).toBe(true);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected same-label evidence fixture.");

    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/same-label-unmatched.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({
      status: "planned",
      rewrites: [],
      writes: [],
    });
    if (plan.status !== "planned") throw new Error("Expected same-label evidence plan.");
    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentPath: notePath, reason: "unsupported" }),
      ]),
    );
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/same-label-unmatched.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(fs.readFile(path.join(vaultPath, notePath), "utf8")).resolves.toBe(before);
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.access(path.join(vaultPath, "Archive", "same-label-unmatched.pdf")),
    ).rejects.toThrow();
  });

  it("blocks renderer-visible unmatched wiki-prefix source evidence without scheduling unsafe writes", async () => {
    await Promise.all([
      fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes),
      fs.writeFile(path.join(vaultPath, "Assets", "other.pdf"), pdfBytes),
    ]);
    const renderer = new MarkdownIt({
      breaks: false,
      html: true,
      linkify: false,
      typographer: false,
    });
    const target = "../Assets/report.pdf";
    const sourceNotes: Array<{ path: string; content: string; name: string }> = [];
    const layouts = [
      {
        name: "top-level",
        source: (usage: readonly string[], definition: string) => [...usage, "", definition],
      },
      {
        name: "blockquote",
        source: (usage: readonly string[], definition: string) => [
          ...usage.map((line) => `> ${line}`),
          ">",
          `> ${definition}`,
        ],
      },
      {
        name: "nested-list-blockquote",
        source: (usage: readonly string[], definition: string) => [
          `- > ${usage[0] ?? ""}`,
          ...usage.slice(1).map((line) => `  > ${line}`),
          "  >",
          `  > ${definition}`,
        ],
      },
    ];
    const forms = [
      { name: "ordinary", lines: ["[[asset", "]"] },
      { name: "bang", lines: ["![[asset", "]"] },
    ];
    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const layout of layouts) {
        for (const form of forms) {
          const suffix = ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr";
          const name = `${layout.name}-${form.name}-${suffix}`;
          sourceNotes.push({
            path: `Notes/Unmatched wiki ${name}.md`,
            content: layout.source(form.lines, `[asset]: ${target}`).join(ending),
            name,
          });
        }
      }
    }
    const longLabel = "a".repeat(999);
    for (const edgeCase of [
      { name: "one-backslash", lines: ["\\[[asset]]"], definitionLabel: "asset" },
      {
        name: "whitespace-case",
        lines: ["[[ \t ASSET ", "]"],
        definitionLabel: " aSsEt ",
      },
      {
        name: "escaped-label-close",
        lines: ["[[asset\\]", "]"],
        definitionLabel: "asset\\]",
      },
      { name: "collapsed", lines: ["[[asset", "][]"], definitionLabel: "asset" },
      { name: "extra-close", lines: ["[[asset", "]]"], definitionLabel: "asset" },
      {
        name: "long-label",
        lines: [`[[${longLabel}`, "]"],
        definitionLabel: longLabel,
      },
      {
        name: "mixed-event",
        lines: ["[[asset", "] ![[asset", "]"],
        definitionLabel: "asset",
      },
    ]) {
      sourceNotes.push({
        path: `Notes/Unmatched wiki ${edgeCase.name}.md`,
        content: [...edgeCase.lines, "", `[${edgeCase.definitionLabel}]: ${target}`].join("\n"),
        name: edgeCase.name,
      });
    }
    const dormantNotes = [
      {
        path: "Notes/Unmatched wiki unrelated.md",
        content: ["[[asset", "]", "", "[asset]: ../Assets/other.pdf"].join("\n"),
      },
      {
        path: "Notes/Unmatched wiki external.md",
        content: ["[[asset", "]", "", "[asset]: https://example.test/report.pdf"].join("\n"),
      },
      {
        path: "Notes/Complete wiki ordinary.md",
        content: ["[[asset]]", "", `[asset]: ${target}`].join("\n"),
      },
      {
        path: "Notes/Complete wiki bang.md",
        content: ["![[asset]]", "", `[asset]: ${target}`].join("\n"),
      },
      {
        path: "Notes/Complete wiki two-backslash.md",
        content: ["\\\\[[asset]]", "", `[asset]: ${target}`].join("\n"),
      },
    ];
    await Promise.all([
      ...sourceNotes.map((note) =>
        fs.writeFile(path.join(vaultPath, note.path), note.content, "utf8"),
      ),
      ...dormantNotes.map((note) =>
        fs.writeFile(path.join(vaultPath, note.path), note.content, "utf8"),
      ),
    ]);
    for (const note of sourceNotes) {
      expect(renderer.render(note.content), note.name).toContain(`href="${target}"`);
      expect(
        parseMarkdownReferenceUsages(note.content).some((usage) => usage.sourceMappable === false),
        note.name,
      ).toBe(true);
    }
    for (const note of dormantNotes) {
      if (note.path.includes("Complete wiki")) {
        expect(parseMarkdownReferenceUsages(note.content), note.path).toEqual([]);
      } else {
        expect(renderer.render(note.content), note.path).toContain("href=");
        expect(
          parseMarkdownReferenceUsages(note.content).some(
            (usage) => usage.sourceMappable === false,
          ),
          note.path,
        ).toBe(true);
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected renderer-evidence source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/unmatched-wiki-evidence.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", rewrites: [], writes: [] });
    if (plan.status !== "planned") throw new Error("Expected renderer-evidence planner output.");
    for (const note of sourceNotes) {
      expect(plan.blockers, note.name).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ documentPath: note.path, reason: "unsupported" }),
        ]),
      );
    }
    for (const note of dormantNotes) {
      expect(
        plan.blockers.some((blocker) => blocker.documentPath === note.path),
        note.path,
      ).toBe(false);
      expect(
        plan.rewrites.some((rewrite) => rewrite.documentPath === note.path),
        note.path,
      ).toBe(false);
      expect(
        plan.writes.some((write) => write.path === note.path),
        note.path,
      ).toBe(false);
    }
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/unmatched-wiki-evidence.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    for (const note of [...sourceNotes, ...dormantNotes]) {
      await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(
        note.content,
      );
    }
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "unmatched-wiki-evidence.pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps independently parsed missing references from becoming unmappable evidence", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notePath = "Notes/Independent missing reference.md";
    const before = ["[missing] [asset]", "", "[asset]: ../Assets/report.pdf"].join("\n");
    const after = ["[missing] [asset]", "", "[asset]: ../Archive/independent-reference.pdf"].join(
      "\n",
    );
    await fs.writeFile(path.join(vaultPath, notePath), before, "utf8");
    expect(
      parseMarkdownReferenceUsages(before).filter((usage) => usage.sourceMappable === false),
    ).toEqual([]);
    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready")
      throw new Error("Expected independent-reference source fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/independent-reference.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned", blockers: [] });
    if (plan.status !== "planned")
      throw new Error("Expected independent-reference planner output.");
    expect(plan.writes).toContainEqual(expect.objectContaining({ path: notePath, content: after }));
  });

  it("blocks source-only attachment definitions inside renderer-recognized trimmed frontmatter", async () => {
    await fs.writeFile(path.join(vaultPath, "Assets", "report.pdf"), pdfBytes);
    const notes: Array<{ path: string; content: string }> = [];
    for (const ending of ["\n", "\r\n", "\r"] as const) {
      for (const [opener, closer] of [
        ["\uFEFF \t--- \t", "\t...\t"],
        ["---", "    ---"],
      ] as const) {
        const name = `${closer.includes(".") ? "dots" : "spaces"}-${
          ending === "\n" ? "lf" : ending === "\r\n" ? "crlf" : "cr"
        }`;
        const content = [opener, "[asset]: ../Assets/report.pdf", closer, "[visible][asset]"].join(
          ending,
        );
        const note = { path: `Notes/Source-only frontmatter ${name}.md`, content };
        notes.push(note);
        await fs.writeFile(path.join(vaultPath, note.path), content, "utf8");
      }
    }

    const source = await kernel.readBinary("Assets/report.pdf", Number.MAX_SAFE_INTEGER);
    if (source.status !== "ready") throw new Error("Expected source-only frontmatter fixture.");
    const plan = await planBinaryAttachmentMove(
      kernel,
      "Assets/report.pdf",
      "Archive/source-only-frontmatter.pdf",
      source.snapshot.revision,
    );

    expect(plan).toMatchObject({ status: "planned" });
    if (plan.status !== "planned") throw new Error("Expected source-only frontmatter plan.");
    expect(plan.blockers).toHaveLength(6);
    expect(plan.writes).toEqual([]);
    await expect(
      moveBinaryAttachment(
        kernel,
        "Assets/report.pdf",
        "Archive/source-only-frontmatter.pdf",
        source.snapshot.revision,
        { plan, acceptCurrentRewrites: true },
      ),
    ).resolves.toMatchObject({ status: "blocked" });
    await expect(fs.readFile(path.join(vaultPath, "Assets", "report.pdf"))).resolves.toEqual(
      pdfBytes,
    );
    await expect(
      fs.stat(path.join(vaultPath, "Archive", "source-only-frontmatter.pdf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const note of notes) {
      await expect(fs.readFile(path.join(vaultPath, note.path), "utf8")).resolves.toBe(
        note.content,
      );
    }
  });
});
