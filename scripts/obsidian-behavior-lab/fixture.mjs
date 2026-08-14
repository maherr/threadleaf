import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

export const FIXTURE_ID = "obsidian-lab-vault-v1";
export const FIXTURE_SCHEMA_VERSION = 1;
export const FIXTURE_GENERATOR = "threadleaf-obsidian-behavior-lab-v1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const output = Buffer.alloc(4);
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return output;
}

function pngChunk(type, bytes) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, name, bytes, crc32(Buffer.concat([name, bytes]))]);
}

function fixturePng() {
  const width = 2;
  const height = 2;
  const pixels = [
    [0, 114, 178, 255],
    [230, 159, 0, 255],
    [0, 158, 115, 255],
    [92, 92, 92, 255],
  ];
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    raw[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixels[y * width + x];
      assert(pixel, "Generated PNG pixel is missing.");
      Buffer.from(pixel).copy(raw, rowOffset + 1 + x * 4);
    }
  }
  const header = Buffer.from("\x89PNG\r\n\x1a\n", "binary");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function probeSource() {
  return Buffer.from(
    [
      'const { Plugin, Notice } = require("obsidian");',
      "",
      "module.exports = class LabProbe extends Plugin {",
      "  async onload() {",
      '    this.addCommand({ id: "lab:record", name: "Record lab marker", callback: () => {',
      '      new Notice("LAB-PROBE-RECORD");',
      "    }});",
      "  }",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}

const fileDefinitions = [
  {
    path: "00 Overview.md",
    bytes: Buffer.from(
      [
        "---",
        'aliases: [Overview, "Vue générale"]',
        "tags:",
        "  - lab/overview",
        "  - #inline-tag",
        "---",
        "# Overview",
        "",
        "Resolved: [[Notes/Unicode|Unicode note]].",
        "Unresolved: [[Notes/Not Present]].",
        "Task: - [ ] Preserve the source bytes.",
        "> [!note] Callout",
        "> French accents: élève, déjà, Québec.",
        "> RTL sample: سلام بالعالم.",
        "> Emoji sequence: 👩‍🔬.",
        "",
        "```text",
        "[[Not A Link]] #not-a-tag",
        "```",
        "",
        "External: https://example.invalid/lab (must remain inert).",
        "",
      ].join("\n"),
      "utf8",
    ),
  },
  {
    path: "Notes/CRLF.md",
    bytes: Buffer.from(
      "\ufeff---\r\ntitle: CRLF fixture\r\ntags: [lab/crlf]\r\n---\r\n# CRLF\r\n\r\nKeep BOM and CRLF bytes.\r\n",
      "utf8",
    ),
  },
  {
    path: "Notes/Unicode.md",
    bytes: Buffer.from(
      [
        "# Unicode fixture",
        "",
        "Composed: café.",
        "Decomposed: cafe\u0301.",
        "Leading dash and spaces are separate path fixtures.",
        "Unbreakable URL: https://example.invalid/segment/with/a/long/path.",
        "Quotes: \"double\" and 'single'.",
        "",
      ].join("\n"),
      "utf8",
    ),
  },
  {
    path: "Notes/Dirty.md",
    bytes: Buffer.from("# Dirty fixture\n\nBASE-DIRTY-1\n", "utf8"),
  },
  {
    path: "Notes/Rename Source.md",
    bytes: Buffer.from(
      [
        "# Rename Source",
        "",
        "Wiki: [[Notes/Unicode#Unicode fixture|alias]].",
        'Markdown: [Unicode](Unicode.md#Unicode-fixture "label").',
        "Ambiguous: [[Duplicate]].",
        "",
      ].join("\n"),
      "utf8",
    ),
  },
  {
    path: "Notes/Linker.md",
    bytes: Buffer.from(
      "# Linker\n\n[[Notes/Rename Source]]\n[Source](Rename%20Source.md)\n",
      "utf8",
    ),
  },
  {
    path: "Notes/Leading - dash.md",
    bytes: Buffer.from("# Leading dash\n\nA path with a leading-dash neighbor.\n", "utf8"),
  },
  {
    path: "Notes/Duplicate.md",
    bytes: Buffer.from("# Duplicate\n\nOne candidate for ambiguity.\n", "utf8"),
  },
  {
    path: "Other/Duplicate.md",
    bytes: Buffer.from("# Duplicate\n\nA second candidate for ambiguity.\n", "utf8"),
  },
  {
    path: "Templates/Daily.md",
    bytes: Buffer.from("---\ntemplate: lab\n---\n# {{title}}\n\n{{date}} {{time}}\n", "utf8"),
  },
  { path: "Attachments/pixel.png", bytes: fixturePng() },
  {
    path: ".obsidian/community-plugins.json",
    bytes: stableJson(["lab-probe"]),
  },
  {
    path: ".obsidian/appearance.json",
    bytes: stableJson({ theme: "obsidian", cssTheme: "", accentColor: "" }),
  },
  {
    path: ".obsidian/hotkeys.json",
    bytes: stableJson({}),
  },
  {
    path: ".obsidian/workspace.json",
    bytes: stableJson({ main: {}, left: {}, right: {}, active: "" }),
  },
  {
    path: ".obsidian/plugins/lab-probe/manifest.json",
    bytes: stableJson({
      id: "lab-probe",
      name: "Threadleaf Lab Probe",
      version: "1.0.0",
      minAppVersion: "1.0.0",
      isDesktopOnly: true,
    }),
  },
  { path: ".obsidian/plugins/lab-probe/main.js", bytes: probeSource() },
  {
    path: ".obsidian/plugins/lab-probe/styles.css",
    bytes: Buffer.from(
      ".lab-probe-marker { color: #0072b2; border: 1px solid currentColor; }\n",
      "utf8",
    ),
  },
  {
    path: ".obsidian/themes/Lab Theme/manifest.json",
    bytes: stableJson({ name: "Lab Theme", version: "1.0.0", author: "Threadleaf lab" }),
  },
  {
    path: ".obsidian/themes/Lab Theme/theme.css",
    bytes: Buffer.from(":root { --lab-ink: #0072b2; --lab-brass: #e69f00; }\n", "utf8"),
  },
  {
    path: ".obsidian/snippets/lab-snippet.css",
    bytes: Buffer.from(".lab-snippet-marker { outline: 2px solid #009e73; }\n", "utf8"),
  },
];

function modeFromStat(stat) {
  return stat.mode & 0o777;
}

function treeHash(entries) {
  const lines = entries
    .map(
      (entry) =>
        `${entry.kind}\0${entry.path}\0${entry.bytes}\0${entry.sha256 ?? ""}\0${entry.mode}\n`,
    )
    .join("");
  return sha256(Buffer.from(lines, "utf8"));
}

export function fixtureFileDefinitions() {
  return fileDefinitions.map(({ path: filePath, bytes }) => ({
    path: filePath,
    bytes: Buffer.from(bytes),
  }));
}

export function createFixtureManifest(entries) {
  const files = entries
    .filter((entry) => entry.kind === "file")
    .map(({ path: filePath, bytes, sha256: digest, mode }) => ({
      path: filePath,
      bytes,
      sha256: digest,
      mode,
    }));
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    fixtureId: FIXTURE_ID,
    generator: FIXTURE_GENERATOR,
    files,
    treeSha256: treeHash(entries),
  };
}

async function collectEntries(rootPath) {
  const entries = [];
  async function visit(currentPath, relativePath) {
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      const childRelative = relativePath ? path.join(relativePath, child.name) : child.name;
      const stat = await fs.lstat(childPath);
      const normalized = childRelative.split(path.sep).join("/");
      if (child.isDirectory()) {
        entries.push({ kind: "directory", path: normalized, bytes: 0, mode: modeFromStat(stat) });
        await visit(childPath, normalized);
      } else if (child.isFile()) {
        const bytes = await fs.readFile(childPath);
        entries.push({
          kind: "file",
          path: normalized,
          bytes: bytes.length,
          sha256: sha256(bytes),
          mode: modeFromStat(stat),
        });
      } else {
        throw new Error(`Fixture contains unsupported entry type: ${normalized}`);
      }
    }
  }
  await visit(rootPath, "");
  return entries;
}

export async function generateFixture(rootPath, { manifestPath } = {}) {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const existing = await fs.readdir(rootPath);
  assert(existing.length === 0, `Fixture destination is not empty: ${rootPath}`);
  for (const definition of fileDefinitions) {
    const destination = path.join(rootPath, definition.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, definition.bytes, { mode: 0o600 });
    await fs.chmod(destination, 0o600);
  }
  const entries = await collectEntries(rootPath);
  const manifest = createFixtureManifest(entries);
  if (manifestPath) {
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(manifestPath, 0o600);
  }
  return { manifest, entries };
}

export async function verifyFixtureManifest(rootPath, expectedManifest) {
  const entries = await collectEntries(rootPath);
  const actual = createFixtureManifest(entries);
  assert(actual.fixtureId === expectedManifest.fixtureId, "Fixture ID changed.");
  assert(actual.treeSha256 === expectedManifest.treeSha256, "Fixture tree hash changed.");
  assert(
    JSON.stringify(actual.files) === JSON.stringify(expectedManifest.files),
    "Fixture file bytes, modes, or ordering changed.",
  );
  return actual;
}

export function fixtureTreeHash(entries) {
  return treeHash(entries);
}
