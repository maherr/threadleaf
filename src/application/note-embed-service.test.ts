import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetadataIndex } from "../kernel/metadata-index";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  extractVaultNoteEmbed,
  loadVaultNoteEmbed,
  resolveVaultNoteEmbedTarget,
} from "./note-embed-service";

let sandboxPath: string;
let vaultPath: string;
let kernel: VaultKernel;

async function write(relativePath: string, content: string | Uint8Array): Promise<void> {
  const absolutePath = path.join(vaultPath, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

async function documents() {
  return (await MetadataIndex.build(kernel)).snapshot().documents;
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-note-embeds-"));
  vaultPath = path.join(sandboxPath, "vault");
  await write("Notes/Current.md", "# Current\n\n![[Target#Section]]\n");
  await write(
    "Notes/Target.md",
    [
      "# Target",
      "",
      "Intro with [[Other]].",
      "",
      "## Section",
      "",
      "Section paragraph with ![[Nested]].",
      "",
      "### Child",
      "",
      "Child text.",
      "",
      "## Later",
      "",
      "Later text.",
      "",
      "A standalone block. ^block-one",
      "",
      "```md",
      "This is not a block. ^hidden",
      "```",
      "",
    ].join("\n"),
  );
  await write("Notes/Other.md", "# Other\n");
  await write("Notes/Nested.md", "# Nested\n");
  kernel = await VaultKernel.open({
    vaultRoot: vaultPath,
    stateRoot: new FixedStateRoot(path.join(sandboxPath, "state")),
  });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("note embed target resolution", () => {
  it("resolves relative, extensionless, case-insensitive, and same-note targets", async () => {
    const indexed = await documents();

    expect(resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "target")).toMatchObject({
      path: "Notes/Target.md",
    });
    expect(resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "Target.md")).toMatchObject({
      path: "Notes/Target.md",
    });
    expect(resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "")).toMatchObject({
      path: "Notes/Current.md",
    });
  });

  it("rejects external, malformed, missing, private, and ambiguous targets", async () => {
    await write("Other/Target.md", "# Duplicate\n");
    const indexed = await documents();

    expect(
      resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "https://example.com/a.md"),
    ).toMatchObject({ reason: "external" });
    expect(resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "%E0%A4%A")).toMatchObject({
      reason: "invalid",
    });
    expect(resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "Missing")).toMatchObject({
      reason: "missing",
    });
    expect(
      resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "/.obsidian/a.md"),
    ).toMatchObject({ reason: "missing" });
    expect(resolveVaultNoteEmbedTarget(indexed, "Notes/Current.md", "/Target")).toMatchObject({
      reason: "ambiguous",
    });
  });
});

describe("note embed subpath extraction", () => {
  it("extracts a heading through its descendants and stops at the next peer", () => {
    const source = [
      "# One",
      "Before",
      "## Section",
      "Body",
      "### Child",
      "Child body",
      "## Later",
      "After",
    ].join("\r\n");

    expect(extractVaultNoteEmbed(source, "#section")).toEqual({
      content: ["## Section", "Body", "### Child", "Child body"].join("\r\n"),
      startLine: 3,
      endLine: 6,
      kind: "heading",
      subpath: "#section",
    });
  });

  it("extracts one Markdown block and removes only its block marker", () => {
    expect(
      extractVaultNoteEmbed("Before\n\nA standalone block. ^block-one\n\nAfter", "^block-one"),
    ).toEqual({
      content: "A standalone block.",
      startLine: 3,
      endLine: 3,
      kind: "block",
      subpath: "^block-one",
    });
  });

  it("does not treat code or comments as headings or block identifiers", () => {
    expect(() => extractVaultNoteEmbed("```\n# Hidden\nText ^hidden\n```", "#Hidden")).toThrow(
      "missing-subpath",
    );
    expect(() => extractVaultNoteEmbed("<!-- Text ^hidden -->", "^hidden")).toThrow(
      "missing-subpath",
    );
  });
});

