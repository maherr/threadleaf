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
    expect(parseCliArguments(["read", "file=Folder/Note.md", "--vault=/vault"])).toMatchObject({
      id: "read",
      filePath: "Folder/Note.md",
    });
    expect(parseCliArguments(["read", "path=Folder/Note.md", "--vault=/vault"])).toMatchObject({
      id: "read",
      filePath: "Folder/Note.md",
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
      targetPath: "Archive/Old.md",
    });
    expect(
      parseCliArguments(["rename", "Folder/Old.md", "--name", "New", "--vault", "/vault"]),
    ).toMatchObject({
      id: "rename",
      sourcePath: "Folder/Old.md",
      targetPath: "Folder/New.md",
    });
    expect(parseCliArguments(["--vault=/vault", "delete", "path=Folder/Old.md"])).toMatchObject({
      id: "delete",
      filePath: "Folder/Old.md",
    });
    expect(parseCliArguments(["--vault=/vault", "restore", "file=Folder/Old.md"])).toMatchObject({
      id: "restore",
      filePath: "Folder/Old.md",
    });
    expect(parseCliArguments(["--vault=/vault", "trash", "list"])).toMatchObject({
      id: "trash.list",
    });
    expect(parseCliArguments(["--vault=/vault", "trash:list"])).toMatchObject({
      id: "trash.list",
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
  });

  it("shows help without requiring a vault", async () => {
    const result = await invoke(["--help"]);
    expect(result).toEqual({ exitCode: 0, stdout: cliHelp, stderr: "" });
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

  it("blocks a rename that would change a resolved link and reports the exact blocker", async () => {
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
          status: "blocked",
          from: "Folder/Beta.md",
          to: "Folder/Gamma.md",
          blockers: [
            {
              documentPath: "Alpha.md",
              target: "Folder/Beta",
              before: { status: "resolved", path: "Folder/Beta.md" },
              after: { status: "unresolved" },
            },
          ],
        },
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Alpha.md"), "utf8")).resolves.toBe(alphaBefore);
    await expect(fs.readFile(path.join(vaultPath, "Folder", "Beta.md"), "utf8")).resolves.toBe(
      betaBefore,
    );
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

  it("lists the canonical note corpus and keeps hidden application metadata excluded", async () => {
    const all = await invoke(["--vault", vaultPath, "files"]);
    expect(all).toEqual({
      exitCode: 0,
      stdout: "Alpha.md\nFolder/Beta.md\n",
      stderr: "",
    });

    const nested = await invoke(["--vault", vaultPath, "--json", "files", "--directory", "Folder"]);
    expect(JSON.parse(nested.stdout)).toMatchObject({
      command: "files",
      data: { directory: "Folder", total: 1, files: ["Folder/Beta.md"] },
    });

    const hidden = await invoke(["--vault", vaultPath, "files", "--directory", ".obsidian"]);
    expect(hidden.stdout).toBe("No Markdown files.\n");
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
    expect(JSON.parse(hidden.stderr).error.message).toContain("not indexed");
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
