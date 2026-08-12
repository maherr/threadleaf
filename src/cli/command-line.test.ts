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
    for (const name of ["links", "backlinks", "outline"] as const) {
      expect(parseCliArguments(["--vault=/vault", name, "path=Folder/Note.md"])).toMatchObject({
        id: name,
        filePath: "Folder/Note.md",
      });
    }
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
      "does not accept arguments",
    );
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
  });
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

describe("Threadleaf CLI read-only workflows", () => {
  it("returns a stable vault info envelope without creating state or changing vault bytes", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8");
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
        path: vaultPath,
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

  it("searches indexed content in human and JSON modes", async () => {
    const human = await invoke(["--vault", vaultPath, "search", "needle"]);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Alpha.md:7 [content]");
    expect(human.stdout).toContain("distinctive needle");

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
        total: 1,
        truncated: false,
        results: [{ path: "Folder/Beta.md", title: "Beta" }],
      },
    });
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
    expect(human.stdout).toBe(
      [
        "Outgoing links from Graph.md:",
        "Folder/Beta [wiki] -> Folder/Beta.md",
        "Folder/Beta#Beta heading [wiki] as B -> Folder/Beta.md",
        "Missing [wiki] -> unresolved",
        "Dup [wiki] -> ambiguous: One/Dup.md, Two/Dup.md",
        "",
      ].join("\n"),
    );
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
    expect(human.stdout).toBe("Backlinks to Folder/Beta.md:\nAlpha.md (1)\nGraph.md (2)\n");
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
    expect(human.stdout).toBe(
      [
        "Non-resolved links:",
        "Graph.md: Missing [wiki] -> unresolved",
        "Graph.md: Dup [wiki] -> ambiguous: One/Dup.md, Two/Dup.md",
        "",
      ].join("\n"),
    );
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
    expect(human.stdout).toBe(
      "Outline for Graph.md:\nGraph root (line 1)\n    Deep branch (line 3)\n",
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
