import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, cliExitCodes, parseCliArguments, runCli } from "./command-line";

const fixtureDirectory = path.resolve("fixtures/extension-porting/measured");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
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

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-porting-cli-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("porting CLI commands", () => {
  it("parses inspect, ci, and scaffold commands without a vault", () => {
    expect(parseCliArguments(["port", "inspect", fixtureDirectory])).toMatchObject({
      id: "port.inspect",
      pluginDirectory: fixtureDirectory,
    });
    expect(parseCliArguments(["port", "ci", fixtureDirectory, "--json"])).toMatchObject({
      id: "port.ci",
      json: true,
    });
    expect(
      parseCliArguments([
        "port",
        "scaffold",
        "native",
        fixtureDirectory,
        "--output",
        "/tmp/porting-output",
      ]),
    ).toMatchObject({
      id: "port.scaffold",
      kind: "native",
      outputDirectory: "/tmp/porting-output",
    });
  });

  it("accepts the fused port:inspect, port:ci, and port:scaffold spellings identically", () => {
    expect(parseCliArguments(["port:inspect", fixtureDirectory])).toEqual(
      parseCliArguments(["port", "inspect", fixtureDirectory]),
    );
    expect(parseCliArguments(["port:ci", fixtureDirectory, "--json"])).toEqual(
      parseCliArguments(["port", "ci", fixtureDirectory, "--json"]),
    );
    expect(
      parseCliArguments(["port:scaffold", "native", fixtureDirectory, "--output", "/tmp/x"]),
    ).toEqual(
      parseCliArguments(["port", "scaffold", "native", fixtureDirectory, "--output", "/tmp/x"]),
    );
  });

  it("accepts path= as an alternate spelling for the plugin directory", () => {
    expect(parseCliArguments(["port", "inspect", `path=${fixtureDirectory}`])).toMatchObject({
      id: "port.inspect",
      pluginDirectory: fixtureDirectory,
    });
  });

  it("rejects a vault, an unknown subcommand, and mismatched option combinations", () => {
    expect(() => parseCliArguments(["--vault", "/v", "port", "inspect", fixtureDirectory])).toThrow(
      /vault/i,
    );
    expect(() => parseCliArguments(["port", "rename", fixtureDirectory])).toThrow(
      /inspect, ci, or scaffold/,
    );
    expect(() =>
      parseCliArguments(["port", "inspect", fixtureDirectory, "--output", "/tmp/x"]),
    ).toThrow(/exactly one/);
    expect(() => parseCliArguments(["port", "scaffold", "native", fixtureDirectory])).toThrow(
      /--output/,
    );
    expect(() => parseCliArguments(["port", "scaffold", "sideways", fixtureDirectory, "--output", "/tmp/x"])).toThrow(
      /native or compatibility/,
    );
    expect(() => parseCliArguments(["--receipt", "/tmp/r.json", "read", "Note"])).toThrow(
      /--receipt is available only/,
    );
  });

  it("emits stable JSON and text reports while keeping the input path out of output", async () => {
    const jsonCapture = capture();
    const jsonExit = await runCli(["port", "inspect", fixtureDirectory, "--json"], jsonCapture.io);
    expect(jsonExit).toBe(cliExitCodes.success);
    expect(jsonCapture.stderr()).toBe("");
    const parsed = JSON.parse(jsonCapture.stdout()) as {
      schemaVersion: number;
      command: string;
      data: { tool: { id: string }; input: { manifest: { id: string } } };
    };
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      command: "port.inspect",
      data: {
        tool: { id: "threadleaf-extension-porting" },
        input: { manifest: { id: "threadleaf-porting-fixture" } },
      },
    });
    expect(jsonCapture.stdout()).not.toContain(fixtureDirectory);

    const textCapture = capture();
    const textExit = await runCli(["port", "inspect", fixtureDirectory], textCapture.io);
    expect(textExit).toBe(cliExitCodes.success);
    expect(textCapture.stdout()).toContain("API references:");
    expect(textCapture.stdout()).toContain("CI commands:");
    expect(textCapture.stdout()).not.toContain(fixtureDirectory);
  });

  it("produces byte-identical JSON output across repeated CLI invocations", async () => {
    const first = capture();
    await runCli(["port", "inspect", fixtureDirectory, "--json"], first.io);
    const second = capture();
    await runCli(["port", "inspect", fixtureDirectory, "--json"], second.io);
    expect(first.stdout()).toBe(second.stdout());
  });

  it("scaffolds through the CLI without executing input code", async () => {
    const outputParent = await temporaryDirectory();
    const output = path.join(outputParent, "compatibility");
    const captured = capture();
    const exitCode = await runCli(
      ["port", "scaffold", "compatibility", fixtureDirectory, "--output", output, "--json"],
      captured.io,
    );
    expect(exitCode).toBe(cliExitCodes.success);
    expect(captured.stderr()).toBe("");
    expect(JSON.parse(captured.stdout())).toMatchObject({
      ok: true,
      command: "port.scaffold",
      data: { kind: "compatibility", target: { runtime: "trusted-compatibility" } },
    });
    expect(await fs.readFile(path.join(output, "main.js"), "utf8")).toContain("obsidian");
    expect(await fs.readFile(path.join(output, "main.js"), "utf8")).not.toContain("cachedReadPath");
  });

  it("makes port ci fail nonzero for package-integrity errors", async () => {
    const root = await temporaryDirectory();
    const plugin = path.join(root, "plugin");
    await fs.cp(fixtureDirectory, plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, "extra.txt"), "unexpected\n", "utf8");
    const captured = capture();
    const exitCode = await runCli(["port", "ci", plugin, "--json"], captured.io);
    expect(exitCode).toBe(cliExitCodes.vault);
    expect(captured.stdout()).toBe("");
    const error = JSON.parse(captured.stderr()) as {
      ok: boolean;
      command: string;
      error: { code: string; details: { diagnostics: Array<{ code: string }> } };
    };
    expect(error).toMatchObject({
      ok: false,
      command: "port.ci",
      error: { code: "VAULT" },
    });
    expect(error.error.details.diagnostics.map((item) => item.code)).toContain(
      "unexpected-package-entry",
    );
  });

  it("makes port ci fail nonzero for a supplied blocked authority receipt", async () => {
    const root = await temporaryDirectory();
    const receiptPath = path.join(root, "blocked-receipt.json");
    const inspectionCapture = capture();
    const inspectionExit = await runCli(
      ["port", "inspect", fixtureDirectory, "--json"],
      inspectionCapture.io,
    );
    expect(inspectionExit).toBe(cliExitCodes.success);
    const inspection = JSON.parse(inspectionCapture.stdout()) as {
      data: { authorityReceipt: Record<string, unknown> | null };
    };
    expect(inspection.data.authorityReceipt?.overall).toBe("blocked");
    await fs.writeFile(receiptPath, JSON.stringify(inspection.data.authorityReceipt), "utf8");

    const captured = capture();
    const exitCode = await runCli(
      ["port", "ci", fixtureDirectory, "--receipt", receiptPath, "--json"],
      captured.io,
    );
    expect(exitCode).toBe(cliExitCodes.vault);
    expect(captured.stdout()).toBe("");
    const error = JSON.parse(captured.stderr()) as {
      ok: boolean;
      command: string;
      error: { code: string; details: { diagnostics: Array<{ code: string }> } };
    };
    expect(error).toMatchObject({
      ok: false,
      command: "port.ci",
      error: { code: "VAULT" },
    });
    expect(error.error.details.diagnostics.map((item) => item.code)).toContain(
      "inspection-receipt-invalid",
    );
  });

  it("keeps bare 'port --help' usable instead of crashing on an unknown topic", async () => {
    // "port" alone (like "vault" or "trash") is a real first positional token in the space form
    // but is never itself schema-registered (only the fused port:inspect/port:ci/port:scaffold
    // spellings are), so it must be added to the parser's own help-topic set by hand or this
    // regresses to "Unknown help topic: port".
    const captured = capture();
    const exitCode = await runCli(["port", "--help"], captured.io);
    expect(exitCode).toBe(cliExitCodes.success);
    expect(captured.stderr()).toBe("");
    expect(captured.stdout()).toContain("port inspect");
  });
});
