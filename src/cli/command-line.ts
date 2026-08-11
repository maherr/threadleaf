import { promises as fs } from "node:fs";
import path from "node:path";
import { maxSearchResults, SearchQueryError } from "../kernel/full-text-search";
import { MetadataIndex } from "../kernel/metadata-index";
import { displayTitleFromVaultPath } from "../kernel/note-path";
import {
  isPathInside,
  normalizeVaultDirectoryPath,
  normalizeVaultPath,
} from "../kernel/path-policy";
import { FixedStateRoot, type StateRootPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";

export const cliSchemaVersion = 1;

export const cliExitCodes = {
  success: 0,
  internal: 1,
  usage: 2,
  vault: 3,
  query: 4,
} as const;

type CliCommandId = "help" | "vault.info" | "files" | "read" | "search";

interface CliBaseCommand {
  id: CliCommandId;
  json: boolean;
}

interface CliHelpCommand extends CliBaseCommand {
  id: "help";
}

interface CliVaultCommand extends CliBaseCommand {
  vaultPath: string;
}

interface CliVaultInfoCommand extends CliVaultCommand {
  id: "vault.info";
}

interface CliFilesCommand extends CliVaultCommand {
  id: "files";
  directory: string;
}

interface CliReadCommand extends CliVaultCommand {
  id: "read";
  filePath: string;
}

interface CliSearchCommand extends CliVaultCommand {
  id: "search";
  query: string;
  limit: number;
}

export type ParsedCliCommand =
  | CliHelpCommand
  | CliVaultInfoCommand
  | CliFilesCommand
  | CliReadCommand
  | CliSearchCommand;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliRunOptions {
  stateRoot?: StateRootPort;
}

class CliFailure extends Error {
  readonly code: "USAGE" | "VAULT" | "QUERY" | "INTERNAL";
  readonly exitCode: number;

  constructor(code: CliFailure["code"], exitCode: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliFailure";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usageFailure(message: string): never {
  throw new CliFailure("USAGE", cliExitCodes.usage, message);
}

function takeOptionValue(args: readonly string[], index: number, name: string): string {
  const token = args[index] ?? "";
  const equalsPrefix = `${name}=`;
  if (token.startsWith(equalsPrefix)) {
    const value = token.slice(equalsPrefix.length);
    if (!value) {
      usageFailure(`${name} requires a value.`);
    }
    return value;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usageFailure(`${name} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    usageFailure(`${option} requires a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    usageFailure(`${option} is too large.`);
  }
  return parsed;
}

export function parseCliArguments(args: readonly string[]): ParsedCliCommand {
  let json = false;
  let vaultPath: string | null = null;
  let directory: string | null = null;
  let limit: number | null = null;
  let help = false;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--vault" || token.startsWith("--vault=")) {
      if (vaultPath !== null) {
        usageFailure("--vault may be supplied only once.");
      }
      vaultPath = takeOptionValue(args, index, "--vault");
      if (token === "--vault") {
        index += 1;
      }
      continue;
    }
    if (token === "--directory" || token.startsWith("--directory=")) {
      if (directory !== null) {
        usageFailure("--directory may be supplied only once.");
      }
      directory = takeOptionValue(args, index, "--directory");
      if (token === "--directory") {
        index += 1;
      }
      continue;
    }
    if (token === "--limit" || token.startsWith("--limit=")) {
      if (limit !== null) {
        usageFailure("--limit may be supplied only once.");
      }
      limit = parsePositiveInteger(takeOptionValue(args, index, "--limit"), "--limit");
      if (token === "--limit") {
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--")) {
      usageFailure(`Unknown option: ${token}`);
    }
    positional.push(token);
  }

  if (help || positional.length === 0) {
    return { id: "help", json };
  }
  if (!vaultPath) {
    usageFailure("Every vault command requires --vault <path>.");
  }

  const [name, ...values] = positional;
  if (
    (name === "vault" && values[0] === "info" && values.length === 1) ||
    (name === "vault:info" && values.length === 0)
  ) {
    if (directory !== null || limit !== null) {
      usageFailure("vault info does not accept --directory or --limit.");
    }
    return { id: "vault.info", json, vaultPath };
  }
  if (name === "files") {
    if (values.length > 0 || limit !== null) {
      usageFailure("files accepts only the optional --directory value.");
    }
    return { id: "files", json, vaultPath, directory: directory ?? "" };
  }
  if (name === "read") {
    if (values.length !== 1 || directory !== null || limit !== null) {
      usageFailure("read requires exactly one vault-relative Markdown path.");
    }
    const filePath = values[0]?.startsWith("file=") ? values[0].slice(5) : values[0];
    if (!filePath) {
      usageFailure("read requires a non-empty Markdown path.");
    }
    return { id: "read", json, vaultPath, filePath };
  }
  if (name === "search") {
    if (values.length === 0 || directory !== null) {
      usageFailure("search requires a query and does not accept --directory.");
    }
    const first = values[0] ?? "";
    const query = [first.startsWith("query=") ? first.slice(6) : first, ...values.slice(1)]
      .join(" ")
      .trim();
    if (!query) {
      usageFailure("search requires a non-empty query.");
    }
    if (limit !== null && limit > maxSearchResults) {
      usageFailure(`--limit may not exceed ${maxSearchResults}.`);
    }
    return { id: "search", json, vaultPath, query, limit: limit ?? 50 };
  }

  usageFailure(`Unknown command: ${positional.join(" ")}`);
}

export const cliHelp = `Threadleaf command line

Usage:
  threadleaf --vault <path> [--json] vault info
  threadleaf --vault <path> [--json] files [--directory <path>]
  threadleaf --vault <path> [--json] read <note.md>
  threadleaf --vault <path> [--json] search <query> [--limit <count>]

Compatibility spellings:
  threadleaf --vault <path> read file=<note.md>
  threadleaf --vault <path> search query=<text>

Read commands are headless and never require a running Electron process.
`;

async function defaultStateRoot(vaultPath: string): Promise<StateRootPort> {
  const canonicalVault = await fs.realpath(path.resolve(vaultPath));
  const parent = path.dirname(canonicalVault);
  if (parent === canonicalVault) {
    throw new Error("The filesystem root cannot be used as a Threadleaf vault.");
  }
  const candidate = path.join(parent, ".threadleaf-cli-read-only-state");
  if (isPathInside(canonicalVault, candidate)) {
    throw new Error("Could not place the read-only CLI state boundary outside the vault.");
  }
  return new FixedStateRoot(candidate);
}

async function openReadOnlyKernel(
  command: CliVaultCommand,
  options: CliRunOptions,
): Promise<VaultKernel> {
  try {
    return await VaultKernel.open({
      vaultRoot: command.vaultPath,
      stateRoot: options.stateRoot ?? (await defaultStateRoot(command.vaultPath)),
      readOnly: true,
    });
  } catch (error) {
    throw new CliFailure(
      "VAULT",
      cliExitCodes.vault,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

async function executeCommand(
  command: Exclude<ParsedCliCommand, CliHelpCommand>,
  options: CliRunOptions,
): Promise<unknown> {
  const kernel = await openReadOnlyKernel(command, options);
  try {
    if (command.id === "files") {
      const directory = normalizeVaultDirectoryPath(command.directory);
      const prefix = directory ? `${directory}/` : "";
      const files = (await kernel.listMarkdownPaths()).filter(
        (filePath) => !prefix || filePath.startsWith(prefix),
      );
      return { directory, total: files.length, files };
    }
    if (command.id === "read") {
      const filePath = normalizeVaultPath(command.filePath);
      if (!filePath.toLocaleLowerCase("en-US").endsWith(".md")) {
        throw new Error("read accepts only Markdown note paths.");
      }
      const indexedPaths = await kernel.listMarkdownPaths();
      if (!indexedPaths.includes(filePath)) {
        throw new Error(`Markdown note is not indexed in this vault: ${filePath}`);
      }
      const note = await kernel.readText(filePath);
      return note;
    }

    const index = await MetadataIndex.build(kernel);
    if (command.id === "search") {
      const page = index.search(command.query, command.limit);
      return {
        ...page,
        results: page.results.map((result) => ({
          ...result,
          title: displayTitleFromVaultPath(result.path),
        })),
      };
    }

    const snapshot = index.snapshot();
    const tags = new Set(snapshot.documents.flatMap((document) => document.tags));
    const headingCount = snapshot.documents.reduce(
      (count, document) => count + document.headings.length,
      0,
    );
    const linkCount = snapshot.documents.reduce(
      (count, document) => count + document.links.length,
      0,
    );
    const unresolvedLinkCount = snapshot.documents.reduce(
      (count, document) =>
        count + document.links.filter((link) => link.resolution.status !== "resolved").length,
      0,
    );
    return {
      name: kernel.getName(),
      path: kernel.paths.rootPath,
      vaultId: kernel.vaultId,
      markdownFiles: snapshot.documents.length,
      headings: headingCount,
      tags: tags.size,
      links: linkCount,
      unresolvedLinks: unresolvedLinkCount,
      duplicateNames: snapshot.duplicateNames.length,
    };
  } catch (error) {
    if (error instanceof SearchQueryError) {
      throw new CliFailure("QUERY", cliExitCodes.query, error.message, { cause: error });
    }
    throw new CliFailure(
      "VAULT",
      cliExitCodes.vault,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function humanOutput(command: ParsedCliCommand, data: unknown): string {
  if (command.id === "help") {
    return cliHelp;
  }
  if (command.id === "read") {
    return (data as { content: string }).content;
  }
  if (command.id === "files") {
    const files = (data as { files: string[] }).files;
    return files.length > 0 ? `${files.join("\n")}\n` : "No Markdown files.\n";
  }
  if (command.id === "search") {
    const results = (
      data as {
        results: Array<{
          path: string;
          contexts: Array<{ kind: string; text: string; line?: number }>;
        }>;
      }
    ).results;
    if (results.length === 0) {
      return "No matches.\n";
    }
    return `${results
      .map((result) => {
        const context = result.contexts[0];
        const location = context?.line ? `${result.path}:${context.line}` : result.path;
        return context ? `${location} [${context.kind}] ${context.text}` : location;
      })
      .join("\n")}\n`;
  }
  const info = data as {
    name: string;
    path: string;
    markdownFiles: number;
    headings: number;
    tags: number;
    links: number;
    unresolvedLinks: number;
    duplicateNames: number;
  };
  return [
    `Threadleaf vault: ${info.name}`,
    `Path: ${info.path}`,
    `Markdown files: ${info.markdownFiles}`,
    `Headings: ${info.headings}`,
    `Tags: ${info.tags}`,
    `Links: ${info.links}`,
    `Unresolved links: ${info.unresolvedLinks}`,
    `Duplicate note names: ${info.duplicateNames}`,
    "",
  ].join("\n");
}

function jsonOutput(command: CliCommandId, data: unknown): string {
  return `${JSON.stringify(
    {
      schemaVersion: cliSchemaVersion,
      ok: true,
      command,
      data,
    },
    null,
    2,
  )}\n`;
}

function errorOutput(command: CliCommandId | null, error: CliFailure, json: boolean): string {
  if (json) {
    return `${JSON.stringify(
      {
        schemaVersion: cliSchemaVersion,
        ok: false,
        command,
        error: { code: error.code, message: error.message },
      },
      null,
      2,
    )}\n`;
  }
  return `threadleaf: ${error.message}${error.code === "USAGE" ? "\nRun 'threadleaf --help' for usage." : ""}\n`;
}

function asCliFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) {
    return error;
  }
  return new CliFailure(
    "INTERNAL",
    cliExitCodes.internal,
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

export async function runCli(
  args: readonly string[],
  io: CliIo,
  options: CliRunOptions = {},
): Promise<number> {
  const optionBoundary = args.indexOf("--");
  const optionArguments = optionBoundary === -1 ? args : args.slice(0, optionBoundary);
  const jsonRequested = optionArguments.includes("--json");
  let command: ParsedCliCommand | null = null;
  try {
    command = parseCliArguments(args);
    const data =
      command.id === "help" ? { usage: cliHelp } : await executeCommand(command, options);
    io.stdout(command.json ? jsonOutput(command.id, data) : humanOutput(command, data));
    return cliExitCodes.success;
  } catch (error) {
    const failure = asCliFailure(error);
    io.stderr(errorOutput(command?.id ?? null, failure, command?.json ?? jsonRequested));
    return failure.exitCode;
  }
}
