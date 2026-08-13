import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutateMarkdownNoteText } from "../application/note-text-mutation";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { type CliIo, cliExitCodes, parseCliArguments, runCli } from "./command-line";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-daily-template-random-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Templates", "Nested"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Journal"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Notes"), { recursive: true });
  await fs.mkdir(path.join(vaultPath, "Empty"), { recursive: true });
  await fs.writeFile(
    path.join(vaultPath, "Templates", "Daily.md"),
    "# {{title}}\r\n{{date}} {{time}}\r\nUTF-8: café\r\n",
    "utf8",
  );
  await fs.writeFile(path.join(vaultPath, "Templates", "Nested", "Zed.md"), "nested\n", "utf8");
  await fs.writeFile(path.join(vaultPath, "One.md"), "one\n", "utf8");
  await fs.writeFile(path.join(vaultPath, "Notes", "Two.md"), "two\n", "utf8");
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

async function invoke(
  args: readonly string[],
  options: Parameters<typeof runCli>[2] = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const captured = capture();
  const exitCode = await runCli(args, captured.io, {
    stateRoot: new FixedStateRoot(statePath),
    now: moment.parseZone("2026-08-12T18:07:09-04:00"),
    ...options,
  });
  return { exitCode, stdout: captured.stdout(), stderr: captured.stderr() };
}

