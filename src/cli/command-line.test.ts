import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { type CliIo, cliExitCodes, cliHelp, parseCliArguments, runCli } from "./command-line";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Folder"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Alpha.md"),
    [
      "---",
      "tags: [project, open]",
      "---",
      "",
      "# Alpha heading",
      "",
      "A distinctive needle links to [[Folder/Beta]].",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(vaultPath, "Folder", "Beta.md"),
    "# Beta heading\n\nA local target.\n",
    "utf8",
  );
  await fs.writeFile(path.join(vaultPath, ".obsidian", "Hidden.md"), "private metadata", "utf8");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function capture(): {
  io: CliIo;
  stdout(): string;
  stderr(): string;
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdout: (value) => output.push(value),
      stderr: (value) => errors.push(value),
    },
    stdout: () => output.join(""),
    stderr: () => errors.join(""),
  };
}

async function invoke(args: readonly string[]) {
  const captured = capture();
  const exitCode = await runCli(args, captured.io, {
    stateRoot: new FixedStateRoot(statePath),
  });
  return { exitCode, stdout: captured.stdout(), stderr: captured.stderr() };
}

async function writePlugin(
  id: string,
  options: { manifest?: string; main?: string; stylesheet?: string } = {},
): Promise<string> {
  const directory = path.join(vaultPath, ".obsidian", "plugins", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    options.manifest ?? JSON.stringify({ id, name: id, version: "1.0.0" }),
    "utf8",
  );
  await fs.writeFile(
    path.join(directory, "main.js"),
    options.main ?? "module.exports = {};",
    "utf8",
  );
  if (options.stylesheet !== undefined) {
    await fs.writeFile(path.join(directory, "styles.css"), options.stylesheet, "utf8");
  }
  return directory;
}

async function writeTheme(
  folder: string,
  options: { css?: string; manifest?: string } = {},
): Promise<string> {
  const directory = path.join(vaultPath, ".obsidian", "themes", folder);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "theme.css"), options.css ?? "body {}", "utf8");
  if (options.manifest !== undefined) {
    await fs.writeFile(path.join(directory, "manifest.json"), options.manifest, "utf8");
  }
  return directory;
}

async function writeSnippet(filename: string, css = "body {}"): Promise<string> {
  const directory = path.join(vaultPath, ".obsidian", "snippets");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, css, "utf8");
  return filePath;
}

describe("Threadleaf CLI arguments", () => {
  it("parses native commands and the measured compatibility spellings", () => {
    expect(parseCliArguments(["--vault", "/vault", "vault", "info"])).toMatchObject({
      id: "vault.info",
      vaultPath: "/vault",
    });
    expect(parseCliArguments(["--vault=/vault", "file", "file=Note"])).toMatchObject({
      id: "file",
      filePath: "Note",
      targetKind: "file",
    });
    expect(
      parseCliArguments(["--vault=/vault", "files", "folder=Assets", "ext=.PNG", "total"]),
    ).toMatchObject({ id: "files", folder: "Assets", extension: "png", totalOnly: true });
    expect(
      parseCliArguments(["--vault=/vault", "folders", "folder=Projects", "total"]),
    ).toMatchObject({
      id: "folders",
      folder: "Projects",
      totalOnly: true,
    });
    expect(
      parseCliArguments(["--vault=/vault", "folder", "path=Projects", "info=size"]),
    ).toMatchObject({
      id: "folder",
      folder: "Projects",
      info: "size",
    });
    expect(parseCliArguments(["--vault=/vault", "wordcount", "file=Note", "words"])).toMatchObject({
      id: "wordcount",
      filePath: "Note",
      targetKind: "file",
      valueOnly: "words",
    });
    expect(parseCliArguments(["read", "file=Folder/Note.md", "--vault=/vault"])).toMatchObject({
      id: "read",
      filePath: "Folder/Note.md",
      targetKind: "file",
    });
    expect(parseCliArguments(["read", "path=Folder/Note.md", "--vault=/vault"])).toMatchObject({
      id: "read",
      filePath: "Folder/Note.md",
      targetKind: "path",
    });
    expect(
      parseCliArguments(["--vault", "/vault", "search", "query=linked", "notes", "--limit=7"]),
    ).toMatchObject({ id: "search", query: "linked notes", limit: 7 });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "search",
        "query=Needle",
        "path=Folder",
        "limit=7",
        "format=json",
        "total",
        "case",
      ]),
    ).toMatchObject({
      id: "search",
      query: "Needle",
      folder: "Folder",
      limit: 7,
      format: "json",
      totalOnly: true,
      caseSensitive: true,
    });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "search:context",
        "query=needle",
        "path=Folder",
        "format=json",
      ]),
    ).toMatchObject({ id: "search.context", folder: "Folder", format: "json" });
    expect(
      parseCliArguments([
        "--vault",
        "/vault",
        "create",
        "path=Folder/New note",
        "content=# Title\\n\\nBody",
      ]),
    ).toMatchObject({
      id: "create",
      filePath: "Folder/New note",
      content: "# Title\n\nBody",
    });
    expect(
      parseCliArguments(["create", "Inbox/Native", "--content=hello", "--vault=/vault"]),
    ).toMatchObject({ id: "create", filePath: "Inbox/Native", content: "hello" });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "create",
        "Inbox/Templated",
        "template=Templates/Meeting",
        "date-format=YYYY.MM.DD",
      ]),
    ).toMatchObject({
      id: "create",
      filePath: "Inbox/Templated",
      templatePath: "Templates/Meeting.md",
      dateFormat: "YYYY.MM.DD",
    });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "daily",
        "folder=Journal",
        "format=YYYY/MMMM/YYYY-MM-DD",
        "template=Templates/Daily",
      ]),
    ).toMatchObject({
      id: "daily",
      folder: "Journal",
      format: "YYYY/MMMM/YYYY-MM-DD",
      templatePath: "Templates/Daily.md",
    });
    expect(() =>
      parseCliArguments([
        "--vault=/vault",
        "create",
        "Mixed",
        "content=body",
        "template=Templates/Note",
      ]),
    ).toThrow("template or content");
    expect(
      parseCliArguments([
        "--vault=/vault",
        "rename",
        "Folder/Old.md",
        "--name=New",
        "--update-links",
      ]),
    ).toMatchObject({ id: "rename", updateLinks: true });
    expect(() =>
      parseCliArguments(["--vault=/vault", "read", "Note.md", "--update-links"]),
    ).toThrow("read requires");
    expect(
      parseCliArguments([
        "--vault=/vault",
        "append",
        "path=Folder/Note",
        "content=Next\\nline",
        "inline",
      ]),
    ).toMatchObject({
      id: "append",
      filePath: "Folder/Note",
      content: "Next\nline",
      inline: true,
    });
    expect(
      parseCliArguments([
        "prepend",
        "Folder/Note.md",
        "--content",
        "Lead",
        "--inline",
        "--vault",
        "/vault",
      ]),
    ).toMatchObject({ id: "prepend", filePath: "Folder/Note.md", content: "Lead", inline: true });
    expect(
      parseCliArguments(["--vault=/vault", "move", "path=Folder/Old", "to=Archive/"]),
    ).toMatchObject({
      id: "move",
      sourcePath: "Folder/Old",
      sourceTargetKind: "path",
      targetValue: "Archive/",
    });
    expect(
      parseCliArguments(["rename", "Folder/Old.md", "--name", "New", "--vault", "/vault"]),
    ).toMatchObject({
      id: "rename",
      sourcePath: "Folder/Old.md",
      sourceTargetKind: "path",
      targetValue: "New",
    });
    expect(parseCliArguments(["--vault=/vault", "delete", "path=Folder/Old.md"])).toMatchObject({
      id: "delete",
      filePath: "Folder/Old.md",
    });
    expect(parseCliArguments(["--vault=/vault", "restore", "file=Folder/Old.md"])).toMatchObject({
      id: "restore",
      filePath: "Folder/Old.md",
      targetKind: "path",
    });
    expect(parseCliArguments(["--vault=/vault", "trash", "list"])).toMatchObject({
      id: "trash.list",
    });
    expect(parseCliArguments(["--vault=/vault", "trash:list"])).toMatchObject({
      id: "trash.list",
    });
    expect(
      parseCliArguments(["--vault=/vault", "properties", "path=Folder/Note.md"]),
    ).toMatchObject({
      id: "properties",
      filePath: "Folder/Note.md",
    });
    expect(
      parseCliArguments(["--vault=/vault", "property:read", "path=Folder/Note.md", "name=status"]),
    ).toMatchObject({ id: "property.read", filePath: "Folder/Note.md", propertyName: "status" });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "property:set",
        "path=Folder/Note.md",
        "name=priority",
        "value=4",
        "type=number",
      ]),
    ).toMatchObject({
      id: "property.set",
      filePath: "Folder/Note.md",
      propertyName: "priority",
      propertyValue: "4",
      propertyType: "number",
    });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "property:remove",
        "file=Folder/Note.md",
        "name=priority",
      ]),
    ).toMatchObject({
      id: "property.remove",
      filePath: "Folder/Note.md",
      propertyName: "priority",
    });
    expect(
      parseCliArguments(["--vault=/vault", "tasks", "path=Folder/Note.md", "todo", "verbose"]),
    ).toMatchObject({
      id: "tasks",
      filePath: "Folder/Note.md",
      filter: { kind: "todo" },
      verbose: true,
    });
    expect(
      parseCliArguments(["--vault=/vault", "task", "ref=Folder/Note.md:12", "status=?"]),
    ).toMatchObject({
      id: "task",
      filePath: "Folder/Note.md",
      line: 12,
      mutation: { kind: "set", status: "?" },
    });
    expect(
      parseCliArguments(["--vault=/vault", "aliases", "file=Folder/Note.md", "verbose"]),
    ).toMatchObject({
      id: "aliases",
      filePath: "Folder/Note.md",
      targetKind: "file",
      verbose: true,
    });
    expect(parseCliArguments(["--vault=/vault", "tags", "sort=count", "counts"])).toMatchObject({
      id: "tags",
      sortBy: "count",
      counts: true,
    });
    expect(parseCliArguments(["--vault=/vault", "tag", "name=#project", "total"])).toMatchObject({
      id: "tag",
      tagName: "project",
      totalOnly: true,
    });
    expect(
      parseCliArguments([
        "--vault=/vault",
        "plugins",
        "filter=community",
        "versions",
        "format=csv",
      ]),
    ).toMatchObject({ id: "plugins", filter: "community", versions: true, format: "csv" });
    expect(parseCliArguments(["--vault=/vault", "plugins", "format=json"])).toMatchObject({
      id: "plugins",
      filter: "community",
      versions: false,
      format: "json",
    });
    expect(parseCliArguments(["--vault=/vault", "plugin", "id=fixture-plugin"])).toMatchObject({
      id: "plugin",
      pluginId: "fixture-plugin",
    });
    expect(parseCliArguments(["--vault=/vault", "themes", "versions"])).toMatchObject({
      id: "themes",
      versions: true,
    });
    expect(parseCliArguments(["--vault=/vault", "theme", "name=Paper"])).toMatchObject({
      id: "theme",
      themeName: "Paper",
    });
    expect(parseCliArguments(["--vault=/vault", "snippets"])).toMatchObject({ id: "snippets" });
    for (const name of ["links", "backlinks", "outline"] as const) {
      expect(parseCliArguments(["--vault=/vault", name, "path=Folder/Note.md"])).toMatchObject({
        id: name,
        filePath: "Folder/Note.md",
      });
    }
    expect(
      parseCliArguments(["--vault=/vault", "backlinks", "file=Note", "counts", "format=csv"]),
    ).toMatchObject({ id: "backlinks", counts: true, format: "csv" });
    expect(
      parseCliArguments(["--vault=/vault", "outline", "file=Note", "format=md", "total"]),
    ).toMatchObject({ id: "outline", format: "md", totalOnly: true });
    expect(
      parseCliArguments(["--vault=/vault", "unresolved", "counts", "verbose", "format=json"]),
    ).toMatchObject({ id: "unresolved", counts: true, verbose: true, format: "json" });
    for (const name of ["unresolved", "orphans", "deadends"] as const) {
      expect(parseCliArguments(["--vault=/vault", name])).toMatchObject({ id: name });
    }
  });

  it("rejects ambiguous or unsupported invocations as usage errors", async () => {
    expect(() => parseCliArguments(["files"])).toThrow("requires --vault");
    expect(() =>
      parseCliArguments(["--vault", "/vault", "search", "term", "--limit", "101"]),
    ).toThrow("may not exceed 100");
    expect(() => parseCliArguments(["--vault=/vault", "file"])).toThrow("exactly one");
    expect(() => parseCliArguments(["--vault=/vault", "files", "ext=png", "ext=md"])).toThrow(
      "only once",
    );
    expect(() =>
      parseCliArguments(["--vault=/vault", "folder", "path=Folder", "info=unknown"]),
    ).toThrow("files, folders, or size");
    expect(() =>
      parseCliArguments(["--vault=/vault", "wordcount", "file=Note", "words", "characters"]),
    ).toThrow("only one");

    const result = await invoke(["--json", "--vault", vaultPath, "unknown"]);
    expect(result.exitCode).toBe(cliExitCodes.usage);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: null,
      error: { code: "USAGE" },
    });

    const literalJson = await invoke(["--", "--json"]);
    expect(literalJson.exitCode).toBe(cliExitCodes.usage);
    expect(literalJson.stderr).toMatch(/^threadleaf:/);

    expect(() => parseCliArguments(["--vault", "/vault", "append", "Note.md"])).toThrow(
      "requires non-empty content",
    );
    expect(() =>
      parseCliArguments([
        "--vault",
        "/vault",
        "prepend",
        "Note.md",
        "content=Lead",
        "--content=Other",
      ]),
    ).toThrow("option or parameter, not both");
    expect(() => parseCliArguments(["--vault", "/vault", "links"])).toThrow("requires exactly one");
    expect(() => parseCliArguments(["--vault", "/vault", "orphans", "extra"])).toThrow(
      "optional total",
    );
    expect(() =>
      parseCliArguments(["--vault=/vault", "backlinks", "file=Note", "format=md"]),
    ).toThrow("json, tsv, or csv");
    expect(() =>
      parseCliArguments(["--vault=/vault", "outline", "file=Note", "format=csv"]),
    ).toThrow("tree, md, or json");
    expect(() =>
      parseCliArguments(["--vault=/vault", "search:context", "query=needle", "total"]),
    ).toThrow("does not accept total");
    expect(() =>
      parseCliArguments(["--vault=/vault", "search", "query=needle", "limit=5", "--limit=6"]),
    ).toThrow("not both");
    expect(() =>
      parseCliArguments(["--vault", "/vault", "delete", "Note.md", "permanent"]),
    ).toThrow("permanent deletion");
    expect(() =>
      parseCliArguments([
        "--vault=/vault",
        "property:set",
        "path=Note.md",
        "name=status",
        "value=active",
        "type=object",
      ]),
    ).toThrow("Unsupported property type");
    expect(() => parseCliArguments(["--vault=/vault", "property:remove", "path=Note.md"])).toThrow(
      "requires name=<name>",
    );
    expect(() => parseCliArguments(["--vault=/vault", "tasks", "done", "status=x"])).toThrow(
      "only one of done",
    );
    expect(() => parseCliArguments(["--vault=/vault", "task", "ref=Note.md"])).toThrow("path:line");
    expect(() =>
      parseCliArguments(["--vault=/vault", "task", "path=Note.md", "line=1", "status=xx"]),
    ).toThrow("one character");
    expect(() => parseCliArguments(["--vault=/vault", "aliases", "active"])).toThrow(
      "not available",
    );
    expect(() => parseCliArguments(["--vault=/vault", "tags", "sort=name"])).toThrow("sort=count");
    expect(() => parseCliArguments(["--vault=/vault", "tag", "name=two words"])).toThrow(
      "tag names accept",
    );
    expect(() => parseCliArguments(["--vault=/vault", "plugins", "filter=core"])).toThrow(
      "no safe headless core-plugin catalog",
    );
    expect(() =>
      parseCliArguments(["--vault=/vault", "plugins", "filter=community", "filter=community"]),
    ).toThrow("only once");
    expect(() => parseCliArguments(["--vault=/vault", "plugins", "versions", "versions"])).toThrow(
      "only once",
    );
    expect(() => parseCliArguments(["--vault=/vault", "plugins", "format=md"])).toThrow(
      "json, tsv, or csv",
    );
    expect(() => parseCliArguments(["--vault=/vault", "plugin"])).toThrow(
      "requires id=<plugin-id>",
    );
    expect(() => parseCliArguments(["--vault=/vault", "plugin", "id=../outside"])).toThrow(
      "Plugin identifier",
    );
    expect(() => parseCliArguments(["--vault=/vault", "plugin", "id=one", "id=two"])).toThrow(
      "only once",
    );
    expect(() => parseCliArguments(["--vault=/vault", "themes", "versions", "versions"])).toThrow(
      "only the optional versions",
    );
    expect(() => parseCliArguments(["--vault=/vault", "themes", "format=json"])).toThrow(
      "only the optional versions",
    );
    expect(() => parseCliArguments(["--vault=/vault", "theme"])).toThrow("active-theme selection");
    expect(() => parseCliArguments(["--vault=/vault", "theme", "name="])).toThrow(
      "requires a value",
    );
    expect(() => parseCliArguments(["--vault=/vault", "theme", "name=One", "name=Two"])).toThrow(
      "only once",
    );
    expect(() => parseCliArguments(["--vault=/vault", "snippets", "enabled"])).toThrow(
      "does not accept arguments",
    );
  });

  it("shows help without requiring a vault", async () => {
    const result = await invoke(["--help"]);
    expect(result).toEqual({ exitCode: 0, stdout: cliHelp, stderr: "" });
  });
});

