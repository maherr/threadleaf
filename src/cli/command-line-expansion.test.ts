import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { type CliIo, cliExitCodes, parseCliArguments, runCli } from "./command-line";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-expansion-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Empty folder"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Note.md"),
    ["---", "tags: [alpha, beta]", "---", "", "# Note", "", "- [ ] first", "- [x] done", ""].join(
      "\n",
    ),
    "utf8",
  );
  await fs.writeFile(path.join(vaultPath, "asset.bin"), Buffer.from([1, 2, 3]));
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function capture(): { io: CliIo; stdout(): string; stderr(): string } {
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

async function invoke(args: readonly string[], now = moment("2026-08-13T12:00:00Z")) {
  const captured = capture();
  const exitCode = await runCli(args, captured.io, {
    stateRoot: new FixedStateRoot(statePath),
    now,
  });
  return { exitCode, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe("remaining safe CLI compatibility commands", () => {
  it("supports global help and deterministic command-specific help", async () => {
    expect(parseCliArguments(["help", "search"])).toMatchObject({
      id: "help",
      topic: "search",
    });
    const help = await invoke(["help", "search"]);
    expect(help).toEqual({
      exitCode: cliExitCodes.success,
      stdout:
        "Threadleaf help for search\n\nthreadleaf --vault <path> [--json] search query=<text> [path=<folder>] [limit=<n>] [format=text|json] [total] [case]\n",
      stderr: "",
    });

    const jsonHelp = await invoke(["--json", "help", "tags"]);
    expect(JSON.parse(jsonHelp.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "help",
      data: { usage: expect.stringContaining("tags") },
    });

    const aliasHelp = await invoke(["help", "vault:info"]);
    expect(aliasHelp.stdout).toContain("threadleaf --vault <path> [--json] vault info");

    const unknown = await invoke(["help", "open"]);
    expect(unknown.exitCode).toBe(cliExitCodes.usage);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown help topic: open");
  });

  it("projects safe vault info selectors without building CLI state", async () => {
    const name = await invoke(["--vault", vaultPath, "vault", "info=name"]);
    expect(name).toEqual({ exitCode: 0, stdout: "vault\n", stderr: "" });

    const canonicalPath = await fs.realpath(vaultPath);
    const pathInfo = await invoke(["--json", "--vault", vaultPath, "vault", "info=path"]);
    expect(JSON.parse(pathInfo.stdout)).toMatchObject({
      command: "vault.info",
      data: { info: "path", value: canonicalPath },
    });

    const files = await invoke(["--vault", vaultPath, "vault:info", "info=files"]);
    expect(files.stdout).toBe("2\n");
    const folders = await invoke(["--vault", vaultPath, "vault", "info=folders"]);
    expect(folders.stdout).toBe("1\n");
    const size = await invoke(["--vault", vaultPath, "vault", "info=size"]);
    expect(size.stdout).toBe("63\n");
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(parseCliArguments(["--vault", "/vault", "vault"])).toMatchObject({
      id: "vault.info",
      info: null,
    });
  });

  it("overwrites only with an explicit recoverable create flag", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Note.md"), "utf8");
    const refused = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "create",
      "Note",
      "content=replacement",
    ]);
    expect(refused.exitCode).toBe(cliExitCodes.conflict);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      command: "create",
      error: { code: "CONFLICT", details: { status: "exists" } },
    });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe(before);

    const overwritten = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "create",
      "Note",
      "content=replacement",
      "overwrite",
    ]);
    expect(overwritten.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(overwritten.stdout)).toMatchObject({
      command: "create",
      data: {
        status: "committed",
        path: "Note.md",
        overwritten: true,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toBe("replacement");

    const created = await invoke([
      "--vault",
      vaultPath,
      "create",
      "New note",
      "content=created",
      "overwrite",
    ]);
    expect(created).toEqual({ exitCode: 0, stdout: "Created New note.md\n", stderr: "" });
    await expect(fs.readFile(path.join(vaultPath, "New note.md"), "utf8")).resolves.toBe("created");
  });

  it("targets daily tasks through the same exact note and writer services", async () => {
    const dailyPath = path.join(vaultPath, "2026-08-13.md");
    await fs.writeFile(dailyPath, "- [ ] daily item\n", "utf8");

    const listed = await invoke(["--vault", vaultPath, "tasks", "daily", "format=tsv"]);
    expect(listed).toEqual({
      exitCode: 0,
      stdout: "2026-08-13.md\t1\t \tdaily item\n",
      stderr: "",
    });

    const changed = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "task",
      "daily",
      "line=1",
      "done",
    ]);
    expect(JSON.parse(changed.stdout)).toMatchObject({
      command: "task",
      data: {
        status: "committed",
        task: { path: "2026-08-13.md", line: 1, status: "x", completed: true },
      },
    });
    await expect(fs.readFile(dailyPath, "utf8")).resolves.toBe("- [x] daily item\n");

    const jsonTasks = await invoke(["--vault", vaultPath, "tasks", "daily", "format=json"]);
    expect(JSON.parse(jsonTasks.stdout)).toMatchObject([
      { path: "2026-08-13.md", line: 1, status: "x", completed: true, text: "daily item" },
    ]);
  });

  it("adds the documented tasks and tags output formats without changing rich JSON", async () => {
    const textTasks = await invoke(["--vault", vaultPath, "tasks", "format=text"]);
    expect(textTasks.stdout).toContain("- [ ] first");

    const tasks = await invoke(["--vault", vaultPath, "tasks", "format=json"]);
    expect(JSON.parse(tasks.stdout)).toMatchObject([
      { path: "Note.md", line: 7, status: " ", completed: false, text: "first" },
      { path: "Note.md", line: 8, status: "x", completed: true, text: "done" },
    ]);

    const tags = await invoke(["--vault", vaultPath, "tags", "counts", "format=csv"]);
    expect(tags).toEqual({
      exitCode: 0,
      stdout: "#alpha,1\n#beta,1\n",
      stderr: "",
    });

    const textTags = await invoke(["--vault", vaultPath, "tags", "format=text"]);
    expect(textTags.stdout).toBe("#alpha\n#beta\n");

    const tagJson = await invoke(["--vault", vaultPath, "tags", "counts", "format=json"]);
    expect(JSON.parse(tagJson.stdout)).toEqual([
      { name: "alpha", count: 1 },
      { name: "beta", count: 1 },
    ]);
  });

  it("quotes delimiter-bearing task fields in tabular output", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Tabular.md"),
      '- [ ] first\tsecond "quoted"\n',
      "utf8",
    );
    const tsv = await invoke(["--vault", vaultPath, "tasks", "path=Tabular.md", "format=tsv"]);
    expect(tsv.stdout).toBe('Tabular.md\t1\t \t"first\tsecond ""quoted"""\n');

    const csv = await invoke(["--vault", vaultPath, "tasks", "path=Tabular.md", "format=csv"]);
    expect(csv.stdout).toBe('Tabular.md,1, ,"first\tsecond ""quoted"""\n');
  });
});
