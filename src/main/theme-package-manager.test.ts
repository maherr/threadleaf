import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearanceCss } from "../renderer/appearance-renderer";
import { createDefaultVaultAppearance } from "../shared/appearance";
import {
  inspectAppearancePackageArchive,
  MemoryAppearancePackageSource,
  readLocalAppearancePackage,
} from "./open-theme-package-source";
import { ThemePackageManager } from "./theme-package-manager";
import { loadVaultAppearance } from "./vault-appearance-loader";
import { VaultAppearanceWatcher } from "./vault-appearance-watcher";

const vaultId = "a".repeat(64);
const themeId = "fixture-theme";
const snippetId = "fixture-snippet";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  externalAttributes?: number;
}

function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const bytes = Buffer.from(entry.bytes);
    const compressed = deflateRawSync(bytes);
    const crc = crc32(bytes);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 10);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(Buffer.concat([header, compressed]));

    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(0, 12);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((entry.externalAttributes ?? 0) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function appearanceArchive(
  kind: "theme" | "snippet",
  packageId: string,
  version: string,
  stylesheet = `:root { --fixture-version: ${JSON.stringify(version)}; }\n`,
  extra: ZipEntry[] = [],
): Buffer {
  const manifest = Buffer.from(
    JSON.stringify({
      id: packageId,
      kind,
      name: `${packageId} ${version}`,
      version,
      description: "A deterministic fixture appearance package.",
      repository: "fixture-owner/fixture-appearance",
      license: {
        name: "MIT License",
        spdxId: "MIT",
        sourceUrl: `https://example.test/${version}/LICENSE`,
      },
    }),
    "utf8",
  );
  const stylesheetName = kind === "theme" ? "theme.css" : "styles.css";
  return zip([
    { name: "manifest.json", bytes: manifest },
    { name: stylesheetName, bytes: Buffer.from(stylesheet, "utf8") },
    { name: "LICENSE", bytes: Buffer.from(`MIT ${version}\n`, "utf8") },
    { name: "README.md", bytes: Buffer.from(`# ${packageId}\n`, "utf8") },
    ...extra,
  ]);
}

function packageFor(
  kind: "theme" | "snippet",
  packageId: string,
  version: string,
  stylesheet?: string,
) {
  const archive = appearanceArchive(kind, packageId, version, stylesheet);
  return inspectAppearancePackageArchive(kind, packageId, archive, {
    source: "bundled",
    locator: `fixture://${kind}/${packageId}/${version}`,
    sourceSha256: digest(archive),
  });
}

function themePath(...parts: string[]): string {
  return path.join(vaultPath, ".obsidian", "themes", themeId, ...parts);
}

function snippetPath(): string {
  return path.join(vaultPath, ".obsidian", "snippets", `${snippetId}.css`);
}

async function atomicSave(filePath: string, bytes: string): Promise<void> {
  const temporaryPath = `${filePath}.external-save`;
  await fs.writeFile(temporaryPath, bytes, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function openManager(
  packages = [packageFor("theme", themeId, "1.0.0"), packageFor("snippet", snippetId, "1.0.0")],
  hooks: ConstructorParameters<typeof ThemePackageManager>[3] = {},
): Promise<ThemePackageManager> {
  const manager = new ThemePackageManager(
    statePath,
    new MemoryAppearancePackageSource(packages),
    () => new Date("2026-08-12T16:00:00.000Z"),
    hooks,
  );
  await manager.initialize();
  return manager;
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-appearance-package-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("appearance package archive inspection", () => {
  it("reports exact assets, stylesheet, license, README, and provenance", () => {
    const pkg = packageFor("theme", themeId, "1.0.0");
    expect(pkg.archiveSha256).toBe(digest(pkg.archive));
    expect(pkg.stylesheetFilename).toBe("theme.css");
    expect(pkg.css).toMatchObject({ valid: true, externalUrlCount: 0 });
    expect(pkg.license).toMatchObject({ filename: "LICENSE", spdxId: "MIT" });
    expect(pkg.readme).toMatchObject({ filename: "README.md" });
    expect(pkg.provenance).toEqual({
      source: "bundled",
      locator: "fixture://theme/fixture-theme/1.0.0",
      sourceSha256: pkg.archiveSha256,
    });
  });

  it("opens a user-selected archive as an offline exact package", async () => {
    const archivePath = path.join(sandboxPath, "local-theme.zip");
    await fs.writeFile(archivePath, appearanceArchive("theme", themeId, "1.0.0"));

    const pkg = await readLocalAppearancePackage(archivePath, "theme");

    expect(pkg.provenance.source).toBe("local");
    expect(pkg.provenance.locator).toBe("local-theme.zip");
    expect(pkg.packageId).toBe(themeId);
    expect(pkg.manifest.version).toBe("1.0.0");
  });

  it.each([
    ["path traversal", [{ name: "../escape.css", bytes: Buffer.from("x") }]],
    ["absolute path", [{ name: "/escape.css", bytes: Buffer.from("x") }]],
    ["duplicate name", [{ name: "theme.css", bytes: Buffer.from("x") }]],
    ["case collision", [{ name: "Theme.css", bytes: Buffer.from("x") }]],
  ])("rejects %s archive entries", (_label, extra) => {
    const archive = appearanceArchive("theme", themeId, "1.0.0", undefined, extra as ZipEntry[]);
    if (_label === "duplicate name" || _label === "case collision") {
      expect(() => inspectAppearancePackageArchive("theme", themeId, archive)).toThrow(
        /case-colliding/iu,
      );
    } else {
      expect(() => inspectAppearancePackageArchive("theme", themeId, archive)).toThrow(
        /unsafe archive path/iu,
      );
    }
  });

  it("rejects ZIP symlinks and CSS network URLs before a review exists", () => {
    const symlinkArchive = appearanceArchive("theme", themeId, "1.0.0", undefined, [
      {
        name: "link.css",
        bytes: Buffer.from("theme.css", "utf8"),
        externalAttributes: 0o120777 << 16,
      },
    ]);
    expect(() => inspectAppearancePackageArchive("theme", themeId, symlinkArchive)).toThrow(
      /symlink/iu,
    );

    const unsafeCss = appearanceArchive(
      "theme",
      themeId,
      "1.0.0",
      `@font-face { src: url("https://example.test/font.woff2"); }\n`,
    );
    expect(() => inspectAppearancePackageArchive("theme", themeId, unsafeCss)).toThrow(
      /not safe|external URLs/iu,
    );
  });
});

describe("theme and snippet package manager", () => {
  it("does not replace a snippet created after the final missing-target check", async () => {
    const manager = await openManager([packageFor("snippet", snippetId, "1.0.0")]);
    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "snippet",
      packageId: snippetId,
    });
    const realLink = fs.link.bind(fs);
    let injected = false;
    const link = vi.spyOn(fs, "link").mockImplementation(async (sourcePath, targetPath) => {
      if (!injected && String(targetPath) === snippetPath()) {
        injected = true;
        await fs.writeFile(snippetPath(), "external concurrent file\n", "utf8");
      }
      return realLink(sourcePath, targetPath);
    });

    try {
      await expect(manager.apply(vaultPath, vaultId, review.reviewId)).rejects.toThrow(
        "target appeared after review",
      );
    } finally {
      link.mockRestore();
    }

    expect(await fs.readFile(snippetPath(), "utf8")).toBe("external concurrent file\n");
  });

  it("does not replace a snippet created after the reviewed target moves to rollback", async () => {
    const manager = await openManager([
      packageFor("snippet", snippetId, "1.0.0"),
      packageFor("snippet", snippetId, "2.0.0"),
    ]);
    const install = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "snippet",
      packageId: snippetId,
      version: "1.0.0",
    });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    const update = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "snippet",
      packageId: snippetId,
      version: "2.0.0",
    });
    const realLink = fs.link.bind(fs);
    let injected = false;
    const link = vi.spyOn(fs, "link").mockImplementation(async (sourcePath, targetPath) => {
      if (
        !injected &&
        String(targetPath) === snippetPath() &&
        path.basename(String(sourcePath)).startsWith(".threadleaf-appearance-stage-")
      ) {
        injected = true;
        await fs.writeFile(snippetPath(), "external concurrent file\n", "utf8");
      }
      return realLink(sourcePath, targetPath);
    });

    try {
      await expect(manager.apply(vaultPath, vaultId, update.reviewId)).rejects.toThrow(
        "target appeared during installation",
      );
    } finally {
      link.mockRestore();
    }

    expect(await fs.readFile(snippetPath(), "utf8")).toBe("external concurrent file\n");
  });

  it("keeps preview isolated and installs a theme without changing private selection", async () => {
    const manager = await openManager();
    const unrelatedSettings = Buffer.from('{"workspace":"keep"}\n', "utf8");
    const unrelatedPlugin = Buffer.from("plugin bytes stay untouched\n", "utf8");
    await fs.mkdir(path.join(vaultPath, ".obsidian", "plugins", "fixture"), {
      recursive: true,
    });
    await fs.writeFile(path.join(vaultPath, ".obsidian", "app.json"), unrelatedSettings);
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "plugins", "fixture", "main.js"),
      unrelatedPlugin,
    );
    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
    });

    expect(review).toMatchObject({
      operation: "install",
      targetPath: ".obsidian/themes/fixture-theme",
      targetVersion: "1.0.0",
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      provenance: { source: "bundled" },
      license: { spdxId: "MIT" },
      readme: { filename: "README.md" },
      css: { valid: true },
    });
    await expect(fs.stat(themePath())).rejects.toMatchObject({ code: "ENOENT" });
    expect(await manager.getManagedPackages(vaultPath, vaultId)).toEqual([]);

    const outcome = await manager.apply(vaultPath, vaultId, review.reviewId);
    expect(outcome).toMatchObject({
      operation: "install",
      kind: "theme",
      packageId: themeId,
      version: "1.0.0",
      selectionUnchanged: true,
    });
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("1.0.0");
    expect(await fs.readFile(themePath("manifest.json"), "utf8")).toContain(themeId);
    expect(await fs.readFile(path.join(vaultPath, ".obsidian", "app.json"))).toEqual(
      unrelatedSettings,
    );
    expect(
      await fs.readFile(path.join(vaultPath, ".obsidian", "plugins", "fixture", "main.js")),
    ).toEqual(unrelatedPlugin);
    await expect(fs.stat(themePath(".threadleaf-appearance.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "1.0.0",
      integrity: "verified",
      history: [],
    });
  });

  it("stages a local archive for exact review before any vault mutation", async () => {
    const archivePath = path.join(sandboxPath, "offline-theme.zip");
    await fs.writeFile(archivePath, appearanceArchive("theme", themeId, "1.0.0"));
    const pkg = await readLocalAppearancePackage(archivePath, "theme");
    const manager = await openManager([]);

    const review = await manager.previewLocal(vaultPath, vaultId, pkg);

    expect(review.provenance).toMatchObject({ source: "local", locator: "offline-theme.zip" });
    expect(review.archiveSha256).toBe(pkg.archiveSha256);
    await expect(fs.stat(themePath())).rejects.toMatchObject({ code: "ENOENT" });
    await manager.apply(vaultPath, vaultId, review.reviewId);
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("1.0.0");
  });

  it("installs a snippet as one CSS file and does not copy package metadata into the vault", async () => {
    const manager = await openManager();
    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "snippet",
      packageId: snippetId,
    });
    await manager.apply(vaultPath, vaultId, review.reviewId);

    expect(await fs.readFile(snippetPath(), "utf8")).toContain("1.0.0");
    const entries = await fs.readdir(path.dirname(snippetPath()));
    expect(entries).toEqual([`${snippetId}.css`]);
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      kind: "snippet",
      integrity: "verified",
    });
  });

  it("refuses to apply a review under a different vault identity", async () => {
    const manager = await openManager();
    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
    });
    const otherVaultId = "b".repeat(64);

    expect(() => manager.reviewForApply(otherVaultId, review.reviewId)).toThrow(
      /missing, expired, or belongs to another vault/iu,
    );
    await expect(manager.apply(vaultPath, otherVaultId, review.reviewId)).rejects.toThrow(
      /missing, expired, or belongs to another vault/iu,
    );
    await expect(fs.stat(themePath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unmanaged theme bytes across update and rolls exact package bytes back", async () => {
    const v1 = packageFor("theme", themeId, "1.0.0");
    const v2 = packageFor("theme", themeId, "2.0.0");
    const manager = await openManager([v1, v2]);
    const install = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
      version: "1.0.0",
    });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(themePath("user-data.json"), '{"keep":true}\n', "utf8");

    const update = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
      version: "2.0.0",
    });
    expect(update.operation).toBe("update");
    await manager.apply(vaultPath, vaultId, update.reviewId);
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("2.0.0");
    expect(await fs.readFile(themePath("user-data.json"), "utf8")).toContain("keep");
    await fs.writeFile(
      themePath("added-after-update.json"),
      '{"keepAfterRollback":true}\n',
      "utf8",
    );

    const rollback = await manager.preview(vaultPath, vaultId, {
      action: "rollback",
      kind: "theme",
      packageId: themeId,
    });
    expect(rollback.targetVersion).toBe("1.0.0");
    await manager.apply(vaultPath, vaultId, rollback.reviewId);
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("1.0.0");
    expect(await fs.readFile(themePath("user-data.json"), "utf8")).toContain("keep");
    expect(await fs.readFile(themePath("added-after-update.json"), "utf8")).toContain(
      "keepAfterRollback",
    );
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "1.0.0",
      integrity: "verified",
      history: [{ version: "2.0.0", reason: "rollback" }, { version: "1.0.0" }],
    });
  });

  it("uninstalls a fresh install through review and restores its retained bytes", async () => {
    const manager = await openManager();
    const install = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "snippet",
      packageId: snippetId,
    });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(snippetPath(), ":root { --local-edit: 1; }\n", "utf8");

    const uninstall = await manager.preview(vaultPath, vaultId, {
      action: "uninstall",
      kind: "snippet",
      packageId: snippetId,
    });
    expect(uninstall.operation).toBe("uninstall");
    await manager.apply(vaultPath, vaultId, uninstall.reviewId);
    await expect(fs.stat(snippetPath())).rejects.toMatchObject({ code: "ENOENT" });

    const restore = await manager.preview(vaultPath, vaultId, {
      action: "restore",
      kind: "snippet",
      packageId: snippetId,
    });
    expect(restore.operation).toBe("restore");
    await manager.apply(vaultPath, vaultId, restore.reviewId);
    expect(await fs.readFile(snippetPath(), "utf8")).toContain("local-edit");
  });

  it("restores an unmanaged snippet with a stable stylesheet receipt", async () => {
    const original = ":root { --unmanaged: true; }\n";
    await fs.mkdir(path.dirname(snippetPath()), { recursive: true });
    await fs.writeFile(snippetPath(), original, "utf8");
    const manager = await openManager();

    const uninstall = await manager.preview(vaultPath, vaultId, {
      action: "uninstall",
      kind: "snippet",
      packageId: snippetId,
    });
    await manager.apply(vaultPath, vaultId, uninstall.reviewId);
    const restore = await manager.preview(vaultPath, vaultId, {
      action: "restore",
      kind: "snippet",
      packageId: snippetId,
    });
    await manager.apply(vaultPath, vaultId, restore.reviewId);
    expect(await fs.readFile(snippetPath(), "utf8")).toBe(original);
    expect((await manager.getManagedPackages(vaultPath, vaultId))[0]).toMatchObject({
      currentVersion: "unknown",
      integrity: "verified",
    });
  });

  it("rejects external atomic edits after review without clobbering them", async () => {
    const v1 = packageFor("theme", themeId, "1.0.0");
    const v2 = packageFor("theme", themeId, "2.0.0");
    const manager = await openManager([v1, v2]);
    const install = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
      version: "1.0.0",
    });
    await manager.apply(vaultPath, vaultId, install.reviewId);
    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
      version: "2.0.0",
    });
    await atomicSave(themePath("theme.css"), ":root { --external-save: true; }\n");
    await expect(manager.apply(vaultPath, vaultId, review.reviewId)).rejects.toThrow(
      /changed after review/iu,
    );
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("external-save");
  });

  it("recovers an interrupted install and preserves an external edit seen during recovery", async () => {
    let armed = false;
    let resolveReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve;
    });
    const stopped = new Promise<void>(() => undefined);
    const manager = await openManager(undefined, {
      afterTransactionPhase: async (phase) => {
        if (armed && phase === "package-mutated") {
          resolveReached?.();
          await stopped;
        }
      },
    });
    const review = await manager.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
    });
    armed = true;
    void manager.apply(vaultPath, vaultId, review.reviewId);
    await reached;
    await fs.writeFile(themePath("external.txt"), "keep external", "utf8");

    const recovered = await openManager();
    await expect(recovered.getManagedPackages(vaultPath, vaultId)).resolves.toEqual([]);
    expect(await fs.readFile(themePath("external.txt"), "utf8")).toBe("keep external");
    expect(recovered.takeRecoveryNotices(vaultId).join(" ")).toMatch(/preserved/iu);
  });

  it("recovers an interrupted update to the prior exact bytes", async () => {
    const v1 = packageFor("theme", themeId, "1.0.0");
    const v2 = packageFor("theme", themeId, "2.0.0");
    const initial = await openManager([v1, v2]);
    const install = await initial.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
      version: "1.0.0",
    });
    await initial.apply(vaultPath, vaultId, install.reviewId);
    await fs.writeFile(themePath("user-data.json"), "preserve", "utf8");

    let armed = false;
    let resolveReached: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      resolveReached = resolve;
    });
    const stopped = new Promise<void>(() => undefined);
    const interrupted = await openManager([v1, v2], {
      afterTransactionPhase: async (phase) => {
        if (armed && phase === "package-mutated") {
          resolveReached?.();
          await stopped;
        }
      },
    });
    const update = await interrupted.preview(vaultPath, vaultId, {
      action: "install",
      kind: "theme",
      packageId: themeId,
      version: "2.0.0",
    });
    armed = true;
    void interrupted.apply(vaultPath, vaultId, update.reviewId);
    await reached;
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("2.0.0");

    const recovered = await openManager([v1, v2]);
    await recovered.getManagedPackages(vaultPath, vaultId);
    expect(await fs.readFile(themePath("theme.css"), "utf8")).toContain("1.0.0");
    expect(await fs.readFile(themePath("user-data.json"), "utf8")).toBe("preserve");
  });

  it("does not discard vault evidence when an interrupted transaction has no journal", async () => {
    const transactionId = "12345678-1234-4123-8123-123456789abc";
    const transactionPath = path.join(statePath, "transactions", vaultId, transactionId);
    await fs.mkdir(transactionPath, { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".obsidian", "themes"), { recursive: true });
    const rollback = path.join(
      vaultPath,
      ".obsidian",
      "themes",
      `.threadleaf-appearance-rollback-${transactionId}`,
    );
    await fs.mkdir(rollback);
    const manager = await openManager();

    await expect(manager.getManagedPackages(vaultPath, vaultId)).rejects.toThrow(
      /missing its journal but found vault transaction evidence/iu,
    );
    expect(await fs.stat(transactionPath)).toBeDefined();
    expect(await fs.stat(rollback)).toBeDefined();
  });
});