describe("headless daily, template, and random compatibility", () => {
  it("parses the new command families with explicit options", () => {
    expect(
      parseCliArguments(["--vault", "/vault", "daily:path", "folder=Journal", "format=[Today]"]),
    ).toMatchObject({ id: "daily.path", folder: "Journal", format: "[Today]" });
    expect(
      parseCliArguments(["--vault", "/vault", "daily:append", "content=Lead\\ntext", "inline"]),
    ).toMatchObject({ id: "daily.append", content: "Lead\ntext", inline: true });
    expect(
      parseCliArguments([
        "--vault",
        "/vault",
        "template:read",
        "name=Daily",
        "folder=Templates",
        "title=Custom",
        "resolve",
      ]),
    ).toMatchObject({
      id: "template.read",
      templatePath: "Daily.md",
      templateTargetKind: "name",
      title: "Custom",
      resolve: true,
    });
    expect(parseCliArguments(["--vault", "/vault", "random:read", "folder=Notes"])).toMatchObject({
      id: "random.read",
      folder: "Notes",
    });
    expect(() =>
      parseCliArguments(["--vault", "/vault", "daily:read", "folder=Journal", "folder=Notes"]),
    ).toThrow("folder may be supplied only once");
  });

  it("returns a deterministic daily path and reads without writing vault or state bytes", async () => {
    const before = await fs.readFile(path.join(vaultPath, "Templates", "Daily.md"));
    const pathResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "daily:path",
      "folder=Journal",
      "format=[Today]",
    ]);
    expect(JSON.parse(pathResult.stdout)).toMatchObject({
      ok: true,
      command: "daily.path",
      data: { path: "Journal/Today.md" },
    });
    await expect(fs.stat(path.join(vaultPath, "Journal", "Today.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(vaultPath, "Templates", "Daily.md"))).resolves.toEqual(
      before,
    );
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });

    const missingRead = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "daily:read",
      "folder=Journal",
      "format=[Today]",
    ]);
    expect(missingRead.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(missingRead.stderr)).toMatchObject({ error: { code: "VAULT" } });
  });

  it("creates an absent daily note, preserves an existing one, and mutates through shared text service", async () => {
    const create = await invoke([
      "--vault",
      vaultPath,
      "daily",
      "folder=Journal",
      "format=[Today]",
      "template=Templates/Daily.md",
      "date-format=[DATE]",
      "time-format=[TIME]",
    ]);
    expect(create).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Created Journal/Today.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")).resolves.toBe(
      "# Today\r\nDATE TIME\r\nUTF-8: café\r\n",
    );

    const append = await invoke([
      "--vault",
      vaultPath,
      "daily:append",
      "folder=Journal",
      "format=[Today]",
      "content=append",
    ]);
    expect(append).toEqual({
      exitCode: cliExitCodes.success,
      stdout: "Appended Journal/Today.md\n",
      stderr: "",
    });
    await expect(fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")).resolves.toBe(
      "# Today\r\nDATE TIME\r\nUTF-8: café\r\n\r\nappend",
    );

    const prepend = await invoke([
      "--vault",
      vaultPath,
      "daily:prepend",
      "folder=Journal",
      "format=[Today]",
      "content=lead",
    ]);
    expect(prepend.stdout).toBe("Prepended Journal/Today.md\n");
    await expect(fs.readFile(path.join(vaultPath, "Journal", "Today.md"), "utf8")).resolves.toBe(
      "lead\r\n# Today\r\nDATE TIME\r\nUTF-8: café\r\n\r\nappend",
    );

    const reopened = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "daily:read",
      "folder=Journal",
      "format=[Today]",
    ]);
    expect(JSON.parse(reopened.stdout)).toMatchObject({
      ok: true,
      command: "daily.read",
      data: {
        path: "Journal/Today.md",
        content: "lead\r\n# Today\r\nDATE TIME\r\nUTF-8: café\r\n\r\nappend",
      },
    });
  });

  it("daily prepends preserve a leading BOM through the recoverable writer", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Journal", "Today.md"),
      Buffer.from("\ufeff---\r\ntags: [daily]\r\n---\r\nBody\r\n", "utf8"),
    );

    const result = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "daily:prepend",
      "folder=Journal",
      "format=[Today]",
      "content=Lead",
    ]);

    expect(result.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "daily.prepend",
      data: { status: "committed", path: "Journal/Today.md" },
    });
    await expect(fs.readFile(path.join(vaultPath, "Journal", "Today.md"))).resolves.toEqual(
      Buffer.from("\ufeff---\r\ntags: [daily]\r\n---\r\nLead\r\nBody\r\n", "utf8"),
    );
  });

  it("lists templates deterministically and resolves a bounded UTF-8 template without mutating it", async () => {
    const source = await fs.readFile(path.join(vaultPath, "Templates", "Daily.md"));
    const listed = await invoke(["--json", "--vault", vaultPath, "templates", "folder=Templates"]);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      ok: true,
      command: "templates",
      data: {
        folder: "Templates",
        templates: ["Templates/Daily.md", "Templates/Nested/Zed.md"],
        total: 2,
      },
    });
    expect(
      (await invoke(["--vault", vaultPath, "templates", "folder=Templates", "total"])).stdout,
    ).toBe("2\n");

    const raw = await invoke([
      "--vault",
      vaultPath,
      "template:read",
      "name=Daily",
      "folder=Templates",
    ]);
    expect(raw.exitCode).toBe(cliExitCodes.success);
    expect(raw.stdout).toBe("# {{title}}\r\n{{date}} {{time}}\r\nUTF-8: café\r\n");

    await fs.writeFile(
      path.join(vaultPath, "Templates", "Bom.md"),
      Buffer.from([
        0xef, 0xbb, 0xbf, 0x23, 0x20, 0x7b, 0x7b, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x7d, 0x7d,
      ]),
    );
    const bom = await invoke([
      "--vault",
      vaultPath,
      "template:read",
      "name=Bom",
      "folder=Templates",
    ]);
    expect(bom.stdout).toBe("\uFEFF# {{title}}");

    const resolved = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "template:read",
      "name=Daily",
      "folder=Templates",
      "title=Custom title",
      "resolve",
    ]);
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      ok: true,
      command: "template.read",
      data: {
        path: "Templates/Daily.md",
        title: "Custom title",
        resolved: true,
        content: "# Custom title\r\n2026-08-12 18:07\r\nUTF-8: café\r\n",
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "Templates", "Daily.md"))).resolves.toEqual(
      source,
    );

    await fs.writeFile(
      path.join(vaultPath, "Templates", "Large.md"),
      Buffer.alloc(1_048_577, 0x61),
    );
    const large = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "template:read",
      "path=Large.md",
      "folder=Templates",
    ]);
    expect(large.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(large.stderr)).toMatchObject({ error: { code: "VAULT" } });
    await expect(
      invoke(["--vault", vaultPath, "template:read", "name=../Daily", "folder=Templates"]),
    ).resolves.toMatchObject({ exitCode: cliExitCodes.usage });
    await expect(
      invoke(["--vault", vaultPath, "template:read", "name=Missing", "folder=Templates"]),
    ).resolves.toMatchObject({ exitCode: cliExitCodes.vault });
  });

  it("resolves template names by NFC in both composed and decomposed directions", async () => {
    const composedFolder = path.join(vaultPath, "Templates", "Composed");
    const decomposedFolder = path.join(vaultPath, "Templates", "Decomposed");
    await fs.mkdir(composedFolder, { recursive: true });
    await fs.mkdir(decomposedFolder, { recursive: true });
    const composedName = "Caf\u00e9.md";
    const decomposedName = "Cafe\u0301.md";
    await fs.writeFile(path.join(composedFolder, composedName), "composed\n", "utf8");
    await fs.writeFile(path.join(decomposedFolder, decomposedName), "decomposed\n", "utf8");

    const composedResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "template:read",
      "name=Cafe\u0301",
      "folder=Templates/Composed",
    ]);
    expect(composedResult.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(composedResult.stdout)).toMatchObject({
      ok: true,
      command: "template.read",
      data: { path: `Templates/Composed/${composedName}`, content: "composed\n" },
    });

    const decomposedResult = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "template:read",
      "name=Caf\u00e9",
      "folder=Templates/Decomposed",
    ]);
    expect(decomposedResult.exitCode).toBe(cliExitCodes.success);
    expect(JSON.parse(decomposedResult.stdout)).toMatchObject({
      ok: true,
      command: "template.read",
      data: { path: `Templates/Decomposed/${decomposedName}`, content: "decomposed\n" },
    });
  });

  it("rejects ambiguous template names and missing template folders", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Templates", "Nested", "Daily.md"),
      "nested daily",
      "utf8",
    );
    const ambiguous = await invoke([
      "--json",
      "--vault",
      vaultPath,
      "template:read",
      "name=Daily",
      "folder=Templates",
    ]);
    expect(ambiguous.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(ambiguous.stderr).error.message).toContain("Ambiguous template name");

    const missing = await invoke(["--json", "--vault", vaultPath, "templates", "folder=Missing"]);
    expect(missing.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(missing.stderr).error.message).toContain("Template folder");
  });

  it("selects a reproducible random note, includes its path, and rejects empty corpora", async () => {
    const before = await fs.readFile(path.join(vaultPath, "One.md"));
    const result = await invoke(["--json", "--vault", vaultPath, "random:read"], {
      randomSelector: (paths) => paths.at(-1) as string,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "random.read",
      data: { path: "Templates/Nested/Zed.md", content: "nested\n" },
    });
    expect(result.stderr).toBe("");
    await expect(fs.readFile(path.join(vaultPath, "One.md"))).resolves.toEqual(before);

    const folderResult = await invoke(["--vault", vaultPath, "random:read", "folder=Notes"], {
      randomSelector: () => 0,
    });
    expect(folderResult.stdout).toContain("Path: Notes/Two.md");
    expect(folderResult.stdout).toContain("two\n");

    const empty = await invoke(["--json", "--vault", vaultPath, "random:read", "folder=Empty"]);
    expect(empty.exitCode).toBe(cliExitCodes.vault);
    expect(JSON.parse(empty.stderr)).toMatchObject({ error: { code: "VAULT" } });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an interrupted daily append through the same revision-bound writer", async () => {
    await fs.writeFile(path.join(vaultPath, "Journal", "2026-08-12.md"), "before\n", "utf8");
    let interrupted = false;
    const faulting = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: (point) => {
        if (!interrupted && point === "write:after-install") {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      },
    });
    await expect(
      mutateMarkdownNoteText(faulting, "Journal/2026-08-12.md", "after", "append", false),
    ).rejects.toThrow("simulated interruption");

    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "write", outcome: "committed", path: "Journal/2026-08-12.md" },
    ]);
    await expect(
      fs.readFile(path.join(vaultPath, "Journal", "2026-08-12.md"), "utf8"),
    ).resolves.toBe("before\n\nafter");
  });
});