describe("Threadleaf CLI note-name target resolution", () => {
  it("resolves file= by a unique case-insensitive NFC basename while path= stays exact", async () => {
    const composedName = "Caf\u00e9.md";
    const content = "# Unicode target\n";
    await fs.writeFile(path.join(vaultPath, "Folder", composedName), content, "utf8");

    const resolved = await invoke(["--json", "--vault", vaultPath, "read", "file=CAFE\u0301"]);
    expect(resolved.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      command: "read",
      data: { path: `Folder/${composedName}`, content },
    });

    const exact = await invoke(["--json", "--vault", vaultPath, "read", `path=${composedName}`]);
    expect(exact.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(exact.stderr)).toMatchObject({
      command: "read",
      error: { code: "VAULT", message: expect.stringContaining("not indexed") },
    });

    const missing = await invoke(["--json", "--vault", vaultPath, "read", "file=Missing"]);
    expect(missing.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      command: "read",
      error: { code: "VAULT", message: "No Markdown note matches file=Missing" },
    });

    await fs.mkdir(path.join(vaultPath, "Other"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Other", "Beta.md"), "duplicate", "utf8");
    const ambiguous = await invoke(["--json", "--vault", vaultPath, "read", "file=beta.md"]);
    expect(ambiguous.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      command: "read",
      error: {
        code: "VAULT",
        message: expect.stringMatching(
          /^Ambiguous file=beta\.md\. Matches: .*Folder\/Beta\.md.*Other\/Beta\.md$/,
        ),
      },
    });
  });

  it("uses the resolved note across metadata, write, refactor, and recovery commands", async () => {
    const betaPath = path.join(vaultPath, "Folder", "Beta.md");
    await fs.writeFile(
      betaPath,
      [
        "---",
        "aliases: [Bee]",
        "tags: [nested/topic]",
        "status: seed",
        "---",
        "# Beta heading",
        "- [ ] task",
        "[[Alpha]]",
      ].join("\n"),
      "utf8",
    );

    for (const [command, expected] of [
      [["links", "file=beta"], { path: "Folder/Beta.md", total: 1 }],
      [["backlinks", "file=BETA.md"], { path: "Folder/Beta.md", total: 1 }],
      [["outline", "file=Folder/Beta.md"], { path: "Folder/Beta.md", total: 1 }],
      [["properties", "file=beta"], { path: "Folder/Beta.md", total: 3 }],
      [["aliases", "file=BETA"], { path: "Folder/Beta.md", total: 1 }],
      [["tags", "file=beta.md"], { path: "Folder/Beta.md", total: 1 }],
      [["tasks", "file=Beta"], { path: "Folder/Beta.md", total: 1 }],
    ] as const) {
      const result = await invoke(["--json", "--vault", vaultPath, ...command]);
      expect(result.exitCode).toBe(cliExitCodes.success);
      expect(JSON.parse(result.stdout).data).toMatchObject(expected);
    }

    const readProperty = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:read",
      "file=beta",
      "name=status",
    ]);
    expect(JSON.parse(readProperty.stdout).data).toMatchObject({
      path: "Folder/Beta.md",
      value: "seed",
    });

    for (const args of [
      ["property:set", "file=beta", "name=priority", "value=1", "type=number"],
      ["property:remove", "file=BETA.md", "name=priority"],
      ["task", "file=beta", "line=7", "done"],
      ["append", "file=beta", "content= tail", "inline"],
      ["prepend", "file=beta.md", "content=Lead ", "inline"],
    ]) {
      const result = await invoke(["--json", "--vault", vaultPath, ...args]);
      expect(result.exitCode).toBe(cliExitCodes.success);
    }

    const renamed = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "rename",
      "file=bEtA",
      "name=Gamma",
      "--update-links",
    ]);
    expect(JSON.parse(renamed.stdout).data).toMatchObject({
      status: "committed",
      from: "Folder/Beta.md",
      to: "Folder/Gamma.md",
    });

    const moved = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "move",
      "file=gamma",
      "to=Archive/",
      "--update-links",
    ]);
    expect(JSON.parse(moved.stdout).data).toMatchObject({
      status: "committed",
      from: "Folder/Gamma.md",
      to: "Archive/Gamma.md",
    });

    const beforeDelete = await fs.readFile(path.join(vaultPath, "Archive", "Gamma.md"), "utf8");
    const deleted = await invoke(["--json", "--vault", vaultPath, "delete", "file=GAMMA.md"]);
    expect(JSON.parse(deleted.stdout).data).toMatchObject({
      status: "committed",
      from: "Archive/Gamma.md",
      to: ".trash/Archive/Gamma.md",
    });

    const restored = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "restore",
      "path=Archive/Gamma.md",
    ]);
    expect(restored.exitCode).toBe(cliExitCodes.success);
    await expect(fs.readFile(path.join(vaultPath, "Archive", "Gamma.md"), "utf8")).resolves.toBe(
      beforeDelete,
    );
  }, 15_000);
});

