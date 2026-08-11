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