describe("vault note embed loading", () => {
  it("returns bounded UTF-8 content, line provenance, and resolved nested links", async () => {
    const response = await loadVaultNoteEmbed(
      kernel,
      await documents(),
      "Notes/Current.md",
      "Target",
      "#Section",
      kernel.vaultId,
    );

    expect(response).toMatchObject({
      status: "ready",
      vaultId: kernel.vaultId,
      path: "Notes/Target.md",
      kind: "heading",
      subpath: "#Section",
      startLine: 5,
      endLine: 11,
    });
    if (response.status === "ready") {
      expect(response.content).toContain("## Section");
      expect(response.content).toContain("### Child");
      expect(response.content).not.toContain("## Later");
      expect(response.contentBytes).toBe(Buffer.byteLength(response.content));
      expect(response.sourceSize).toBeGreaterThan(response.contentBytes);
      expect(response.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(response.links).toEqual([
        expect.objectContaining({
          embed: true,
          path: "Notes/Nested.md",
          status: "resolved",
          target: "Nested",
        }),
      ]);
    }
  });

  it("loads same-note subpaths and standalone block identifiers", async () => {
    await write("Notes/Current.md", "# Current\n\nLocal text. ^local\n");
    const response = await loadVaultNoteEmbed(
      kernel,
      await documents(),
      "Notes/Current.md",
      "",
      "^local",
      kernel.vaultId,
    );

    expect(response).toMatchObject({
      status: "ready",
      path: "Notes/Current.md",
      kind: "block",
      content: "Local text.",
      startLine: 3,
      endLine: 3,
    });
  });

  it("fails closed for stale identities, absent subpaths, oversize files, and invalid UTF-8", async () => {
    const indexed = await documents();
    await expect(
      loadVaultNoteEmbed(kernel, indexed, "Notes/Current.md", "Target", null, "stale-vault"),
    ).resolves.toEqual({ status: "stale-vault", vaultId: kernel.vaultId });
    await expect(
      loadVaultNoteEmbed(kernel, indexed, "Notes/Current.md", "Target", "#Absent", kernel.vaultId),
    ).resolves.toMatchObject({ status: "unavailable", reason: "subpath-missing" });
    await expect(
      loadVaultNoteEmbed(kernel, indexed, "Notes/Current.md", "Target", null, kernel.vaultId, {
        maxBytes: 8,
      }),
    ).resolves.toMatchObject({ status: "unavailable", reason: "too-large" });

    await write("Notes/Invalid.md", Uint8Array.from([0xc3, 0x28]));
    const indexedWithInvalid = [
      ...indexed,
      {
        path: "Notes/Invalid.md",
        revision: "0".repeat(64),
        headings: [],
        tags: [],
        tagCounts: {},
        properties: {},
        links: [],
      },
    ];
    await expect(
      loadVaultNoteEmbed(
        kernel,
        indexedWithInvalid,
        "Notes/Current.md",
        "Invalid",
        null,
        kernel.vaultId,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "invalid" });
  });

  it("accepts contained symlinks and rejects private or outside-vault symlink destinations", async () => {
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await write(".obsidian/private.md", "# Private\n");
    await write("Notes/Inside.md", "# Inside\n");
    const outsidePath = path.join(sandboxPath, "outside.md");
    await fs.writeFile(outsidePath, "# Outside\n", "utf8");
    await fs.symlink("Inside.md", path.join(vaultPath, "Notes", "Inside Link.md"));
    await fs.symlink("../.obsidian/private.md", path.join(vaultPath, "Notes", "Private Link.md"));
    await fs.symlink(outsidePath, path.join(vaultPath, "Notes", "Outside Link.md"));
    const indexed = await documents();
    const indexedWithRejectedLinks = [
      ...indexed,
      ...["Notes/Private Link.md", "Notes/Outside Link.md"].map((filePath) => ({
        path: filePath,
        revision: "0".repeat(64),
        headings: [],
        tags: [],
        tagCounts: {},
        properties: {},
        links: [],
      })),
    ];

    await expect(
      loadVaultNoteEmbed(kernel, indexed, "Notes/Current.md", "Inside Link", null, kernel.vaultId),
    ).resolves.toMatchObject({ status: "ready", path: "Notes/Inside Link.md" });
    await expect(
      loadVaultNoteEmbed(
        kernel,
        indexedWithRejectedLinks,
        "Notes/Current.md",
        "Private Link",
        null,
        kernel.vaultId,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "private" });
    await expect(
      loadVaultNoteEmbed(
        kernel,
        indexedWithRejectedLinks,
        "Notes/Current.md",
        "Outside Link",
        null,
        kernel.vaultId,
      ),
    ).resolves.toMatchObject({ status: "unavailable", reason: "outside-vault" });
  });
});
