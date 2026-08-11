import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdownNote } from "../application/note-creation";
import { movedMarkdownPath, moveMarkdownNote, renamedMarkdownPath } from "../application/note-move";
import { mutateMarkdownNoteText } from "../application/note-text-mutation";
import {
  listTrashedMarkdownNotes,
  restoreTrashedMarkdownNote,
  trashMarkdownNote,
} from "../application/note-trash";
import { maxSearchResults, SearchQueryError } from "../kernel/full-text-search";
import {
  type DocumentMetadataSnapshot,
  type LinkMetadata,
  MetadataIndex,
  type MetadataIndexSnapshot,
} from "../kernel/metadata-index";
import { displayTitleFromVaultPath } from "../kernel/note-path";
import {
  canonicalizePotentialPath,
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
  conflict: 5,
} as const;

type CliCommandId =
  | "help"
  | "vault.info"
  | "files"
  | "read"
  | "search"
  | "links"
  | "backlinks"
  | "unresolved"
  | "orphans"
  | "deadends"
  | "outline"
  | "create"
  | "append"
  | "prepend"
  | "move"
  | "rename"
  | "delete"
  | "trash.list"
  | "restore";

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

interface CliTargetMetadataCommand extends CliVaultCommand {
  id: "links" | "backlinks" | "outline";
  filePath: string;
}

interface CliVaultMetadataCommand extends CliVaultCommand {
  id: "unresolved" | "orphans" | "deadends";
}

interface CliCreateCommand extends CliVaultCommand {
  id: "create";
  filePath: string;
  content: string;
}

interface CliTextMutationCommand extends CliVaultCommand {
  id: "append" | "prepend";
  filePath: string;
  content: string;
  inline: boolean;
}

interface CliMoveCommand extends CliVaultCommand {
  id: "move" | "rename";
  sourcePath: string;
  targetPath: string;
}

interface CliTrashMutationCommand extends CliVaultCommand {
  id: "delete" | "restore";
  filePath: string;
}

interface CliTrashListCommand extends CliVaultCommand {
  id: "trash.list";
}

export type ParsedCliCommand =
  | CliHelpCommand
  | CliVaultInfoCommand
  | CliFilesCommand
  | CliReadCommand
  | CliSearchCommand
  | CliTargetMetadataCommand
  | CliVaultMetadataCommand
  | CliCreateCommand
  | CliTextMutationCommand
  | CliMoveCommand
  | CliTrashMutationCommand
  | CliTrashListCommand;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliRunOptions {
  stateRoot?: StateRootPort;
}

class CliFailure extends Error {
  readonly code: "USAGE" | "VAULT" | "QUERY" | "CONFLICT" | "INTERNAL";
  readonly exitCode: number;
  readonly details: unknown;

  constructor(
    code: CliFailure["code"],
    exitCode: number,
    message: string,
    options?: ErrorOptions & { details?: unknown },
  ) {
    super(message, options);
    this.name = "CliFailure";
    this.code = code;
    this.exitCode = exitCode;
    this.details = options?.details;
  }
}

function usageFailure(message: string): never {
  throw new CliFailure("USAGE", cliExitCodes.usage, message);
}