describe("Threadleaf CLI create workflow", () => {
  it("creates nested Markdown through the recoverable kernel in human mode", async () => {
    const result = await invoke([
      "--vault",
      vaultPath,
      "create",
      "Projects/New thread",
      "--content",
      "# New thread\\n\\nBody",
    ]);

    expect(result).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Created Projects/New thread.md\n",
      stderr: "",
    });
    await expect(
      fs.readFile(path.join(vaultPath, "Projects", "New thread.md"), "utf8"),
    ).resolves.toBe("# New thread\n\nBody");
    await expect(fs.stat(statePath)).resolves.toBeDefined();
  });

  it("supports path, name, content, and JSON compatibility spellings", async () => {
    const byPath = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "create",
      "path=Inbox/Path note",
      "content=Line one\\nLine two\\tvalue",
    ]);
    expect(JSON.parse(byPath.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "create",
      data: {
        status: "committed",
        path: "Inbox/Path note.md",
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Inbox", "Path note.md"), "utf8")).resolves.toBe(
      "Line one\nLine two\tvalue",
    );

    const byName = await invoke(["--vault", vaultPath, "create", "name=Root note"]);
    expect(byName.stdout).toBe("Created Root note.md\n");
    await expect(fs.readFile(path.join(vaultPath, "Root note.md"), "utf8")).resolves.toBe("");
  });

  it("creates notes from bounded templates without modifying the source", async () => {
    await fs.mkdir(path.join(vaultPath, "Templates"));
    const template = "# {{title}}\n{{date}} {{time}}\n{{unknown}}\n";
    await fs.writeFile(path.join(vaultPath, "Templates", "Meeting.md"), template, "utf8");

    const result = await invoke([
      "--vault",
      vaultPath,
      "create",
      "Projects/Kickoff",
      "template=Templates/Meeting.md",
      "date-format=[DATE]",
      "time-format=[TIME]",
    ]);

    expect(result).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Created Projects/Kickoff.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Projects", "Kickoff.md"), "utf8")).resolves.toBe(
      "# Kickoff\nDATE TIME\n{{unknown}}\n",
    );
    await expect(
      fs.readFile(path.join(vaultPath, "Templates", "Meeting.md"), "utf8"),
    ).resolves.toBe(template);
  });

  it("creates then reopens a daily note without rewriting user content", async () => {
    await fs.mkdir(path.join(vaultPath, "Templates"));
    const template = "# {{title}}\n{{date}} {{time}}\n";
    await fs.writeFile(path.join(vaultPath, "Templates", "Daily.md"), template, "utf8");
    const command = [
      "--vault",
      vaultPath,
      "daily",
      "folder=Journal",
      "format=[Today]",
      "template=Templates/Daily.md",
      "date-format=[DATE]",
      "time-format=[TIME]",
    ];

    const created = await invoke(command);
    expect(created).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Created Journal/Today.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")).resolves.toBe(
      "# Today\nDATE TIME\n",
    );
    await fs.writeFile(path.join(vaultPath, "Journal", "Today.md"), "manual content", "utf8");

    const reopened = await invoke(command);
    expect(reopened).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Opened Journal/Today.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")).resolves.toBe(
      "manual content",
    );
  });

  it("returns a stable conflict error without overwriting an existing note", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "create",
      "Alpha",
      "--content=replacement",
    ]);

    expect(result.exitCode).toBe(cliExitCodes.conflict);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "create",
      error: {
        code: "CONFLICT",
        details: { status: "exists", path: "Alpha.md" },
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(before);
    expect((await fs.readdir(vaultPath)).filter((name) => name.includes("conflict"))).toEqual([]);
  });

  it("fails closed on traversal and private create targets", async () => {
    const traversal = await invoke(["--json", "--vault", vaultPath, "create", "../Outside"]);
    expect(traversal.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(traversal.stderr)).toMatchObject({ error: { code: "VAULT" } });

    const privatePath = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "create",
      ".obsidian/Injected",
    ]);
    expect(privatePath.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(privatePath.stderr).error.message).toContain("private application");
    await expect(fs.stat(path.join(sandboxPath, "Outside.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const missingVault = await invoke([
      "--json",
      "--vault",
      path.join(sandboxPath, "missing-vault"),
      "create",
      "Note",
    ]);
    expect(missingVault.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(missingVault.stderr)).toMatchObject({ error: { code: "VAULT" } });
  });

  it("rejects a concurrent CLI mutation and leaves the vault untouched", async () => {
    const alphaBefore = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const lockPath = path.join(statePath, ".cli-mutation-lock");
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "live-owner",
        createdAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const result = await invoke(["--json", "--vault", vaultPath, "create", "Blocked"]);

    expect(result.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "CONFLICT", details: { status: "busy" } },
    });
    await expect(fs.stat(path.join(vaultPath, "Blocked.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const appendResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "append",
      "Alpha.md",
      "--content=blocked",
    ]);
    expect(appendResult.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(appendResult.stderr)).toMatchObject({
      error: { code: "CONFLICT", details: { status: "busy" } },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(alphaBefore);

    const moveResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "move",
      "Alpha.md",
      "to=Archive/Alpha.md",
    ]);
    expect(moveResult.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(moveResult.stderr)).toMatchObject({
      error: { code: "CONFLICT", details: { status: "busy" } },
    });
    await expect(fs.stat(path.join(vaultPath, "Archive", "Alpha.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const propertyResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:set",
      "path=Alpha.md",
      "name=status",
      "value=blocked",
    ]);
    expect(propertyResult.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(propertyResult.stderr)).toMatchObject({
      error: { code: "CONFLICT", details: { status: "busy" } },
    });

    const taskResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "task",
      "path=Alpha.md",
      "line=1",
      "toggle",
    ]);
    expect(taskResult.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(taskResult.stderr)).toMatchObject({
      error: { code: "CONFLICT", details: { status: "busy" } },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(alphaBefore);
  });

  it("takes over a dead CLI lock, recovers state, and releases ownership", async () => {
    const lockPath = path.join(statePath, ".cli-mutation-lock");
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "dead-owner",
        createdAt: new Date(0).toISOString(),
      })}\n`,
      "utf8",
    );

    const result = await invoke(["--vault", vaultPath, "create", "Recovered"]);

    expect(result.exitCode).toBe(cliExitCodes.success);
    await expect(fs.readFile(path.join(vaultPath, "Recovered.md"), "utf8")).resolves.toBe("");
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Threadleaf CLI append and prepend workflows", () => {
  it("appends decoded content with a default separator and stable JSON", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "append",
      "path=Alpha",
      "content=Added\\nline",
    ]);

    expect(result.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "append",
      data: {
        status: "committed",
        path: "Alpha.md",
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(
      `${before}\nAdded\nline`,
    );
  });

  it("supports inline append through native options", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8");
    const result = await invoke([
      "--vault",
      vaultPath,
      "append",
      "Folder/Beta.md",
      "--content=inline",
      "--inline",
    ]);

    expect(result).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Appended Folder/Beta.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8")).resolves.toBe(
      `${before}inline`,
    );
  });

  it("prepends after frontmatter and keeps the body intact", async () => {
    const result = await invoke(["--vault", vaultPath, "prepend", "file=Alpha", "content=Context"]);

    expect(result).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Prepended Alpha.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(
      [
        "---",
        "tags: [project, open]",
        "---",
        "Context",
        "",
        "# Alpha heading",
        "",
        "A distinctive needle links to [[Folder/Beta]].",
      ].join("\n"),
    );
  });

  it("fails closed for missing, private, and traversal targets", async () => {
    for (const target of ["Missing", ".obsidian/Hidden", "../Outside"]) {
      const result = await invoke([
        "--json",
        "--vault",
        vaultPath,
        "append",
        `path=${target}`,
        "content=blocked",
      ]);
      expect(result.exitCode).toBe(cliExitCodes.vault);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "VAULT" } });
    }
    await expect(fs.stat(path.join(sandboxPath, "Outside.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Threadleaf CLI move and rename workflows", () => {
  it("moves a link-safe note through the recoverable rename path", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const result = await invoke([
      "--vault",
      vaultPath,
      "move",
      "Alpha.md",
      "--to",
      "Archive/Alpha",
    ]);

    expect(result).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Moved Alpha.md to Archive/Alpha.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Archive", "Alpha.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(fs.stat(path.join(vaultPath, "Alpha.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("renames an unreferenced note and preserves the Markdown extension", async () => {
    await fs.writeFile(path.join(vaultPath, "Solo.md"), "solo", "utf8");
    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "rename",
      "path=Solo.md",
      "name=Renamed",
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "rename",
      data: { status: "committed", from: "Solo.md", to: "Renamed.md" },
    });
    await expect(fs.readFile(path.join(vaultPath, "Renamed.md"), "utf8")).resolves.toBe("solo");
  });

  it("previews required link updates and applies them only with --update-links", async () => {
    const alphaBefore = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const betaBefore = await fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8");
    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "rename",
      "file=Folder/Beta.md",
      "name=Gamma",
    ]);

    expect(result.exitCode).toBe(cliExitCodes.conflict);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "rename",
      error: {
        code: "CONFLICT",
        details: {
          status: "requires-confirmation",
          from: "Folder/Beta.md",
          to: "Folder/Gamma.md",
          confirmationId: expect.stringMatching(/^[a-f0-9]{64}$/),
          rewrites: [
            {
              documentPath: "Alpha.md",
              resultPath: "Alpha.md",
              line: 7,
              syntax: "wiki",
              beforeTarget: "Folder/Beta",
              afterTarget: "Folder/Gamma",
            },
          ],
        },
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(alphaBefore);
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8")).resolves.toBe(
      betaBefore,
    );

    const applied = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "rename",
      "file=Folder/Beta.md",
      "name=Gamma",
      "--update-links",
    ]);

    expect(applied.exitCode).toBe(cliExitCodes.success);
    expect(applied.stderr).toBe("");
    expect(JSON.parse(applied.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "rename",
      data: {
        status: "committed",
        from: "Folder/Beta.md",
        to: "Folder/Gamma.md",
        rewrites: [
          {
            documentPath: "Alpha.md",
            beforeTarget: "Folder/Beta",
            afterTarget: "Folder/Gamma",
          },
        ],
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(
      alphaBefore.replace("[[Folder/Beta]]", "[[Folder/Gamma]]"),
    );
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Gamma.md"), "utf8")).resolves.toBe(
      betaBefore,
    );
    await expect(fs.stat(path.join(vaultPath, "Folder", "Beta.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a destination collision without overwriting either note", async () => {
    const alphaBefore = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const betaBefore = await fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8");
    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "move",
      "Alpha.md",
      "to=Folder/Beta.md",
    ]);

    expect(result.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(result.stderr)).toMatchObject({
      command: "move",
      error: {
        code: "CONFLICT",
        details: { status: "conflict", reason: "target-exists" },
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(alphaBefore);
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8")).resolves.toBe(
      betaBefore,
    );
  });

  it("fails closed on traversal and private move paths during argument validation", async () => {
    for (const target of ["../Outside.md", ".obsidian/Injected.md"]) {
      const result = await invoke([
        "--json",
        "--vault",
        vaultPath,
        "move",
        "Alpha.md",
        `to=${target}`,
      ]);
      expect(result.exitCode).toBe(cliExitCodes.usage);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "USAGE" } });
    }
    await expect(fs.stat(path.join(sandboxPath, "Outside.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Threadleaf CLI recoverable deletion workflows", () => {
  it("deletes a referenced note to vault-local trash without treating it as an ordinary note", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8");
    const result = await invoke(["--json", "--vault", vaultPath, "delete", "path=Folder/Beta.md"]);

    expect(result.exitCode).toBe(cliExitCodes.success);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "delete",
      data: {
        status: "committed",
        from: "Folder/Beta.md",
        to: ".trash/Folder/Beta.md",
      },
    });
    await expect(
      fs.readFile(path.join(vaultPath, ".trash", "Folder", "Beta.md"), "utf8"),
    ).resolves.toBe(before);
    await expect(fs.stat(path.join(vaultPath, "Folder", "Beta.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const files = await invoke(["--vault", vaultPath, "files"]);
    expect(files.stdout).toBe("Alpha.md\n");
    const unresolved = await invoke(["--json", "--vault", vaultPath, "unresolved"]);
    expect(JSON.parse(unresolved.stdout)).toMatchObject({
      data: {
        total: 1,
        links: [{ sourcePath: "Alpha.md", target: "Folder/Beta" }],
      },
    });
  });

  it("lists recoverable trash without creating read-only CLI state", async () => {
    await fs.mkdir(path.join(vaultPath, ".trash", "Archive"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, ".trash", "Archive", "Old.md"), "old", "utf8");

    const json = await invoke(["--json", "--vault", vaultPath, "trash:list"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: "trash.list",
      data: {
        total: 1,
        entries: [
          {
            path: "Archive/Old.md",
            trashPath: ".trash/Archive/Old.md",
            revision: expect.stringMatching(/^[a-f0-9]{64}$/),
            size: 3,
          },
        ],
      },
    });
    const human = await invoke(["--vault", vaultPath, "trash", "list"]);
    expect(human.stdout).toBe("Recoverable trash:\nArchive/Old.md <- .trash/Archive/Old.md\n");
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores exact bytes to their original path", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8");
    await invoke(["--vault", vaultPath, "delete", "Folder/Beta.md"]);

    const restored = await invoke(["--vault", vaultPath, "restore", "Folder/Beta"]);

    expect(restored).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Restored .trash/Folder/Beta.md to Folder/Beta.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8")).resolves.toBe(
      before,
    );
    await expect(
      fs.stat(path.join(vaultPath, ".trash", "Folder", "Beta.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects delete and restore collisions without overwriting either copy", async () => {
    const sourcePath = path.join(vaultPath, "Folder", "Beta.md");
    const trashPath = path.join(vaultPath, ".trash", "Folder", "Beta.md");
    const source = await fs.readFile(sourcePath, "utf8");
    await fs.mkdir(path.dirname(trashPath), { recursive: true });
    await fs.writeFile(trashPath, "earlier", "utf8");

    const deleteCollision = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "delete",
      "Folder/Beta.md",
    ]);
    expect(deleteCollision.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(deleteCollision.stderr)).toMatchObject({
      command: "delete",
      error: {
        code: "CONFLICT",
        details: { status: "conflict", reason: "target-exists" },
      },
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.readFile(trashPath, "utf8")).resolves.toBe("earlier");

    const restoreCollision = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "restore",
      ".trash/Folder/Beta.md",
    ]);
    expect(restoreCollision.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(restoreCollision.stderr)).toMatchObject({
      command: "restore",
      error: {
        code: "CONFLICT",
        details: { status: "conflict", reason: "target-exists" },
      },
    });
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
    await expect(fs.readFile(trashPath, "utf8")).resolves.toBe("earlier");
  });

  it("fails closed on missing, private, and traversal targets", async () => {
    for (const [command, target] of [
      ["delete", "Missing.md"],
      ["delete", ".trash/Folder/Beta.md"],
      ["delete", "../Outside.md"],
      ["restore", "Missing.md"],
      ["restore", "../Outside.md"],
    ] as const) {
      const result = await invoke(["--json", "--vault", vaultPath, command, target]);
      expect(result.exitCode).toBe(cliExitCodes.vault);
      expect(JSON.parse(result.stderr)).toMatchObject({
        command,
        error: { code: "VAULT" },
      });
    }
    await expect(fs.stat(path.join(sandboxPath, "Outside.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Threadleaf CLI property workflows", () => {
  it("lists and reads indexed properties without creating CLI state", async () => {
    const listed = await invoke(["--json", "--vault", vaultPath, "properties", "path=Alpha.md"]);
    expect(listed.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "properties",
      data: {
        path: "Alpha.md",
        total: 1,
        properties: { tags: ["project", "open"] },
      },
    });

    const read = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:read",
      "path=Alpha.md",
      "name=tags",
    ]);
    expect(JSON.parse(read.stdout)).toMatchObject({
      command: "property.read",
      data: {
        path: "Alpha.md",
        name: "tags",
        exists: true,
        value: ["project", "open"],
      },
    });

    const missing = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:read",
      "path=Alpha.md",
      "name=missing",
    ]);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      command: "property.read",
      data: { path: "Alpha.md", name: "missing", exists: false, value: null },
    });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sets typed values through compatibility parameters and preserves the note body", async () => {
    const body = "\n\n# Alpha heading\n\nA distinctive needle links to [[Folder/Beta]].";
    const text = await invoke([
      "--vault",
      vaultPath,
      "property:set",
      "path=Alpha.md",
      "name=status",
      "value=review",
    ]);
    expect(text).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Set status on Alpha.md\n",
      stderr: "",
    });

    const list = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:set",
      "path=Alpha.md",
      "name=aliases",
      'value=["First","[[Second]]"]',
      "type=list",
    ]);
    expect(JSON.parse(list.stdout)).toMatchObject({
      command: "property.set",
      data: {
        status: "committed",
        path: "Alpha.md",
        name: "aliases",
        type: "list",
        value: ["First", "[[Second]]"],
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(
      [
        "---",
        "tags: [project, open]",
        'status: "review"',
        "aliases:",
        '  - "First"',
        '  - "[[Second]]"',
        "---",
      ].join("\n") + body,
    );
  });

  it("removes a property idempotently and reports the no-write case", async () => {
    const removed = await invoke([
      "--vault",
      vaultPath,
      "property:remove",
      "path=Alpha.md",
      "name=tags",
    ]);
    expect(removed).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Removed tags from Alpha.md\n",
      stderr: "",
    });
    expect(await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).not.toContain("tags:");

    const missing = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:remove",
      "path=Alpha.md",
      "name=tags",
    ]);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      command: "property.remove",
      data: { status: "missing", path: "Alpha.md", name: "tags" },
    });
  });

  it("fails closed for unsafe frontmatter, invalid values, and private paths", async () => {
    const alphaBefore = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const invalidValue = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:set",
      "path=Alpha.md",
      "name=due",
      "value=2026-02-30",
      "type=date",
    ]);
    expect(invalidValue.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(invalidValue.stderr)).toMatchObject({
      command: "property.set",
      error: { code: "VAULT", message: expect.stringContaining("calendar date") },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(alphaBefore);

    await fs.writeFile(
      path.join(vaultPath, "Complex.md"),
      '---\n{"status":"active"}\n---\nBody',
      "utf8",
    );
    const complexBefore = await fs.readFile(path.join(vaultPath, "Complex.md"), "utf8");
    const complex = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:set",
      "path=Complex.md",
      "name=status",
      "value=review",
    ]);
    expect(complex.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(complex.stderr)).toMatchObject({
      command: "property.set",
      error: { code: "VAULT", message: expect.stringContaining("JSON or complex YAML") },
    });
    await expect(fs.readFile(path.join(vaultPath, "Complex.md"), "utf8")).resolves.toBe(
      complexBefore,
    );

    const privatePath = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "property:remove",
      "path=.obsidian/Hidden.md",
      "name=status",
    ]);
    expect(privatePath.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(privatePath.stderr)).toMatchObject({
      command: "property.remove",
      error: { code: "VAULT" },
    });
  });
});

describe("Threadleaf CLI task workflows", () => {
  it("lists exact task records with status filters, totals, and verbose locations", async () => {
    await fs.appendFile(
      path.join(vaultPath, "Alpha.md"),
      "\n- [ ] first\n- [x] done\n- [?] waiting\n",
      "utf8",
    );
    await fs.appendFile(path.join(vaultPath, "Folder", "Beta.md"), "- [X] other done\n", "utf8");

    const todo = await invoke(["--json", "--vault", vaultPath, "tasks", "todo"]);
    expect(todo.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(todo.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "tasks",
      data: {
        filter: { kind: "todo" },
        total: 2,
        tasks: [
          { path: "Alpha.md", line: 8, status: " ", completed: false, text: "first" },
          { path: "Alpha.md", line: 10, status: "?", completed: false, text: "waiting" },
        ],
      },
    });

    const custom = await invoke([
      "--vault",
      vaultPath,
      "tasks",
      "path=Alpha.md",
      "status=?",
      "verbose",
    ]);
    expect(custom).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Alpha.md:10\t- [?] waiting\n",
      stderr: "",
    });

    const doneTotal = await invoke(["--vault", vaultPath, "tasks", "done", "total"]);
    expect(doneTotal.stdout).toBe("2\n");
  });

  it("reads and recovery-writes exact path:line task statuses without normalizing other bytes", async () => {
    const before = "\ufeff- [ ] first  \r\n- [?] waiting `code`\r\n- [X] done\r\n";
    await fs.writeFile(path.join(vaultPath, "Tasks.md"), before, "utf8");

    const read = await invoke(["--vault", vaultPath, "task", "ref=Tasks.md:2"]);
    expect(read).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Tasks.md:2\t- [?] waiting `code`\n",
      stderr: "",
    });

    const done = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "task",
      "path=Tasks.md",
      "line=1",
      "done",
    ]);
    expect(JSON.parse(done.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "task",
      data: {
        status: "committed",
        task: { path: "Tasks.md", line: 1, status: "x", completed: true, text: "first" },
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const unchanged = await invoke(["--vault", vaultPath, "task", "ref=Tasks.md:1", "done"]);
    expect(unchanged.stdout).toBe("Task already has that status: Tasks.md:1\t- [x] first\n");

    const custom = await invoke(["--vault", vaultPath, "task", "ref=Tasks.md:2", "status=🟡"]);
    expect(custom.stdout).toBe("Updated task: Tasks.md:2\t- [🟡] waiting `code`\n");

    const toggled = await invoke(["--vault", vaultPath, "task", "ref=Tasks.md:3", "toggle"]);
    expect(toggled.stdout).toBe("Updated task: Tasks.md:3\t- [ ] done\n");
    await expect(fs.readFile(path.join(vaultPath, "Tasks.md"), "utf8")).resolves.toBe(
      before.replace("[ ]", "[x]").replace("[?]", "[🟡]").replace("[X]", "[ ]"),
    );
  });

  it("fails closed for a non-task line or private application path", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const missing = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "task",
      "path=Alpha.md",
      "line=5",
      "toggle",
    ]);
    expect(missing.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(missing.stderr)).toMatchObject({
      command: "task",
      error: { code: "VAULT", message: expect.stringContaining("No Markdown task") },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(before);

    const privatePath = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "tasks",
      "path=.obsidian/Hidden.md",
    ]);
    expect(privatePath.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(privatePath.stderr)).toMatchObject({
      command: "tasks",
      error: { code: "VAULT" },
    });
  });
});

describe("Threadleaf CLI alias and tag workflows", () => {
  it("lists frontmatter aliases across the vault or one exact note", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Alpha.md"),
      ["---", "tags: [project, open]", "aliases: [First, Shared]", "---", "# Alpha"].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, "Folder", "Beta.md"),
      ["---", "alias: Second", "---", "# Beta"].join("\n"),
      "utf8",
    );

    const all = await invoke(["--json", "--vault", vaultPath, "aliases"]);
    expect(all.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(all.stdout)).toMatchObject({
      command: "aliases",
      data: {
        path: null,
        total: 3,
        aliases: [
          { alias: "First", path: "Alpha.md" },
          { alias: "Second", path: "Folder/Beta.md" },
          { alias: "Shared", path: "Alpha.md" },
        ],
      },
    });

    const verbose = await invoke(["--vault", vaultPath, "aliases", "path=Alpha.md", "verbose"]);
    expect(verbose.stdout).toBe("First\tAlpha.md\nShared\tAlpha.md\n");

    const total = await invoke(["--vault", vaultPath, "aliases", "file=Alpha.md", "total"]);
    expect(total.stdout).toBe("2\n");
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lists distinct tags with occurrence counts and reports per-tag files", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Folder", "Beta.md"),
      ["---", "tags: [project, nested/topic]", "---", "# Beta", "#project"].join("\n"),
      "utf8",
    );

    const counted = await invoke(["--json", "--vault", vaultPath, "tags", "sort=count", "counts"]);
    expect(JSON.parse(counted.stdout)).toMatchObject({
      command: "tags",
      data: {
        path: null,
        sort: "count",
        total: 3,
        tags: [
          { name: "project", count: 3, files: ["Alpha.md", "Folder/Beta.md"] },
          { name: "nested/topic", count: 1, files: ["Folder/Beta.md"] },
          { name: "open", count: 1, files: ["Alpha.md"] },
        ],
      },
    });

    const exact = await invoke(["--vault", vaultPath, "tags", "path=Alpha.md"]);
    expect(exact.stdout).toBe("#open\n#project\n");

    const total = await invoke(["--vault", vaultPath, "tags", "total"]);
    expect(total.stdout).toBe("3\n");

    const verbose = await invoke(["--vault", vaultPath, "tag", "name=#project", "verbose"]);
    expect(verbose.stdout).toBe("#project\t3\nAlpha.md\nFolder/Beta.md\n");

    const absent = await invoke(["--vault", vaultPath, "tag", "name=missing", "total"]);
    expect(absent.stdout).toBe("0\n");
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Threadleaf CLI compatibility catalogs", () => {
  it("projects contained plugin, theme, and snippet catalogs without executing code or exposing private state", async () => {
    const executionMarker = path.join(sandboxPath, "plugin-code-executed");
    const pluginDirectory = await writePlugin("catalog-plugin", {
      manifest: JSON.stringify({ id: "catalog-plugin", name: "Catalog plugin", version: "1.2.3" }),
      main: `require("node:fs").writeFileSync(${JSON.stringify(executionMarker)}, "executed");`,
      stylesheet: "body { --catalog-plugin: ready; }",
    });
    await writePlugin("broken-plugin", { manifest: "{", main: "throw new Error('not executed');" });
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "community-plugins.json"),
      '["catalog-plugin", "PRIVATE_PLUGIN_SELECTION"]',
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "appearance.json"),
      '{"theme":"PRIVATE_THEME_SELECTION","enabledSnippets":["PRIVATE_SNIPPET_SELECTION"]}',
      "utf8",
    );
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "hotkeys.json"),
      '{"PRIVATE_HOTKEY_MAPPING":"Mod+Shift+P"}',
      "utf8",
    );
    await writeTheme("Aether", {
      css: "body { --aether-private-css: no-output; }",
      manifest: JSON.stringify({ name: "Aether", version: "2.0.0" }),
    });
    await writeTheme("Paper", {
      css: "body { --paper-private-css: no-output; }",
      manifest: JSON.stringify({ name: "Paper", version: "1.0.0" }),
    });
    await writeSnippet("alpha.css", "body { --alpha-private-css: no-output; }");
    await writeSnippet("zeta.css", "body { --zeta-private-css: no-output; }");

    const pluginMainBefore = await fs.readFile(path.join(pluginDirectory, "main.js"));
    const pluginManifestBefore = await fs.readFile(path.join(pluginDirectory, "manifest.json"));
    const pluginStylesheetBefore = await fs.readFile(path.join(pluginDirectory, "styles.css"));

    const defaultPlugins = await invoke(["--vault", vaultPath, "plugins"]);
    expect(defaultPlugins).toEqual({
      exitCode: cliExitCodes.success,
      stdout:
        "broken-plugin\tbroken-plugin\tinvalid\ncatalog-plugin\tCatalog plugin\tready\nCatalog diagnostics: 1. Details are withheld from CLI output.\n",
      stderr: "",
    });

    const versionedPlugins = await invoke([
      "--vault",
      vaultPath,
      "plugins",
      "filter=community",
      "versions",
      "format=csv",
    ]);
    expect(versionedPlugins).toEqual({
      exitCode: cliExitCodes.success,
      stdout:
        "broken-plugin,broken-plugin,unknown,invalid\ncatalog-plugin,Catalog plugin,1.2.3,ready\nCatalog diagnostics: 1. Details are withheld from CLI output.\n",
      stderr: "",
    });

    const compatibilityPlugins = await invoke([
      "--vault",
      vaultPath,
      "plugins",
      "filter=community",
      "format=json",
    ]);
    expect(JSON.parse(compatibilityPlugins.stdout)).toMatchObject({
      sourceState: "present",
      diagnostics: 1,
      invalid: 1,
      total: 2,
      filter: "community",
      plugins: [
        { id: "broken-plugin", state: "invalid", version: "unknown" },
        {
          id: "catalog-plugin",
          name: "Catalog plugin",
          version: "1.2.3",
          state: "ready",
          stylesheetDiscovered: true,
        },
      ],
    });

    const pluginEnvelope = await invoke(["--json", "--vault", vaultPath, "plugins"]);
    const parsedPluginEnvelope = JSON.parse(pluginEnvelope.stdout);
    expect(parsedPluginEnvelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "plugins",
      data: { sourceState: "present", total: 2, invalid: 1 },
    });

    const pluginDetail = await invoke(["--vault", vaultPath, "plugin", "id=catalog-plugin"]);
    expect(pluginDetail).toEqual({
      exitCode: cliExitCodes.success,
      stdout:
        "Plugin: catalog-plugin\nName: Catalog plugin\nVersion: 1.2.3\nPackage state: ready\nStylesheet: present\nCompatibility evidence: level 0 (unverified)\n",
      stderr: "",
    });
    const pluginDetailEnvelope = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "plugin",
      "id=catalog-plugin",
    ]);
    expect(JSON.parse(pluginDetailEnvelope.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "plugin",
      data: {
        sourceState: "present",
        plugin: { id: "catalog-plugin", name: "Catalog plugin", state: "ready" },
      },
    });

    const themes = await invoke(["--vault", vaultPath, "themes"]);
    expect(themes).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Aether\nPaper\n",
      stderr: "",
    });
    const versionedThemes = await invoke(["--vault", vaultPath, "themes", "versions"]);
    expect(versionedThemes).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Aether\t2.0.0\nPaper\t1.0.0\n",
      stderr: "",
    });
    const themesEnvelope = await invoke(["--json", "--vault", vaultPath, "themes", "versions"]);
    expect(JSON.parse(themesEnvelope.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "themes",
      data: {
        sourceState: "present",
        total: 2,
        themes: [
          { id: "obsidian-theme:Aether", name: "Aether", version: "2.0.0" },
          { id: "obsidian-theme:Paper", name: "Paper", version: "1.0.0" },
        ],
      },
    });

    const theme = await invoke(["--vault", vaultPath, "theme", "name=paper"]);
    expect(theme).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Theme: Paper\nID: obsidian-theme:Paper\nVersion: 1.0.0\n",
      stderr: "",
    });
    const themeEnvelope = await invoke(["--json", "--vault", vaultPath, "theme", "name=Aether"]);
    expect(JSON.parse(themeEnvelope.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "theme",
      data: { sourceState: "present", theme: { name: "Aether", version: "2.0.0" } },
    });

    const snippets = await invoke(["--vault", vaultPath, "snippets"]);
    expect(snippets).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "alpha\nzeta\n",
      stderr: "",
    });
    const snippetsEnvelope = await invoke(["--json", "--vault", vaultPath, "snippets"]);
    expect(JSON.parse(snippetsEnvelope.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "snippets",
      data: {
        sourceState: "present",
        total: 2,
        snippets: [
          { id: "obsidian-snippet:alpha.css", name: "alpha" },
          { id: "obsidian-snippet:zeta.css", name: "zeta" },
        ],
      },
    });

    const repeatPlugins = await invoke(["--json", "--vault", vaultPath, "plugins"]);
    const repeatThemes = await invoke(["--vault", vaultPath, "themes", "versions"]);
    const repeatSnippets = await invoke(["--vault", vaultPath, "snippets"]);
    expect(repeatPlugins.stdout).toBe(pluginEnvelope.stdout);
    expect(repeatThemes.stdout).toBe(versionedThemes.stdout);
    expect(repeatSnippets.stdout).toBe(snippets.stdout);

    const allOutput = [
      defaultPlugins.stdout,
      versionedPlugins.stdout,
      compatibilityPlugins.stdout,
      pluginEnvelope.stdout,
      pluginDetail.stdout,
      pluginDetailEnvelope.stdout,
      themes.stdout,
      themesEnvelope.stdout,
      theme.stdout,
      themeEnvelope.stdout,
      snippets.stdout,
      snippetsEnvelope.stdout,
    ].join("\n");
    for (const privateValue of [
      vaultPath,
      "PRIVATE_PLUGIN_SELECTION",
      "PRIVATE_THEME_SELECTION",
      "PRIVATE_SNIPPET_SELECTION",
      "PRIVATE_HOTKEY_MAPPING",
      "--aether-private-css",
      "--alpha-private-css",
    ]) {
      expect(allOutput).not.toContain(privateValue);
    }
    await expect(fs.stat(executionMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(pluginDirectory, "main.js"))).resolves.toEqual(
      pluginMainBefore,
    );
    await expect(fs.readFile(path.join(pluginDirectory, "manifest.json"))).resolves.toEqual(
      pluginManifestBefore,
    );
    await expect(fs.readFile(path.join(pluginDirectory, "styles.css"))).resolves.toEqual(
      pluginStylesheetBefore,
    );
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("makes missing and uncontained sources explicit without exposing their paths", async () => {
    const missingPlugins = await invoke(["--vault", vaultPath, "plugins"]);
    const missingThemes = await invoke(["--vault", vaultPath, "themes"]);
    const missingSnippets = await invoke(["--vault", vaultPath, "snippets"]);
    expect(missingPlugins.stdout).toBe("No community plugin catalog source was found.\n");
    expect(missingThemes.stdout).toBe("No community theme catalog source was found.\n");
    expect(missingSnippets.stdout).toBe("No CSS snippet catalog source was found.\n");

    const missingPluginDetail = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "plugin",
      "id=missing",
    ]);
    const missingThemeDetail = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "theme",
      "name=Missing",
    ]);
    expect(missingPluginDetail.exitCode).toBe(cliExitCodes.vault);
    expect(missingThemeDetail.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(missingPluginDetail.stderr)).toMatchObject({
      command: "plugin",
      error: { code: "VAULT", details: { sourceState: "missing", diagnostics: 0 } },
    });
    expect(JSON.parse(missingThemeDetail.stderr)).toMatchObject({
      command: "theme",
      error: { code: "VAULT", details: { sourceState: "missing", diagnostics: 0 } },
    });

    const outsidePlugins = path.join(sandboxPath, "outside-plugins");
    const outsideThemes = path.join(sandboxPath, "outside-themes");
    const outsideSnippets = path.join(sandboxPath, "outside-snippets");
    await Promise.all([
      fs.mkdir(outsidePlugins),
      fs.mkdir(outsideThemes),
      fs.mkdir(outsideSnippets),
    ]);
    await Promise.all([
      fs.symlink(outsidePlugins, path.join(vaultPath, ".obsidian", "plugins")),
      fs.symlink(outsideThemes, path.join(vaultPath, ".obsidian", "themes")),
      fs.symlink(outsideSnippets, path.join(vaultPath, ".obsidian", "snippets")),
    ]);

    const unsafePlugins = await invoke(["--json", "--vault", vaultPath, "plugins"]);
    const unsafeThemes = await invoke(["--json", "--vault", vaultPath, "themes"]);
    const unsafeSnippets = await invoke(["--json", "--vault", vaultPath, "snippets"]);
    expect(JSON.parse(unsafePlugins.stdout)).toMatchObject({
      command: "plugins",
      data: { sourceState: "unreadable", total: 0, diagnostics: 1 },
    });
    expect(JSON.parse(unsafeThemes.stdout)).toMatchObject({
      command: "themes",
      data: { sourceState: "unreadable", total: 0, diagnostics: 1 },
    });
    expect(JSON.parse(unsafeSnippets.stdout)).toMatchObject({
      command: "snippets",
      data: { sourceState: "unreadable", total: 0, diagnostics: 1 },
    });
    const unsafeOutput = `${unsafePlugins.stdout}\n${unsafeThemes.stdout}\n${unsafeSnippets.stdout}`;
    for (const privateValue of [
      outsidePlugins,
      outsideThemes,
      outsideSnippets,
      sandboxPath,
      vaultPath,
    ]) {
      expect(unsafeOutput).not.toContain(privateValue);
    }
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps malformed and oversized catalog sources bounded and explicit", async () => {
    const oversizedPluginDirectory = await writePlugin("oversized-plugin", {
      manifest: JSON.stringify({
        id: "oversized-plugin",
        name: "Oversized plugin",
        version: "1.0.0",
      }),
    });
    await fs.writeFile(
      path.join(oversizedPluginDirectory, "main.js"),
      Buffer.alloc(16 * 1024 * 1024 + 1, 0x61),
    );
    await writePlugin("malformed-plugin", { manifest: "not-json" });
    const oversizedThemeDirectory = await writeTheme("Oversized theme", {
      manifest: JSON.stringify({ name: "Oversized theme", version: "1.0.0" }),
    });
    await fs.writeFile(
      path.join(oversizedThemeDirectory, "theme.css"),
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
    );
    await writeTheme("Malformed theme", { manifest: "not-json" });
    await writeSnippet("oversized.css", "placeholder");
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "snippets", "oversized.css"),
      Buffer.alloc(512 * 1024 + 1, 0x61),
    );

    const plugins = await invoke(["--json", "--vault", vaultPath, "plugins"]);
    const themes = await invoke(["--json", "--vault", vaultPath, "themes"]);
    const snippets = await invoke(["--json", "--vault", vaultPath, "snippets"]);
    expect(JSON.parse(plugins.stdout)).toMatchObject({
      command: "plugins",
      data: {
        sourceState: "present",
        diagnostics: 2,
        invalid: 2,
        total: 2,
        plugins: [
          { id: "malformed-plugin", state: "invalid" },
          { id: "oversized-plugin", state: "invalid" },
        ],
      },
    });
    expect(JSON.parse(themes.stdout)).toMatchObject({
      command: "themes",
      data: {
        sourceState: "present",
        diagnostics: 2,
        total: 1,
        themes: [{ name: "Malformed theme", version: null }],
      },
    });
    expect(JSON.parse(snippets.stdout)).toMatchObject({
      command: "snippets",
      data: { sourceState: "present", diagnostics: 1, total: 0, snippets: [] },
    });
    const output = `${plugins.stdout}\n${themes.stdout}\n${snippets.stdout}`;
    expect(output).not.toContain("file exceeds");
    expect(output).not.toContain(sandboxPath);
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Threadleaf CLI read-only workflows", () => {
  it("returns a stable vault info envelope without creating state or changing vault bytes", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
    const canonicalVaultPath = await fs.realpath(vaultPath);
    const result = await invoke(["--vault", vaultPath, "--json", "vault", "info"]);

    expect(result.exitCode).toBe(cliExitCodes.success);
    expect(result.stderr).toBe("");
    const envelope = JSON.parse(result.stdout);
    expect(Object.keys(envelope)).toEqual(["schemaVersion", "ok", "command", "data"]);
    expect(Object.keys(envelope.data)).toEqual([
      "name",
      "path",
      "vaultId",
      "markdownFiles",
      "headings",
      "tags",
      "links",
      "unresolvedLinks",
      "duplicateNames",
    ]);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "vault.info",
      data: {
        name: "vault",
        path: canonicalVaultPath,
        markdownFiles: 2,
        headings: 2,
        tags: 2,
        links: 1,
        unresolvedLinks: 0,
        duplicateNames: 0,
      },
    });
    expect(envelope.data.vaultId).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(before);
  });

  it("lists the visible vault corpus and keeps private application metadata excluded", async () => {
    const all = await invoke(["--vault", vaultPath, "files"]);
    expect(all).toEqual({
      exitCode: 0,
      stdout: "Alpha.md\nFolder/Beta.md\n",
      stderr: "",
    });

    const nested = await invoke(["--vault", vaultPath, "--json", "files", "--directory", "Folder"]);
    expect(JSON.parse(nested.stdout)).toMatchObject({
      command: "files",
      data: { folder: "Folder", total: 1, files: ["Folder/Beta.md"] },
    });

    const hidden = await invoke(["--vault", vaultPath, "files", "--directory", ".obsidian"]);
    expect(hidden.stdout).toBe("No vault files.\n");
  });

  it("lists and measures ordinary files and folders through the safe vault inventory", async () => {
    await fs.mkdir(path.join(vaultPath, "Folder", "Nested"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Empty"));
    await fs.mkdir(path.join(vaultPath, ".trash"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "Folder", "image.PNG"), "1234", "utf8");
    await fs.writeFile(path.join(vaultPath, "Folder", "Nested", "Board.canvas"), "{}", "utf8");
    await fs.writeFile(path.join(vaultPath, ".trash", "private.png"), "hidden", "utf8");

    const png = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "files",
      "folder=Folder",
      "ext=.png",
    ]);
    expect(JSON.parse(png.stdout)).toMatchObject({
      command: "files",
      data: {
        folder: "Folder",
        extension: "png",
        total: 1,
        files: ["Folder/image.PNG"],
      },
    });
    const fileTotal = await invoke(["--vault", vaultPath, "files", "folder=Folder", "total"]);
    expect(fileTotal.stdout).toBe("3\n");

    const folders = await invoke(["--json", "--vault", vaultPath, "folders"]);
    expect(JSON.parse(folders.stdout).data).toEqual({
      folder: "",
      total: 3,
      folders: ["Empty", "Folder", "Folder/Nested"],
    });
    const nestedFolders = await invoke(["--vault", vaultPath, "folders", "folder=Folder", "total"]);
    expect(nestedFolders.stdout).toBe("1\n");

    const folderInfo = await invoke(["--json", "--vault", vaultPath, "folder", "path=Folder"]);
    expect(JSON.parse(folderInfo.stdout).data).toEqual({
      path: "Folder",
      files: 3,
      folders: 1,
      size: 4 + 2 + Buffer.byteLength("# Beta heading\n\nA local target.\n"),
    });
    const folderSize = await invoke(["--vault", vaultPath, "folder", "path=Folder", "info=size"]);
    expect(folderSize.stdout).toBe(
      `${4 + 2 + Buffer.byteLength("# Beta heading\n\nA local target.\n")}\n`,
    );

    const fileInfo = await invoke(["--json", "--vault", vaultPath, "file", "file=image.png"]);
    expect(JSON.parse(fileInfo.stdout)).toMatchObject({
      command: "file",
      data: {
        path: "Folder/image.PNG",
        name: "image",
        extension: "PNG",
        size: 4,
        created: expect.any(Number),
        modified: expect.any(Number),
      },
    });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails explicitly for ambiguous file info and hidden or missing folder targets", async () => {
    await fs.writeFile(path.join(vaultPath, "Beta.png"), "image", "utf8");
    const ambiguous = await invoke(["--json", "--vault", vaultPath, "file", "file=Beta"]);
    expect(ambiguous.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject({
      command: "file",
      error: {
        code: "VAULT",
        message: expect.stringMatching(/Ambiguous file=Beta.*Beta\.png.*Folder\/Beta\.md/),
      },
    });

    const exactAttachment = await invoke(["--json", "--vault", vaultPath, "file", "file=beta.png"]);
    expect(JSON.parse(exactAttachment.stdout).data.path).toBe("Beta.png");

    for (const folder of ["Missing", ".obsidian"]) {
      const result = await invoke(["--json", "--vault", vaultPath, "folder", `path=${folder}`]);
      expect(result.exitCode).toBe(cliExitCodes.vault);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "VAULT" } });
    }
    const hiddenFile = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "file",
      "path=.obsidian/Hidden.md",
    ]);
    expect(hiddenFile.exitCode).toBe(cliExitCodes.vault);

    const hiddenWordcount = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "wordcount",
      "path=.obsidian/Hidden.md",
    ]);
    expect(hiddenWordcount.exitCode).toBe(cliExitCodes.vault);
  });

  it("counts Unicode words and grapheme characters from exact source text", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Stats.md"),
      "\uFEFFHello, world! 👨‍👩‍👧‍👦\nCaf\u00e9",
      "utf8",
    );
    const counted = await invoke(["--json", "--vault", vaultPath, "wordcount", "file=stats"]);
    expect(JSON.parse(counted.stdout)).toMatchObject({
      command: "wordcount",
      data: { path: "Stats.md", words: 3, characters: 20 },
    });
    const words = await invoke(["--vault", vaultPath, "wordcount", "path=Stats.md", "words"]);
    expect(words.stdout).toBe("3\n");
    const characters = await invoke([
      "--vault",
      vaultPath,
      "wordcount",
      "file=Stats.md",
      "characters",
    ]);
    expect(characters.stdout).toBe("20\n");
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads exact Markdown through native and compatibility path syntax", async () => {
    const expected = await fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8");
    const native = await invoke(["--vault", vaultPath, "read", "Folder/Beta.md"]);
    expect(native).toEqual({ exitCode: 0, stdout: expected, stderr: "" });

    const compatible = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "read",
      "file=Folder/Beta.md",
    ]);
    expect(JSON.parse(compatible.stdout)).toMatchObject({
      command: "read",
      data: { path: "Folder/Beta.md", content: expected, size: Buffer.byteLength(expected) },
    });
  });

  it("fails closed on traversal and hidden-note reads", async () => {
    const traversal = await invoke(["--json", "--vault", vaultPath, "read", "../outside.md"]);
    expect(traversal.exitCode).toBe(cliExitCodes.vault);
    expect(traversal.stdout).toBe("");
    expect(JSON.parse(traversal.stderr)).toMatchObject({ error: { code: "VAULT" } });

    const hidden = await invoke(["--json", "--vault", vaultPath, "read", ".obsidian/Hidden.md"]);
    expect(hidden.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(hidden.stderr).error.message).toContain("private application paths");
  });

  it("separates path search from grep-style context and supports filters and formats", async () => {
    const human = await invoke(["--vault", vaultPath, "search", "needle"]);
    expect(human).toEqual({ exitCode: 0, stdout: "Alpha.md\n", stderr: "" });

    const context = await invoke(["--vault", vaultPath, "search:context", "query=needle"]);
    expect(context.stdout).toBe("Alpha.md:7: A distinctive needle links to [[Folder/Beta]].\n");

    const json = await invoke([
      "--vault",
      vaultPath,
      "search",
      "query=local target",
      "--limit",
      "5",
      "--json",
    ]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      command: "search",
      data: {
        query: "local target",
        folder: "",
        caseSensitive: false,
        total: 1,
        truncated: false,
        results: [{ path: "Folder/Beta.md", title: "Beta" }],
      },
    });

    const scopedJson = await invoke([
      "--vault",
      vaultPath,
      "search",
      "query=local",
      "path=Folder",
      "format=json",
    ]);
    expect(JSON.parse(scopedJson.stdout)).toEqual(["Folder/Beta.md"]);

    const contextJson = await invoke([
      "--vault",
      vaultPath,
      "search:context",
      "query=needle",
      "format=json",
    ]);
    expect(JSON.parse(contextJson.stdout)).toEqual([
      {
        path: "Alpha.md",
        line: 7,
        text: "A distinctive needle links to [[Folder/Beta]].",
      },
    ]);

    const scopedOut = await invoke(["--vault", vaultPath, "search", "query=needle", "path=Folder"]);
    expect(scopedOut.stdout).toBe("");

    const caseSensitive = await invoke([
      "--vault",
      vaultPath,
      "search",
      "query=Needle",
      "case",
      "total",
    ]);
    expect(caseSensitive.stdout).toBe("0\n");
  });

  it("searches Latin diacritics through native search and context compatibility output", async () => {
    const folder = path.join(vaultPath, "Français");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, "Café.md"),
      ["# Café heading", "", "const café = true;"].join("\n"),
      "utf8",
    );

    const paths = await invoke(["--vault", vaultPath, "search", "query=cafe"]);
    expect(paths).toEqual({ exitCode: 0, stdout: "Français/Café.md\n", stderr: "" });

    const json = await invoke(["--vault", vaultPath, "search", "query=café", "format=json"]);
    expect(JSON.parse(json.stdout)).toEqual(["Français/Café.md"]);

    const caseSensitive = await invoke([
      "--vault",
      vaultPath,
      "search",
      "query=Cafe",
      "case",
      "total",
    ]);
    expect(caseSensitive.stdout).toBe("1\n");
    const wrongCase = await invoke(["--vault", vaultPath, "search", "query=CAFE", "case", "total"]);
    expect(wrongCase.stdout).toBe("0\n");

    const context = await invoke([
      "--vault",
      vaultPath,
      "search:context",
      "query=cafe",
      "format=json",
    ]);
    expect(JSON.parse(context.stdout)).toEqual([
      { path: "Français/Café.md", line: 1, text: "# Café heading" },
      { path: "Français/Café.md", line: 3, text: "const café = true;" },
    ]);
    await expect(fs.readFile(path.join(folder, "Café.md"), "utf8")).resolves.toBe(
      "# Café heading\n\nconst café = true;",
    );
  });

  it("keeps Prepend interiors out of CLI counts and context output", async () => {
    const folder = path.join(vaultPath, "Prepend");
    await fs.mkdir(folder, { recursive: true });
    const prepends = ["\u0600", "\u0890", String.fromCodePoint(0x110bd)];
    const source = [...prepends.map((prepend) => `${prepend}needle`), "needle"].join("\n");
    await fs.writeFile(path.join(folder, "Controls.md"), source, "utf8");

    const total = await invoke([
      "--vault",
      vaultPath,
      "search",
      "query=needle",
      "path=Prepend",
      "total",
    ]);
    expect(total.stdout).toBe("1\n");

    const context = await invoke([
      "--vault",
      vaultPath,
      "search:context",
      "query=needle",
      "path=Prepend",
      "format=json",
    ]);
    expect(JSON.parse(context.stdout)).toEqual([
      { path: "Prepend/Controls.md", line: 4, text: "needle" },
    ]);

    const prependOnly = await invoke([
      "--vault",
      vaultPath,
      "search",
      `query=${prepends[0]}`,
      "path=Prepend",
    ]);
    expect(prependOnly.stdout).toBe("");
  });

  it("uses the query exit code and stderr envelope for invalid search input", async () => {
    const result = await invoke(["--json", "--vault", vaultPath, "search", "x".repeat(257)]);
    expect(result.exitCode).toBe(cliExitCodes.query);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      command: "search",
      error: { code: "QUERY", message: expect.stringContaining("at most 256") },
    });
  });
});

describe("Threadleaf CLI graph and outline workflows", () => {
  beforeEach(async () => {
    await fs.writeFile(
      path.join(vaultPath, "Graph.md"),
      [
        "# Graph root",
        "",
        "### Deep branch",
        "",
        "[[Folder/Beta]]",
        "[[Folder/Beta#Beta heading|B]]",
        "[[Missing]]",
        "[[Dup]]",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.mkdir(path.join(vaultPath, "One"), { recursive: true });
    await fs.mkdir(path.join(vaultPath, "Two"), { recursive: true });
    await fs.writeFile(path.join(vaultPath, "One", "Dup.md"), "# First duplicate\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Two", "Dup.md"), "# Second duplicate\n", "utf8");
    await fs.writeFile(path.join(vaultPath, "Lonely.md"), "No links here.\n", "utf8");
  });

  it("lists ordered outgoing occurrences with explicit resolution states", async () => {
    const result = await invoke(["--json", "--vault", vaultPath, "links", "path=Graph.md"]);

    expect(result.exitCode).toBe(cliExitCodes.success);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "links",
      data: {
        path: "Graph.md",
        total: 4,
        links: [
          {
            target: "Folder/Beta",
            subpath: null,
            alias: null,
            embed: false,
            syntax: "wiki",
            resolution: { status: "resolved", path: "Folder/Beta.md" },
          },
          {
            target: "Folder/Beta",
            subpath: "#Beta heading",
            alias: "B",
            resolution: { status: "resolved", path: "Folder/Beta.md" },
          },
          { target: "Missing", resolution: { status: "unresolved" } },
          {
            target: "Dup",
            resolution: {
              status: "ambiguous",
              candidates: ["One/Dup.md", "Two/Dup.md"],
            },
          },
        ],
      },
    });

    const human = await invoke(["--vault", vaultPath, "links", "Graph.md"]);
    expect(human.stdout).toBe("Folder/Beta\nFolder/Beta#Beta heading\nMissing\nDup\n");
    const total = await invoke(["--vault", vaultPath, "links", "Graph.md", "total"]);
    expect(total.stdout).toBe("4\n");
  });

  it("groups backlinks by source while retaining occurrence counts", async () => {
    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "backlinks",
      "file=Folder/Beta.md",
    ]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "backlinks",
      data: {
        path: "Folder/Beta.md",
        total: 2,
        occurrences: 3,
        backlinks: [
          { path: "Alpha.md", count: 1 },
          { path: "Graph.md", count: 2 },
        ],
      },
    });
    const human = await invoke(["--vault", vaultPath, "backlinks", "Folder/Beta.md"]);
    expect(human.stdout).toBe("Alpha.md\nGraph.md\n");

    const counted = await invoke(["--vault", vaultPath, "backlinks", "Folder/Beta.md", "counts"]);
    expect(counted.stdout).toBe("Alpha.md\t1\nGraph.md\t2\n");
    const rawJson = await invoke([
      "--vault",
      vaultPath,
      "backlinks",
      "Folder/Beta.md",
      "counts",
      "format=json",
    ]);
    expect(JSON.parse(rawJson.stdout)).toEqual([
      { path: "Alpha.md", count: 1 },
      { path: "Graph.md", count: 2 },
    ]);
    const total = await invoke(["--vault", vaultPath, "backlinks", "Folder/Beta.md", "total"]);
    expect(total.stdout).toBe("2\n");

    await fs.writeFile(path.join(vaultPath, "Comma, Source.md"), "[[Folder/Beta]]\n", "utf8");
    const csv = await invoke([
      "--vault",
      vaultPath,
      "backlinks",
      "Folder/Beta.md",
      "counts",
      "format=csv",
    ]);
    expect(csv.stdout).toBe('Alpha.md,1\n"Comma, Source.md",1\nGraph.md,2\n');
  });

  it("reports every unresolved or ambiguous occurrence with its source", async () => {
    const result = await invoke(["--json", "--vault", vaultPath, "unresolved"]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "unresolved",
      data: {
        total: 2,
        links: [
          {
            sourcePath: "Graph.md",
            target: "Missing",
            resolution: { status: "unresolved" },
          },
          {
            sourcePath: "Graph.md",
            target: "Dup",
            resolution: {
              status: "ambiguous",
              candidates: ["One/Dup.md", "Two/Dup.md"],
            },
          },
        ],
      },
    });
    const human = await invoke(["--vault", vaultPath, "unresolved"]);
    expect(human.stdout).toBe("Dup\nMissing\n");
    const detailed = await invoke(["--vault", vaultPath, "unresolved", "counts", "verbose"]);
    expect(detailed.stdout).toBe("Dup\t1\tGraph.md\nMissing\t1\tGraph.md\n");
    const rawJson = await invoke([
      "--vault",
      vaultPath,
      "unresolved",
      "counts",
      "verbose",
      "format=json",
    ]);
    expect(JSON.parse(rawJson.stdout)).toEqual([
      { target: "Dup", count: 1, sources: ["Graph.md"] },
      { target: "Missing", count: 1, sources: ["Graph.md"] },
    ]);
    const total = await invoke(["--vault", vaultPath, "unresolved", "total"]);
    expect(total.stdout).toBe("2\n");
  });

  it("aggregates repeated unresolved targets while retaining occurrence evidence", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Repeated.md"),
      "[[Missing]] and [[Missing]]\n",
      "utf8",
    );
    const result = await invoke(["--json", "--vault", vaultPath, "unresolved"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        total: 2,
        occurrences: 4,
        entries: [
          { target: "Dup", count: 1, sources: ["Graph.md"] },
          { target: "Missing", count: 3, sources: ["Graph.md", "Repeated.md"] },
        ],
      },
    });
  });

  it("lists orphans and syntax-level dead ends deterministically", async () => {
    const orphans = await invoke(["--json", "--vault", vaultPath, "orphans"]);
    expect(JSON.parse(orphans.stdout)).toMatchObject({
      command: "orphans",
      data: {
        total: 5,
        files: ["Alpha.md", "Graph.md", "Lonely.md", "One/Dup.md", "Two/Dup.md"],
      },
    });

    const deadends = await invoke(["--json", "--vault", vaultPath, "deadends"]);
    expect(JSON.parse(deadends.stdout)).toMatchObject({
      command: "deadends",
      data: {
        total: 4,
        files: ["Folder/Beta.md", "Lonely.md", "One/Dup.md", "Two/Dup.md"],
      },
    });
    expect((await invoke(["--vault", vaultPath, "orphans", "total"])).stdout).toBe("5\n");
    expect((await invoke(["--vault", vaultPath, "deadends", "total"])).stdout).toBe("4\n");
  });

  it("returns a line-aware outline and never creates CLI state", async () => {
    const result = await invoke(["--json", "--vault", vaultPath, "outline", "Graph.md"]);

    expect(JSON.parse(result.stdout)).toMatchObject({
      command: "outline",
      data: {
        path: "Graph.md",
        total: 2,
        headings: [
          { level: 1, text: "Graph root", line: 1 },
          { level: 3, text: "Deep branch", line: 3 },
        ],
      },
    });
    const human = await invoke(["--vault", vaultPath, "outline", "path=Graph.md"]);
    expect(human.stdout).toBe("Graph root\n    Deep branch\n");
    const markdown = await invoke(["--vault", vaultPath, "outline", "path=Graph.md", "format=md"]);
    expect(markdown.stdout).toBe("# Graph root\n### Deep branch\n");
    const rawJson = await invoke(["--vault", vaultPath, "outline", "path=Graph.md", "format=json"]);
    expect(JSON.parse(rawJson.stdout)).toEqual([
      { level: 1, text: "Graph root", line: 1 },
      { level: 3, text: "Deep branch", line: 3 },
    ]);
    expect((await invoke(["--vault", vaultPath, "outline", "Graph.md", "total"])).stdout).toBe(
      "2\n",
    );
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a target note is missing, private, or not Markdown", async () => {
    for (const target of ["Missing.md", ".obsidian/Hidden.md", "asset.png"]) {
      const result = await invoke(["--json", "--vault", vaultPath, "links", `path=${target}`]);
      expect(result.exitCode).toBe(cliExitCodes.vault);
      expect(JSON.parse(result.stderr)).toMatchObject({
        command: "links",
        error: { code: "VAULT" },
      });
    }
  });
});