describe("appearance package desktop cascade", () => {
  it("routes installed CSS through the watcher and renderer in theme-before-snippet order", async () => {
    await fs.mkdir(path.join(vaultPath, ".obsidian", "themes"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, ".obsidian", "snippets"), { recursive: true });
    const v1 = packageFor("theme", themeId, "1.0.0");
    const v2 = packageFor("theme", themeId, "2.0.0");
    const snippet = packageFor("snippet", snippetId, "1.0.0");
    const manager = await openManager([v1, v2, snippet]);
    const preference = {
      ...createDefaultVaultAppearance(),
      themeId: `obsidian-theme:${themeId}`,
      enabledSnippetIds: [`obsidian-snippet:${snippetId}.css`],
    };
    const styleTarget: { textContent: string | null } = { textContent: null };
    const invalidations: string[] = [];
    const watcher = await VaultAppearanceWatcher.open({
      vaultPath,
      debounceMs: 10,
      onInvalidation: async ({ reason }) => {
        invalidations.push(reason);
        const snapshot = await loadVaultAppearance({
          vaultPath,
          vaultId,
          preference,
          safeMode: false,
        });
        applyAppearanceCss(styleTarget, snapshot.css);
      },
    });

    const waitForStyle = async (expected: string, absent?: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        await watcher.whenIdle();
        if (
          styleTarget.textContent?.includes(expected) &&
          !styleTarget.textContent.includes(absent ?? "\u0000")
        ) {
          return;
        }
      }
      throw new Error(`Timed out waiting for appearance CSS: ${expected}`);
    };

    try {
      const installTheme = await manager.preview(vaultPath, vaultId, {
        action: "install",
        kind: "theme",
        packageId: themeId,
        version: "1.0.0",
      });
      await manager.apply(vaultPath, vaultId, installTheme.reviewId);
      const installSnippet = await manager.preview(vaultPath, vaultId, {
        action: "install",
        kind: "snippet",
        packageId: snippetId,
        version: "1.0.0",
      });
      await manager.apply(vaultPath, vaultId, installSnippet.reviewId);
      await waitForStyle('--fixture-version: "1.0.0";');
      const installedCss = styleTarget.textContent ?? "";
      expect(installedCss.indexOf("Threadleaf appearance: theme")).toBeGreaterThanOrEqual(0);
      expect(installedCss.indexOf("Threadleaf appearance: snippet")).toBeGreaterThan(
        installedCss.indexOf("Threadleaf appearance: theme"),
      );

      const update = await manager.preview(vaultPath, vaultId, {
        action: "install",
        kind: "theme",
        packageId: themeId,
        version: "2.0.0",
      });
      await manager.apply(vaultPath, vaultId, update.reviewId);
      await waitForStyle('--fixture-version: "2.0.0";');
      expect(styleTarget.textContent?.indexOf("Threadleaf appearance: snippet")).toBeGreaterThan(
        styleTarget.textContent?.indexOf("Threadleaf appearance: theme") ?? -1,
      );

      const rollback = await manager.preview(vaultPath, vaultId, {
        action: "rollback",
        kind: "theme",
        packageId: themeId,
      });
      await manager.apply(vaultPath, vaultId, rollback.reviewId);
      await waitForStyle('--fixture-version: "1.0.0";');

      const uninstall = await manager.preview(vaultPath, vaultId, {
        action: "uninstall",
        kind: "snippet",
        packageId: snippetId,
      });
      await manager.apply(vaultPath, vaultId, uninstall.reviewId);
      await waitForStyle("Threadleaf appearance: theme", "Threadleaf appearance: snippet");
      expect(styleTarget.textContent).not.toContain("Threadleaf appearance: snippet");
      expect(invalidations.length).toBeGreaterThan(0);
    } finally {
      await watcher.close();
    }
  });
});