function pathArgument(operation: () => string): string {
  try {
    return operation();
  } catch (error) {
    usageFailure(error instanceof Error ? error.message : String(error));
  }
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

function exactTargetPath(value: string): string {
  if (value.startsWith("file=") || value.startsWith("path=")) {
    return value.slice(value.indexOf("=") + 1);
  }
  return value;
}

export function parseCliArguments(args: readonly string[]): ParsedCliCommand {
  let json = false;
  let vaultPath: string | null = null;
  let directory: string | null = null;
  let limit: number | null = null;
  let content: string | null = null;
  let inline = false;
  let destination: string | null = null;
  let renamedName: string | null = null;
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
    if (token === "--content" || token.startsWith("--content=")) {
      if (content !== null) {
        usageFailure("--content may be supplied only once.");
      }
      if (token.startsWith("--content=")) {
        content = token.slice("--content=".length);
      } else {
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
          usageFailure("--content requires a value.");
        }
        content = value;
        index += 1;
      }
      continue;
    }
    if (token === "--inline") {
      if (inline) {
        usageFailure("--inline may be supplied only once.");
      }
      inline = true;
      continue;
    }
    if (token === "--permanent") {
      usageFailure(
        "Threadleaf does not expose permanent deletion; recoverable trash is mandatory.",
      );
    }
    if (token === "--to" || token.startsWith("--to=")) {
      if (destination !== null) {
        usageFailure("--to may be supplied only once.");
      }
      destination = takeOptionValue(args, index, "--to");
      if (token === "--to") {
        index += 1;
      }
      continue;
    }
    if (token === "--name" || token.startsWith("--name=")) {
      if (renamedName !== null) {
        usageFailure("--name may be supplied only once.");
      }
      renamedName = takeOptionValue(args, index, "--name");
      if (token === "--name") {
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
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure("vault info received an option that it does not accept.");
    }
    return { id: "vault.info", json, vaultPath };
  }
  if (name === "files") {
    if (
      values.length > 0 ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure("files accepts only the optional --directory value.");
    }
    return { id: "files", json, vaultPath, directory: directory ?? "" };
  }
  if (name === "read") {
    if (
      values.length !== 1 ||
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure("read requires exactly one vault-relative Markdown path.");
    }
    const filePath = exactTargetPath(values[0] ?? "");
    if (!filePath) {
      usageFailure("read requires a non-empty Markdown path.");
    }
    return { id: "read", json, vaultPath, filePath };
  }
  if (
    (name === "trash" && values[0] === "list" && values.length === 1) ||
    (name === "trash:list" && values.length === 0)
  ) {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure("trash list does not accept options.");
    }
    return { id: "trash.list", json, vaultPath };
  }
  if (name === "delete" || name === "restore") {
    if (values.includes("permanent")) {
      usageFailure(
        "Threadleaf does not expose permanent deletion; recoverable trash is mandatory.",
      );
    }
    if (
      values.length !== 1 ||
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure(`${name} requires exactly one vault-relative Markdown path.`);
    }
    const filePath = exactTargetPath(values[0] ?? "");
    if (!filePath) {
      usageFailure(`${name} requires a non-empty Markdown path.`);
    }
    return { id: name, json, vaultPath, filePath };
  }
  if (name === "links" || name === "backlinks" || name === "outline") {
    if (
      values.length !== 1 ||
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure(`${name} requires exactly one vault-relative Markdown path.`);
    }
    const filePath = exactTargetPath(values[0] ?? "");
    if (!filePath) {
      usageFailure(`${name} requires a non-empty Markdown path.`);
    }
    return { id: name, json, vaultPath, filePath };
  }
  if (name === "unresolved" || name === "orphans" || name === "deadends") {
    if (
      values.length > 0 ||
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure(`${name} does not accept arguments yet.`);
    }
    return { id: name, json, vaultPath };
  }
  if (name === "search") {
    if (
      values.length === 0 ||
      directory !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
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
  if (name === "create") {
    if (
      directory !== null ||
      limit !== null ||
      inline ||
      destination !== null ||
      renamedName !== null
    ) {
      usageFailure("create received an option that it does not accept.");
    }
    let filePath: string | null = null;
    let parameterContent: string | null = null;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("name=")) {
        if (filePath !== null) {
          usageFailure("create accepts only one note path.");
        }
        filePath = value.slice(value.indexOf("=") + 1);
      } else if (value.startsWith("content=")) {
        if (parameterContent !== null) {
          usageFailure("content may be supplied only once.");
        }
        parameterContent = value.slice("content=".length);
      } else if (filePath === null && !value.includes("=")) {
        filePath = value;
      } else {
        usageFailure(`Unsupported create argument: ${value}`);
      }
    }
    if (!filePath) {
      usageFailure("create requires one note path or name.");
    }
    if (content !== null && parameterContent !== null) {
      usageFailure("create content may be supplied as an option or parameter, not both.");
    }
    return {
      id: "create",
      json,
      vaultPath,
      filePath,
      content: decodeContentEscapes(content ?? parameterContent ?? ""),
    };
  }
  if (name === "append" || name === "prepend") {
    if (directory !== null || limit !== null || destination !== null || renamedName !== null) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    let filePath: string | null = null;
    let parameterContent: string | null = null;
    let inlineFlag = inline;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure(`${name} accepts only one note path.`);
        }
        filePath = value.slice(value.indexOf("=") + 1);
      } else if (value.startsWith("content=")) {
        if (parameterContent !== null) {
          usageFailure("content may be supplied only once.");
        }
        parameterContent = value.slice("content=".length);
      } else if (value === "inline") {
        if (inlineFlag) {
          usageFailure("inline may be supplied only once.");
        }
        inlineFlag = true;
      } else if (filePath === null && !value.includes("=")) {
        filePath = value;
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (!filePath) {
      usageFailure(`${name} requires one note path.`);
    }
    if (content !== null && parameterContent !== null) {
      usageFailure(`${name} content may be supplied as an option or parameter, not both.`);
    }
    const decodedContent = decodeContentEscapes(content ?? parameterContent ?? "");
    if (!decodedContent) {
      usageFailure(`${name} requires non-empty content.`);
    }
    return {
      id: name,
      json,
      vaultPath,
      filePath,
      content: decodedContent,
      inline: inlineFlag,
    };
  }
  if (name === "move" || name === "rename") {
    if (directory !== null || limit !== null || content !== null || inline) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    let sourcePath: string | null = null;
    let parameterDestination: string | null = null;
    let parameterName: string | null = null;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (sourcePath !== null) {
          usageFailure(`${name} accepts only one source path.`);
        }
        sourcePath = value.slice(value.indexOf("=") + 1);
      } else if (value.startsWith("to=")) {
        if (parameterDestination !== null) {
          usageFailure("to may be supplied only once.");
        }
        parameterDestination = value.slice("to=".length);
      } else if (value.startsWith("name=")) {
        if (parameterName !== null) {
          usageFailure("name may be supplied only once.");
        }
        parameterName = value.slice("name=".length);
      } else if (sourcePath === null && !value.includes("=")) {
        sourcePath = value;
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (!sourcePath) {
      usageFailure(`${name} requires one source note path.`);
    }
    if (destination !== null && parameterDestination !== null) {
      usageFailure("move destination may be supplied as an option or parameter, not both.");
    }
    if (renamedName !== null && parameterName !== null) {
      usageFailure("rename name may be supplied as an option or parameter, not both.");
    }
    const targetDestination = destination ?? parameterDestination;
    const targetName = renamedName ?? parameterName;
    if (name === "move") {
      if (!targetDestination || targetName !== null) {
        usageFailure("move requires exactly one --to or to= destination.");
      }
      return {
        id: "move",
        json,
        vaultPath,
        sourcePath,
        targetPath: pathArgument(() => movedMarkdownPath(sourcePath, targetDestination)),
      };
    }
    if (!targetName || targetDestination !== null) {
      usageFailure("rename requires exactly one --name or name= filename.");
    }
    return {
      id: "rename",
      json,
      vaultPath,
      sourcePath,
      targetPath: pathArgument(() => renamedMarkdownPath(sourcePath, targetName)),
    };
  }

  usageFailure(`Unknown command: ${positional.join(" ")}`);
}

export const cliHelp = `Threadleaf command line

Usage:
  threadleaf --vault <path> [--json] vault info
  threadleaf --vault <path> [--json] files [--directory <path>]
  threadleaf --vault <path> [--json] read <note.md>
  threadleaf --vault <path> [--json] search <query> [--limit <count>]
  threadleaf --vault <path> [--json] links <note.md>
  threadleaf --vault <path> [--json] backlinks <note.md>
  threadleaf --vault <path> [--json] unresolved
  threadleaf --vault <path> [--json] orphans
  threadleaf --vault <path> [--json] deadends
  threadleaf --vault <path> [--json] outline <note.md>
  threadleaf --vault <path> [--json] create <note> [--content <text>]
  threadleaf --vault <path> [--json] append <note> --content <text> [--inline]
  threadleaf --vault <path> [--json] prepend <note> --content <text> [--inline]
  threadleaf --vault <path> [--json] move <note> --to <path>
  threadleaf --vault <path> [--json] rename <note> --name <filename>
  threadleaf --vault <path> [--json] delete <note>
  threadleaf --vault <path> [--json] trash list
  threadleaf --vault <path> [--json] restore <note>

Compatibility spellings:
  threadleaf --vault <path> read file=<note.md>
  threadleaf --vault <path> search query=<text>
  threadleaf --vault <path> links path=<note.md>
  threadleaf --vault <path> backlinks file=<note.md>
  threadleaf --vault <path> outline path=<note.md>
  threadleaf --vault <path> create path=<note> content=<text>
  threadleaf --vault <path> append path=<note> content=<text> [inline]
  threadleaf --vault <path> prepend path=<note> content=<text> [inline]
  threadleaf --vault <path> move path=<note> to=<path>
  threadleaf --vault <path> rename path=<note> name=<filename>
  threadleaf --vault <path> delete path=<note>
  threadleaf --vault <path> restore path=<note>

Commands are headless and never require a running Electron process.
`;

function decodeContentEscapes(value: string): string {
  return value.replaceAll(/\\([\\nt])/g, (_match, escaped: string) => {
    if (escaped === "n") {
      return "\n";
    }
    if (escaped === "t") {
      return "\t";
    }
    return "\\";
  });
}

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

function defaultWritableStateRoot(): StateRootPort {
  const homeDirectory = os.homedir();
  const baseDirectory =
    process.platform === "win32"
      ? (process.env.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local"))
      : process.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
          ? process.env.XDG_STATE_HOME
          : path.join(homeDirectory, ".local", "state");
  return new FixedStateRoot(path.join(baseDirectory, "threadleaf-cli"));
}

interface CliMutationLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

function isFileSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemCode(error, "ESRCH");
  }
}

async function readCliMutationLockOwner(ownerPath: string): Promise<CliMutationLockOwner | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(ownerPath, "utf8"),
    ) as Partial<CliMutationLockOwner>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.token !== "string" ||
      !parsed.token ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as CliMutationLockOwner;
  } catch (error) {
    if (isFileSystemCode(error, "ENOENT") || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

async function acquireCliMutationLock(
  vaultPath: string,
  stateRoot: StateRootPort,
): Promise<() => Promise<void>> {
  const canonicalVault = await fs.realpath(path.resolve(vaultPath));
  const configuredStateRoot = path.resolve(await stateRoot.getPath());
  const canonicalStateRoot = await canonicalizePotentialPath(configuredStateRoot);
  if (
    isPathInside(canonicalVault, configuredStateRoot) ||
    isPathInside(canonicalVault, canonicalStateRoot)
  ) {
    throw new CliFailure(
      "VAULT",
      cliExitCodes.vault,
      "Threadleaf CLI state must be stored outside the vault.",
    );
  }

  await fs.mkdir(canonicalStateRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(canonicalStateRoot, ".cli-mutation-lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      const owner: CliMutationLockOwner = {
        version: 1,
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return async () => {
        const currentOwner = await readCliMutationLockOwner(ownerPath);
        if (currentOwner?.token !== token) {
          throw new Error("Threadleaf CLI mutation lock ownership changed unexpectedly.");
        }
        await fs.rm(lockPath, { recursive: true });
      };
    } catch (error) {
      if (!isFileSystemCode(error, "EEXIST")) {
        throw error;
      }
      const owner = await readCliMutationLockOwner(ownerPath);
      const lockStat = await fs.stat(lockPath);
      const freshIncompleteLock = !owner && Date.now() - lockStat.mtimeMs < 30_000;
      if ((owner && processIsAlive(owner.pid)) || freshIncompleteLock) {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          "Another Threadleaf CLI mutation is already running.",
          { details: { status: "busy" } },
        );
      }
      await fs.rm(lockPath, { recursive: true });
    }
  }
  throw new CliFailure(
    "CONFLICT",
    cliExitCodes.conflict,
    "Could not acquire the Threadleaf CLI mutation lock.",
    { details: { status: "busy" } },
  );
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

async function openWritableKernel(
  command: CliVaultCommand,
  options: CliRunOptions,
): Promise<VaultKernel> {
  try {
    return await VaultKernel.open({
      vaultRoot: command.vaultPath,
      stateRoot: options.stateRoot ?? defaultWritableStateRoot(),
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

function indexedMarkdownDocument(
  snapshot: MetadataIndexSnapshot,
  rawPath: string,
  commandName: string,
): DocumentMetadataSnapshot {
  const filePath = normalizeVaultPath(rawPath);
  if (!filePath.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error(`${commandName} accepts only Markdown note paths.`);
  }
  const document = snapshot.documents.find((candidate) => candidate.path === filePath);
  if (!document) {
    throw new Error(`Markdown note is not indexed in this vault: ${filePath}`);
  }
  return document;
}

function describeLink(link: LinkMetadata): string {
  const target = `${link.target}${link.subpath ?? ""}`;
  const kind = `${link.syntax}${link.embed ? " embed" : ""}`;
  const alias = link.alias ? ` as ${link.alias}` : "";
  if (link.resolution.status === "resolved") {
    return `${target} [${kind}]${alias} -> ${link.resolution.path}`;
  }
  if (link.resolution.status === "ambiguous") {
    return `${target} [${kind}]${alias} -> ambiguous: ${(link.resolution.candidates ?? []).join(", ")}`;
  }
  return `${target} [${kind}]${alias} -> unresolved`;
}

function backlinksForPath(snapshot: MetadataIndexSnapshot, targetPath: string) {
  const backlinks = snapshot.documents.flatMap((document) => {
    const count = document.links.filter(
      (link) => link.resolution.status === "resolved" && link.resolution.path === targetPath,
    ).length;
    return count > 0 ? [{ path: document.path, count }] : [];
  });
  return {
    path: targetPath,
    total: backlinks.length,
    occurrences: backlinks.reduce((total, backlink) => total + backlink.count, 0),
    backlinks,
  };
}

function nonResolvedLinks(snapshot: MetadataIndexSnapshot) {
  const links = snapshot.documents.flatMap((document) =>
    document.links
      .filter((link) => link.resolution.status !== "resolved")
      .map((link) => ({ sourcePath: document.path, ...link })),
  );
  return { total: links.length, links };
}

function orphanNotes(snapshot: MetadataIndexSnapshot) {
  const files = snapshot.backlinks
    .filter((backlink) => backlink.sources.length === 0)
    .map((backlink) => backlink.path);
  return { total: files.length, files };
}

function deadEndNotes(snapshot: MetadataIndexSnapshot) {
  const files = snapshot.documents
    .filter((document) => document.links.length === 0)
    .map((document) => document.path);
  return { total: files.length, files };
}

async function executeCommand(
  command: Exclude<ParsedCliCommand, CliHelpCommand>,
  options: CliRunOptions,
): Promise<unknown> {
  const kernel =
    command.id === "create" ||
    command.id === "append" ||
    command.id === "prepend" ||
    command.id === "move" ||
    command.id === "rename" ||
    command.id === "delete" ||
    command.id === "restore"
      ? await openWritableKernel(command, options)
      : await openReadOnlyKernel(command, options);
  try {
    if (command.id === "create") {
      const outcome = await createMarkdownNote(kernel, command.filePath, command.content);
      if (outcome.status === "exists") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `Markdown note already exists: ${outcome.path}`,
          { details: outcome },
        );
      }
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The requested path appeared during creation. The proposed note was preserved as ${outcome.conflictPath}.`,
          { details: outcome },
        );
      }
      return outcome;
    }
    if (command.id === "move" || command.id === "rename") {
      const outcome = await moveMarkdownNote(kernel, command.sourcePath, command.targetPath);
      if (outcome.status === "blocked") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The ${command.id} would change ${outcome.blockers.length} internal link resolution${outcome.blockers.length === 1 ? "" : "s"}. No files were changed.`,
          { details: outcome },
        );
      }
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `Could not ${command.id} ${outcome.from} to ${outcome.to}: ${outcome.reason}.`,
          { details: outcome },
        );
      }
      return outcome;
    }
    if (command.id === "delete" || command.id === "restore") {
      const outcome =
        command.id === "delete"
          ? await trashMarkdownNote(kernel, command.filePath)
          : await restoreTrashedMarkdownNote(kernel, command.filePath);
      if (outcome.status === "conflict") {
        const operation = command.id === "delete" ? "move to recoverable trash" : "restore";
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `Could not ${operation} ${outcome.from} to ${outcome.to}: ${outcome.reason}. No files were changed.`,
          { details: outcome },
        );
      }
      return outcome;
    }
    if (command.id === "append" || command.id === "prepend") {
      const outcome = await mutateMarkdownNoteText(
        kernel,
        command.filePath,
        command.content,
        command.id,
        command.inline,
      );
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The note changed during ${command.id}. The proposed version was preserved as ${outcome.conflictPath}.`,
          { details: outcome },
        );
      }
      return outcome;
    }
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
    if (command.id === "trash.list") {
      return listTrashedMarkdownNotes(kernel);
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
    if (command.id === "links") {
      const document = indexedMarkdownDocument(snapshot, command.filePath, command.id);
      return { path: document.path, total: document.links.length, links: document.links };
    }
    if (command.id === "backlinks") {
      const document = indexedMarkdownDocument(snapshot, command.filePath, command.id);
      return backlinksForPath(snapshot, document.path);
    }
    if (command.id === "unresolved") {
      return nonResolvedLinks(snapshot);
    }
    if (command.id === "orphans") {
      return orphanNotes(snapshot);
    }
    if (command.id === "deadends") {
      return deadEndNotes(snapshot);
    }
    if (command.id === "outline") {
      const document = indexedMarkdownDocument(snapshot, command.filePath, command.id);
      return { path: document.path, total: document.headings.length, headings: document.headings };
    }
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
    if (error instanceof CliFailure) {
      throw error;
    }
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

async function executeWithCommandState(
  command: Exclude<ParsedCliCommand, CliHelpCommand>,
  options: CliRunOptions,
): Promise<unknown> {
  if (
    command.id !== "create" &&
    command.id !== "append" &&
    command.id !== "prepend" &&
    command.id !== "move" &&
    command.id !== "rename" &&
    command.id !== "delete" &&
    command.id !== "restore"
  ) {
    return executeCommand(command, options);
  }
  const stateRoot = options.stateRoot ?? defaultWritableStateRoot();
  let release: () => Promise<void>;
  try {
    release = await acquireCliMutationLock(command.vaultPath, stateRoot);
  } catch (error) {
    if (error instanceof CliFailure) {
      throw error;
    }
    throw new CliFailure(
      "VAULT",
      cliExitCodes.vault,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  try {
    return await executeCommand(command, { ...options, stateRoot });
  } finally {
    await release();
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
  if (command.id === "links") {
    const result = data as { path: string; links: LinkMetadata[] };
    return result.links.length > 0
      ? `Outgoing links from ${result.path}:\n${result.links.map(describeLink).join("\n")}\n`
      : `No outgoing links from ${result.path}.\n`;
  }
  if (command.id === "backlinks") {
    const result = data as {
      path: string;
      backlinks: Array<{ path: string; count: number }>;
    };
    return result.backlinks.length > 0
      ? `Backlinks to ${result.path}:\n${result.backlinks
          .map((backlink) => `${backlink.path} (${backlink.count})`)
          .join("\n")}\n`
      : `No backlinks to ${result.path}.\n`;
  }
  if (command.id === "unresolved") {
    const result = data as { links: Array<LinkMetadata & { sourcePath: string }> };
    return result.links.length > 0
      ? `Non-resolved links:\n${result.links
          .map((link) => `${link.sourcePath}: ${describeLink(link)}`)
          .join("\n")}\n`
      : "No non-resolved links.\n";
  }
  if (command.id === "orphans" || command.id === "deadends") {
    const files = (data as { files: string[] }).files;
    const label = command.id === "orphans" ? "Orphan notes" : "Dead-end notes";
    return files.length > 0 ? `${label}:\n${files.join("\n")}\n` : `No ${label.toLowerCase()}.\n`;
  }
  if (command.id === "outline") {
    const result = data as {
      path: string;
      headings: Array<{ level: number; text: string; line: number }>;
    };
    return result.headings.length > 0
      ? `Outline for ${result.path}:\n${result.headings
          .map(
            (heading) =>
              `${"  ".repeat(Math.max(0, heading.level - 1))}${heading.text} (line ${heading.line})`,
          )
          .join("\n")}\n`
      : `No headings in ${result.path}.\n`;
  }
  if (command.id === "create") {
    return `Created ${(data as { path: string }).path}\n`;
  }
  if (command.id === "append") {
    return `Appended ${(data as { path: string }).path}\n`;
  }
  if (command.id === "prepend") {
    return `Prepended ${(data as { path: string }).path}\n`;
  }
  if (command.id === "move") {
    const result = data as { from: string; to: string };
    return `Moved ${result.from} to ${result.to}\n`;
  }
  if (command.id === "rename") {
    const result = data as { from: string; to: string };
    return `Renamed ${result.from} to ${result.to}\n`;
  }
  if (command.id === "delete") {
    const result = data as { from: string; to: string };
    return `Deleted ${result.from} to ${result.to}\n`;
  }
  if (command.id === "restore") {
    const result = data as { from: string; to: string };
    return `Restored ${result.from} to ${result.to}\n`;
  }
  if (command.id === "trash.list") {
    const entries = (data as { entries: Array<{ path: string; trashPath: string }> }).entries;
    return entries.length > 0
      ? `Recoverable trash:\n${entries.map((entry) => `${entry.path} <- ${entry.trashPath}`).join("\n")}\n`
      : "Recoverable trash is empty.\n";
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
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
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
      command.id === "help" ? { usage: cliHelp } : await executeWithCommandState(command, options);
    io.stdout(command.json ? jsonOutput(command.id, data) : humanOutput(command, data));
    return cliExitCodes.success;
  } catch (error) {
    const failure = asCliFailure(error);
    io.stderr(errorOutput(command?.id ?? null, failure, command?.json ?? jsonRequested));
    return failure.exitCode;
  }
}
