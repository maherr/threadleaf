import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarkdownNote } from "../application/note-creation";
import { movedMarkdownPath, moveMarkdownNote, renamedMarkdownPath } from "../application/note-move";
import {
  type NotePropertyType,
  notePropertyTypes,
  removeMarkdownNoteProperty,
  setMarkdownNoteProperty,
} from "../application/note-properties";
import {
  listMarkdownTasks,
  type MarkdownTaskMutation,
  type MarkdownTaskRecord,
  mutateMarkdownTask,
  readMarkdownTask,
} from "../application/note-task";
import { mutateMarkdownNoteText } from "../application/note-text-mutation";
import {
  listTrashedMarkdownNotes,
  restoreTrashedMarkdownNote,
  trashMarkdownNote,
} from "../application/note-trash";
import { maxSearchResults, SearchQueryError } from "../kernel/full-text-search";
import { normalizeMarkdownTaskStatus } from "../kernel/markdown-tasks";
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
import { FixedStateRoot, type StateRootPort, type VaultReadPort } from "../kernel/ports";
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
  | "restore"
  | "properties"
  | "property.read"
  | "property.set"
  | "property.remove"
  | "tasks"
  | "task"
  | "aliases"
  | "tags"
  | "tag";

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

type CliTargetKind = "path" | "file";

interface CliReadCommand extends CliVaultCommand {
  id: "read";
  filePath: string;
  targetKind: CliTargetKind;
}

interface CliSearchCommand extends CliVaultCommand {
  id: "search";
  query: string;
  limit: number;
}

interface CliTargetMetadataCommand extends CliVaultCommand {
  id: "links" | "backlinks" | "outline";
  filePath: string;
  targetKind: CliTargetKind;
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
  targetKind: CliTargetKind;
  content: string;
  inline: boolean;
}

interface CliMoveCommand extends CliVaultCommand {
  id: "move" | "rename";
  sourcePath: string;
  sourceTargetKind: CliTargetKind;
  targetValue: string;
  updateLinks: boolean;
}

interface CliTrashMutationCommand extends CliVaultCommand {
  id: "delete" | "restore";
  filePath: string;
  targetKind: CliTargetKind;
}

interface CliTrashListCommand extends CliVaultCommand {
  id: "trash.list";
}

interface CliPropertiesCommand extends CliVaultCommand {
  id: "properties";
  filePath: string;
  targetKind: CliTargetKind;
}

interface CliPropertyReadCommand extends CliVaultCommand {
  id: "property.read";
  filePath: string;
  targetKind: CliTargetKind;
  propertyName: string;
}

interface CliPropertySetCommand extends CliVaultCommand {
  id: "property.set";
  filePath: string;
  targetKind: CliTargetKind;
  propertyName: string;
  propertyValue: string;
  propertyType: NotePropertyType;
}

interface CliPropertyRemoveCommand extends CliVaultCommand {
  id: "property.remove";
  filePath: string;
  targetKind: CliTargetKind;
  propertyName: string;
}

type CliTaskFilter =
  | { kind: "all" }
  | { kind: "done" }
  | { kind: "todo" }
  | { kind: "status"; status: string };

interface CliTasksCommand extends CliVaultCommand {
  id: "tasks";
  filePath: string | null;
  targetKind: CliTargetKind | null;
  filter: CliTaskFilter;
  totalOnly: boolean;
  verbose: boolean;
}

interface CliTaskCommand extends CliVaultCommand {
  id: "task";
  filePath: string;
  targetKind: CliTargetKind;
  line: number;
  mutation: MarkdownTaskMutation | null;
}

interface CliAliasesCommand extends CliVaultCommand {
  id: "aliases";
  filePath: string | null;
  targetKind: CliTargetKind | null;
  totalOnly: boolean;
  verbose: boolean;
}

interface CliTagsCommand extends CliVaultCommand {
  id: "tags";
  filePath: string | null;
  targetKind: CliTargetKind | null;
  sortBy: "name" | "count";
  totalOnly: boolean;
  counts: boolean;
}

interface CliTagCommand extends CliVaultCommand {
  id: "tag";
  tagName: string;
  totalOnly: boolean;
  verbose: boolean;
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
  | CliTrashListCommand
  | CliPropertiesCommand
  | CliPropertyReadCommand
  | CliPropertySetCommand
  | CliPropertyRemoveCommand
  | CliTasksCommand
  | CliTaskCommand
  | CliAliasesCommand
  | CliTagsCommand
  | CliTagCommand;

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

interface CliTargetParameter {
  filePath: string;
  targetKind: CliTargetKind;
}

function parseCliTarget(value: string): CliTargetParameter {
  if (value.startsWith("file=")) {
    return { filePath: value.slice("file=".length), targetKind: "file" };
  }
  if (value.startsWith("path=")) {
    return { filePath: value.slice("path=".length), targetKind: "path" };
  }
  return { filePath: value, targetKind: "path" };
}

interface PropertyParameters {
  filePath: string | null;
  targetKind: CliTargetKind | null;
  name: string | null;
  value: string | null;
  type: string | null;
}

function parsePropertyParameters(
  values: readonly string[],
  commandName: string,
): PropertyParameters {
  const parsed: PropertyParameters = {
    filePath: null,
    targetKind: null,
    name: null,
    value: null,
    type: null,
  };
  for (const value of values) {
    if (value.startsWith("path=") || value.startsWith("file=")) {
      if (parsed.filePath !== null) {
        usageFailure(`${commandName} accepts only one note path.`);
      }
      const target = parseCliTarget(value);
      parsed.filePath = target.filePath;
      parsed.targetKind = target.targetKind;
    } else if (value.startsWith("name=")) {
      if (parsed.name !== null) {
        usageFailure(`${commandName} accepts name only once.`);
      }
      parsed.name = value.slice("name=".length);
    } else if (value.startsWith("value=")) {
      if (parsed.value !== null) {
        usageFailure(`${commandName} accepts value only once.`);
      }
      parsed.value = value.slice("value=".length);
    } else if (value.startsWith("type=")) {
      if (parsed.type !== null) {
        usageFailure(`${commandName} accepts type only once.`);
      }
      parsed.type = value.slice("type=".length);
    } else if (parsed.filePath === null && !value.includes("=")) {
      parsed.filePath = value;
      parsed.targetKind = "path";
    } else {
      usageFailure(`Unsupported ${commandName} argument: ${value}`);
    }
  }
  return parsed;
}

function requiredPropertyTarget(
  parameters: PropertyParameters,
  commandName: string,
): CliTargetParameter {
  if (!parameters.filePath || parameters.targetKind === null) {
    usageFailure(`${commandName} requires path=<note.md>.`);
  }
  return { filePath: parameters.filePath, targetKind: parameters.targetKind };
}

function requiredPropertyName(parameters: PropertyParameters, commandName: string): string {
  if (!parameters.name) {
    usageFailure(`${commandName} requires name=<name>.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(parameters.name)) {
    usageFailure(
      `${commandName} property names accept letters, numbers, underscores, and hyphens.`,
    );
  }
  return parameters.name;
}

function parseTaskReference(value: string): { filePath: string; line: number } {
  const match = /^(.*):([1-9][0-9]*)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    usageFailure("task ref requires an exact path:line value.");
  }
  return {
    filePath: match[1],
    line: parsePositiveInteger(match[2], "line"),
  };
}

function taskStatusArgument(value: string): string {
  try {
    return normalizeMarkdownTaskStatus(value);
  } catch (error) {
    usageFailure(error instanceof Error ? error.message : String(error));
  }
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
  let updateLinks = false;
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
    if (token === "--update-links") {
      if (updateLinks) {
        usageFailure("--update-links may be supplied only once.");
      }
      updateLinks = true;
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
      renamedName !== null ||
      updateLinks
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
      renamedName !== null ||
      updateLinks
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
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("read requires exactly one vault-relative Markdown path.");
    }
    const { filePath, targetKind } = parseCliTarget(values[0] ?? "");
    if (!filePath) {
      usageFailure("read requires a non-empty Markdown path.");
    }
    return { id: "read", json, vaultPath, filePath, targetKind };
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
      renamedName !== null ||
      updateLinks
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
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} requires exactly one vault-relative Markdown path.`);
    }
    const target = parseCliTarget(values[0] ?? "");
    const filePath = target.filePath;
    if (!filePath) {
      usageFailure(`${name} requires a non-empty Markdown path.`);
    }
    return {
      id: name,
      json,
      vaultPath,
      filePath,
      targetKind: name === "restore" ? "path" : target.targetKind,
    };
  }
  if (name === "tasks") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("tasks accepts parameter=value arguments and task flags only.");
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let filter: CliTaskFilter = { kind: "all" };
    let totalOnly = false;
    let verbose = false;
    const setFilter = (next: CliTaskFilter): void => {
      if (filter.kind !== "all") {
        usageFailure("tasks accepts only one of done, todo, or status=<char>.");
      }
      filter = next;
    };
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure("tasks accepts only one note path.");
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
        if (!filePath) {
          usageFailure("tasks path requires a value.");
        }
      } else if (value.startsWith("status=")) {
        setFilter({ kind: "status", status: taskStatusArgument(value.slice("status=".length)) });
      } else if (value === "done") {
        setFilter({ kind: "done" });
      } else if (value === "todo") {
        setFilter({ kind: "todo" });
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("tasks total may be supplied only once.");
        }
        totalOnly = true;
      } else if (value === "verbose") {
        if (verbose) {
          usageFailure("tasks verbose may be supplied only once.");
        }
        verbose = true;
      } else if (value === "active" || value === "daily") {
        usageFailure(`tasks ${value} is not available in the headless native subset yet.`);
      } else {
        usageFailure(`Unsupported tasks argument: ${value}`);
      }
    }
    return { id: "tasks", json, vaultPath, filePath, targetKind, filter, totalOnly, verbose };
  }
  if (name === "task") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("task accepts path, line, ref, and one mutation flag only.");
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let line: number | null = null;
    let reference: { filePath: string; line: number } | null = null;
    let mutation: MarkdownTaskMutation | null = null;
    const setMutation = (next: MarkdownTaskMutation): void => {
      if (mutation !== null) {
        usageFailure("task accepts only one of toggle, done, todo, or status=<char>.");
      }
      mutation = next;
    };
    for (const value of values) {
      if (value.startsWith("ref=")) {
        if (reference !== null) {
          usageFailure("task ref may be supplied only once.");
        }
        reference = parseTaskReference(value.slice("ref=".length));
      } else if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure("task accepts only one note path.");
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
        if (!filePath) {
          usageFailure("task path requires a value.");
        }
      } else if (value.startsWith("line=")) {
        if (line !== null) {
          usageFailure("task line may be supplied only once.");
        }
        line = parsePositiveInteger(value.slice("line=".length), "line");
      } else if (value.startsWith("status=")) {
        setMutation({
          kind: "set",
          status: taskStatusArgument(value.slice("status=".length)),
        });
      } else if (value === "toggle") {
        setMutation({ kind: "toggle" });
      } else if (value === "done") {
        setMutation({ kind: "set", status: "x" });
      } else if (value === "todo") {
        setMutation({ kind: "set", status: " " });
      } else if (value === "daily") {
        usageFailure("task daily is not available in the headless native subset yet.");
      } else {
        usageFailure(`Unsupported task argument: ${value}`);
      }
    }
    if (reference !== null) {
      if (filePath !== null || line !== null) {
        usageFailure("task accepts ref or path plus line, not both.");
      }
      filePath = reference.filePath;
      targetKind = "path";
      line = reference.line;
    }
    if (!filePath || targetKind === null || line === null) {
      usageFailure("task requires ref=<path:line> or path=<note.md> line=<n>.");
    }
    return { id: "task", json, vaultPath, filePath, targetKind, line, mutation };
  }
  if (name === "aliases") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("aliases accepts path and alias flags only.");
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let totalOnly = false;
    let verbose = false;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure("aliases accepts only one note path.");
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
        if (!filePath) {
          usageFailure("aliases path requires a value.");
        }
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("aliases total may be supplied only once.");
        }
        totalOnly = true;
      } else if (value === "verbose") {
        if (verbose) {
          usageFailure("aliases verbose may be supplied only once.");
        }
        verbose = true;
      } else if (value === "active") {
        usageFailure("aliases active is not available in the headless native subset yet.");
      } else {
        usageFailure(`Unsupported aliases argument: ${value}`);
      }
    }
    return { id: "aliases", json, vaultPath, filePath, targetKind, totalOnly, verbose };
  }
  if (name === "tags") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("tags accepts path and tag flags only.");
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let sortBy: "name" | "count" = "name";
    let totalOnly = false;
    let counts = false;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure("tags accepts only one note path.");
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
        if (!filePath) {
          usageFailure("tags path requires a value.");
        }
      } else if (value.startsWith("sort=")) {
        if (value !== "sort=count" || sortBy !== "name") {
          usageFailure("tags accepts sort=count only once.");
        }
        sortBy = "count";
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("tags total may be supplied only once.");
        }
        totalOnly = true;
      } else if (value === "counts") {
        if (counts) {
          usageFailure("tags counts may be supplied only once.");
        }
        counts = true;
      } else if (value === "active") {
        usageFailure("tags active is not available in the headless native subset yet.");
      } else {
        usageFailure(`Unsupported tags argument: ${value}`);
      }
    }
    return { id: "tags", json, vaultPath, filePath, targetKind, sortBy, totalOnly, counts };
  }
  if (name === "tag") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("tag accepts name and tag flags only.");
    }
    let tagName: string | null = null;
    let totalOnly = false;
    let verbose = false;
    for (const value of values) {
      if (value.startsWith("name=")) {
        if (tagName !== null) {
          usageFailure("tag name may be supplied only once.");
        }
        tagName = value.slice("name=".length).replace(/^#/, "");
        if (!tagName) {
          usageFailure("tag name requires a value.");
        }
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("tag total may be supplied only once.");
        }
        totalOnly = true;
      } else if (value === "verbose") {
        if (verbose) {
          usageFailure("tag verbose may be supplied only once.");
        }
        verbose = true;
      } else {
        usageFailure(`Unsupported tag argument: ${value}`);
      }
    }
    if (!tagName) {
      usageFailure("tag requires name=<tag>.");
    }
    if (!/^[\p{L}\p{N}_/-]+$/u.test(tagName)) {
      usageFailure("tag names accept letters, numbers, underscores, hyphens, and slashes.");
    }
    return { id: "tag", json, vaultPath, tagName, totalOnly, verbose };
  }
  if (
    name === "properties" ||
    name === "property:read" ||
    name === "property:set" ||
    name === "property:remove"
  ) {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} accepts parameter=value arguments only.`);
    }
    const parameters = parsePropertyParameters(values, name);
    const { filePath, targetKind } = requiredPropertyTarget(parameters, name);
    if (name === "properties") {
      if (parameters.name !== null || parameters.value !== null || parameters.type !== null) {
        usageFailure("properties accepts only one note path.");
      }
      return { id: "properties", json, vaultPath, filePath, targetKind };
    }
    const propertyName = requiredPropertyName(parameters, name);
    if (name === "property:read") {
      if (parameters.value !== null || parameters.type !== null) {
        usageFailure("property:read accepts only path and name parameters.");
      }
      return { id: "property.read", json, vaultPath, filePath, targetKind, propertyName };
    }
    if (name === "property:remove") {
      if (parameters.value !== null || parameters.type !== null) {
        usageFailure("property:remove accepts only path and name parameters.");
      }
      return { id: "property.remove", json, vaultPath, filePath, targetKind, propertyName };
    }
    if (parameters.value === null) {
      usageFailure("property:set requires value=<value>.");
    }
    const propertyType = parameters.type ?? "text";
    if (!notePropertyTypes.includes(propertyType as NotePropertyType)) {
      usageFailure(`Unsupported property type: ${propertyType}`);
    }
    return {
      id: "property.set",
      json,
      vaultPath,
      filePath,
      targetKind,
      propertyName,
      propertyValue: parameters.value,
      propertyType: propertyType as NotePropertyType,
    };
  }
  if (name === "links" || name === "backlinks" || name === "outline") {
    if (
      values.length !== 1 ||
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} requires exactly one vault-relative Markdown path.`);
    }
    const { filePath, targetKind } = parseCliTarget(values[0] ?? "");
    if (!filePath) {
      usageFailure(`${name} requires a non-empty Markdown path.`);
    }
    return { id: name, json, vaultPath, filePath, targetKind };
  }
  if (name === "unresolved" || name === "orphans" || name === "deadends") {
    if (
      values.length > 0 ||
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
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
      renamedName !== null ||
      updateLinks
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
      renamedName !== null ||
      updateLinks
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
    if (
      directory !== null ||
      limit !== null ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let parameterContent: string | null = null;
    let inlineFlag = inline;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure(`${name} accepts only one note path.`);
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
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
        targetKind = "path";
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (!filePath || targetKind === null) {
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
      targetKind,
      content: decodedContent,
      inline: inlineFlag,
    };
  }
  if (name === "move" || name === "rename") {
    if (directory !== null || limit !== null || content !== null || inline) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    let sourcePath: string | null = null;
    let sourceTargetKind: CliTargetKind | null = null;
    let parameterDestination: string | null = null;
    let parameterName: string | null = null;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (sourcePath !== null) {
          usageFailure(`${name} accepts only one source path.`);
        }
        const target = parseCliTarget(value);
        sourcePath = target.filePath;
        sourceTargetKind = target.targetKind;
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
        sourceTargetKind = "path";
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (!sourcePath || sourceTargetKind === null) {
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
      pathArgument(() => movedMarkdownPath(sourcePath, targetDestination));
      return {
        id: "move",
        json,
        vaultPath,
        sourcePath,
        sourceTargetKind,
        targetValue: targetDestination,
        updateLinks,
      };
    }
    if (!targetName || targetDestination !== null) {
      usageFailure("rename requires exactly one --name or name= filename.");
    }
    pathArgument(() => renamedMarkdownPath(sourcePath, targetName));
    return {
      id: "rename",
      json,
      vaultPath,
      sourcePath,
      sourceTargetKind,
      targetValue: targetName,
      updateLinks,
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
  threadleaf --vault <path> [--json] move <note> --to <path> [--update-links]
  threadleaf --vault <path> [--json] rename <note> --name <filename> [--update-links]
  threadleaf --vault <path> [--json] delete <note>
  threadleaf --vault <path> [--json] trash list
  threadleaf --vault <path> [--json] restore <note>
  threadleaf --vault <path> [--json] properties path=<note.md>
  threadleaf --vault <path> [--json] property:read path=<note.md> name=<name>
  threadleaf --vault <path> [--json] property:set path=<note.md> name=<name> value=<value> [type=<type>]
  threadleaf --vault <path> [--json] property:remove path=<note.md> name=<name>
  threadleaf --vault <path> [--json] tasks [path=<note.md>] [done|todo|status=<char>] [total|verbose]
  threadleaf --vault <path> [--json] task ref=<note.md:line> [toggle|done|todo|status=<char>]
  threadleaf --vault <path> [--json] aliases [path=<note.md>] [total|verbose]
  threadleaf --vault <path> [--json] tags [path=<note.md>] [sort=count] [total|counts]
  threadleaf --vault <path> [--json] tag name=<tag> [total|verbose]

Compatibility spellings:
  threadleaf --vault <path> read file=<note-name>
  threadleaf --vault <path> search query=<text>
  threadleaf --vault <path> links path=<note.md>
  threadleaf --vault <path> backlinks file=<note-name>
  threadleaf --vault <path> outline path=<note.md>
  threadleaf --vault <path> create path=<note> content=<text>
  threadleaf --vault <path> append path=<note> content=<text> [inline]
  threadleaf --vault <path> prepend path=<note> content=<text> [inline]
  threadleaf --vault <path> move path=<note> to=<path>
  threadleaf --vault <path> rename path=<note> name=<filename>
  threadleaf --vault <path> delete path=<note>
  threadleaf --vault <path> restore path=<note>
  threadleaf --vault <path> properties path=<note.md>
  threadleaf --vault <path> property:read path=<note.md> name=<name>
  threadleaf --vault <path> property:set path=<note.md> name=<name> value=<value> [type=<type>]
  threadleaf --vault <path> property:remove path=<note.md> name=<name>
  threadleaf --vault <path> tasks [file=<note-name>] [done|todo|status=<char>] [total|verbose]
  threadleaf --vault <path> task path=<note.md> line=<n> [toggle|done|todo|status=<char>]
  threadleaf --vault <path> aliases [file=<note-name>] [total|verbose]
  threadleaf --vault <path> tags [path=<note.md>] [sort=count] [total|counts]
  threadleaf --vault <path> tag name=<tag> [total|verbose]

Target rules:
  Positional note targets and path= are exact vault-relative paths.
  file= resolves one case-insensitive NFC-normalized Markdown basename; .md is optional.
  Missing and duplicate file= matches fail explicitly instead of choosing a note.

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

function cliFileLookupKey(rawTarget: string): string {
  const portableTarget = rawTarget.replaceAll("\\", "/");
  const basename = path.posix.basename(portableTarget);
  const stem = basename.toLocaleLowerCase("en-US").endsWith(".md")
    ? basename.slice(0, -3)
    : basename;
  return stem.normalize("NFC").toLocaleLowerCase("en-US");
}

async function resolveCliMarkdownTarget(
  vault: VaultReadPort,
  requestedPath: string,
  targetKind: CliTargetKind,
): Promise<string> {
  if (targetKind === "path") {
    return requestedPath;
  }
  if (
    requestedPath.length > 4096 ||
    requestedPath.includes("\0") ||
    requestedPath.endsWith("/") ||
    requestedPath.endsWith("\\")
  ) {
    throw new Error(`Invalid file= note name: ${requestedPath}`);
  }
  const requestedKey = cliFileLookupKey(requestedPath);
  if (!requestedKey) {
    throw new Error("file= requires a non-empty Markdown note name.");
  }
  const matches = (await vault.listMarkdownPaths()).filter(
    (candidatePath) => cliFileLookupKey(candidatePath) === requestedKey,
  );
  if (matches.length === 0) {
    throw new Error(`No Markdown note matches file=${requestedPath}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous file=${requestedPath}. Matches: ${matches.join(", ")}`);
  }
  return matches[0] as string;
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

interface AliasCatalogEntry {
  alias: string;
  path: string;
}

interface TagCatalogEntry {
  name: string;
  count: number;
  files: string[];
}

function selectedMetadataDocuments(
  snapshot: MetadataIndexSnapshot,
  filePath: string | null,
  commandName: string,
): DocumentMetadataSnapshot[] {
  return filePath === null
    ? snapshot.documents
    : [indexedMarkdownDocument(snapshot, filePath, commandName)];
}

function aliasCatalog(
  snapshot: MetadataIndexSnapshot,
  filePath: string | null,
): AliasCatalogEntry[] {
  return selectedMetadataDocuments(snapshot, filePath, "aliases")
    .flatMap((document) =>
      Object.entries(document.properties)
        .filter(([name]) => {
          const normalized = name.toLocaleLowerCase("en-US");
          return normalized === "alias" || normalized === "aliases";
        })
        .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
        .filter((alias) => alias.length > 0)
        .map((alias) => ({ alias, path: document.path })),
    )
    .sort(
      (left, right) => left.alias.localeCompare(right.alias) || left.path.localeCompare(right.path),
    );
}

function tagCatalog(
  snapshot: MetadataIndexSnapshot,
  filePath: string | null,
  sortBy: "name" | "count" = "name",
): TagCatalogEntry[] {
  const entriesByTag = new Map<string, { count: number; files: string[] }>();
  for (const document of selectedMetadataDocuments(snapshot, filePath, "tags")) {
    for (const [name, count] of Object.entries(document.tagCounts)) {
      const current = entriesByTag.get(name) ?? { count: 0, files: [] };
      entriesByTag.set(name, {
        count: current.count + count,
        files: [...current.files, document.path],
      });
    }
  }
  return [...entriesByTag.entries()]
    .map(([name, entry]) => ({ name, count: entry.count, files: entry.files }))
    .sort((left, right) =>
      sortBy === "count"
        ? right.count - left.count || left.name.localeCompare(right.name)
        : left.name.localeCompare(right.name),
    );
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

function isCliMutationCommand(command: Exclude<ParsedCliCommand, CliHelpCommand>): boolean {
  return (
    command.id === "create" ||
    command.id === "append" ||
    command.id === "prepend" ||
    command.id === "move" ||
    command.id === "rename" ||
    command.id === "delete" ||
    command.id === "restore" ||
    command.id === "property.set" ||
    command.id === "property.remove" ||
    (command.id === "task" && command.mutation !== null)
  );
}

async function executeCommand(
  command: Exclude<ParsedCliCommand, CliHelpCommand>,
  options: CliRunOptions,
): Promise<unknown> {
  const kernel = isCliMutationCommand(command)
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
      const sourcePath = await resolveCliMarkdownTarget(
        kernel,
        command.sourcePath,
        command.sourceTargetKind,
      );
      const targetPath =
        command.id === "move"
          ? movedMarkdownPath(sourcePath, command.targetValue)
          : renamedMarkdownPath(sourcePath, command.targetValue);
      const outcome = await moveMarkdownNote(
        kernel,
        sourcePath,
        targetPath,
        undefined,
        command.updateLinks ? { acceptCurrentRewrites: true } : undefined,
      );
      if (outcome.status === "requires-confirmation") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The ${command.id} requires ${outcome.rewrites.length} link target ${outcome.rewrites.length === 1 ? "update" : "updates"}. Review this preview, then rerun with --update-links.`,
          { details: outcome },
        );
      }
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
      const filePath =
        command.id === "delete"
          ? await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind)
          : command.filePath;
      const outcome =
        command.id === "delete"
          ? await trashMarkdownNote(kernel, filePath)
          : await restoreTrashedMarkdownNote(kernel, filePath);
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
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const outcome = await mutateMarkdownNoteText(
        kernel,
        filePath,
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
    if (command.id === "property.set") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const outcome = await setMarkdownNoteProperty(
        kernel,
        filePath,
        command.propertyName,
        command.propertyValue,
        command.propertyType,
      );
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The note changed while setting ${command.propertyName}. The proposed version was preserved as ${outcome.conflictPath}.`,
          { details: outcome },
        );
      }
      return outcome;
    }
    if (command.id === "property.remove") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const outcome = await removeMarkdownNoteProperty(kernel, filePath, command.propertyName);
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The note changed while removing ${command.propertyName}. The proposed version was preserved as ${outcome.conflictPath}.`,
          { details: outcome },
        );
      }
      return outcome;
    }
    if (command.id === "tasks") {
      const filePath =
        command.filePath === null || command.targetKind === null
          ? null
          : await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const tasks = await listMarkdownTasks(kernel, filePath ?? undefined);
      const filtered = tasks.filter((task) => {
        if (command.filter.kind === "done") {
          return task.completed;
        }
        if (command.filter.kind === "todo") {
          return !task.completed;
        }
        if (command.filter.kind === "status") {
          return task.status === command.filter.status;
        }
        return true;
      });
      return {
        path: filePath,
        filter: command.filter,
        total: filtered.length,
        tasks: filtered,
      };
    }
    if (command.id === "task") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      if (command.mutation === null) {
        return readMarkdownTask(kernel, filePath, command.line);
      }
      const outcome = await mutateMarkdownTask(kernel, filePath, command.line, command.mutation);
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The note changed while updating ${outcome.task.path}:${outcome.task.line}. The proposed version was preserved as ${outcome.conflictPath}.`,
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
      const filePath = normalizeVaultPath(
        await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind),
      );
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
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const document = indexedMarkdownDocument(snapshot, filePath, command.id);
      return { path: document.path, total: document.links.length, links: document.links };
    }
    if (command.id === "backlinks") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const document = indexedMarkdownDocument(snapshot, filePath, command.id);
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
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const document = indexedMarkdownDocument(snapshot, filePath, command.id);
      return { path: document.path, total: document.headings.length, headings: document.headings };
    }
    if (command.id === "properties") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const document = indexedMarkdownDocument(snapshot, filePath, command.id);
      return {
        path: document.path,
        total: Object.keys(document.properties).length,
        properties: document.properties,
      };
    }
    if (command.id === "property.read") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const document = indexedMarkdownDocument(snapshot, filePath, command.id);
      const exists = Object.hasOwn(document.properties, command.propertyName);
      return {
        path: document.path,
        name: command.propertyName,
        exists,
        value: exists ? document.properties[command.propertyName] : null,
      };
    }
    if (command.id === "aliases") {
      const filePath =
        command.filePath === null || command.targetKind === null
          ? null
          : await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const aliases = aliasCatalog(snapshot, filePath);
      return { path: filePath, total: aliases.length, aliases };
    }
    if (command.id === "tags") {
      const filePath =
        command.filePath === null || command.targetKind === null
          ? null
          : await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const tags = tagCatalog(snapshot, filePath, command.sortBy);
      return { path: filePath, sort: command.sortBy, total: tags.length, tags };
    }
    if (command.id === "tag") {
      const entry = tagCatalog(snapshot, null).find((tag) => tag.name === command.tagName);
      return entry ?? { name: command.tagName, count: 0, files: [] };
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
  if (!isCliMutationCommand(command)) {
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

function humanPropertyValue(value: string | string[]): string {
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function humanTask(task: MarkdownTaskRecord): string {
  return `- [${task.status}]${task.text ? ` ${task.text}` : ""}`;
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
  if (command.id === "tasks") {
    const result = data as { total: number; tasks: MarkdownTaskRecord[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (result.tasks.length === 0) {
      return "No tasks.\n";
    }
    return `${result.tasks
      .map((task) =>
        command.verbose ? `${task.path}:${task.line}\t${humanTask(task)}` : humanTask(task),
      )
      .join("\n")}\n`;
  }
  if (command.id === "task") {
    const result = data as {
      status?: "committed" | "unchanged";
      task: MarkdownTaskRecord;
    };
    const rendered = `${result.task.path}:${result.task.line}\t${humanTask(result.task)}`;
    if (command.mutation === null) {
      return `${rendered}\n`;
    }
    return result.status === "unchanged"
      ? `Task already has that status: ${rendered}\n`
      : `Updated task: ${rendered}\n`;
  }
  if (command.id === "aliases") {
    const result = data as { total: number; aliases: AliasCatalogEntry[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (result.aliases.length === 0) {
      return "No aliases.\n";
    }
    return `${result.aliases
      .map((entry) => (command.verbose ? `${entry.alias}\t${entry.path}` : entry.alias))
      .join("\n")}\n`;
  }
  if (command.id === "tags") {
    const result = data as { total: number; tags: TagCatalogEntry[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (result.tags.length === 0) {
      return "No tags.\n";
    }
    return `${result.tags
      .map((entry) => `#${entry.name}${command.counts ? `\t${entry.count}` : ""}`)
      .join("\n")}\n`;
  }
  if (command.id === "tag") {
    const result = data as TagCatalogEntry;
    if (command.totalOnly) {
      return `${result.count}\n`;
    }
    const summary = `#${result.name}\t${result.count}`;
    return command.verbose && result.files.length > 0
      ? `${summary}\n${result.files.join("\n")}\n`
      : `${summary}\n`;
  }
  if (command.id === "properties") {
    const result = data as { path: string; properties: Record<string, string | string[]> };
    const entries = Object.entries(result.properties);
    return entries.length > 0
      ? `Properties for ${result.path}:\n${entries
          .map(([name, value]) => `${name}: ${humanPropertyValue(value)}`)
          .join("\n")}\n`
      : `No indexed properties in ${result.path}.\n`;
  }
  if (command.id === "property.read") {
    const result = data as {
      path: string;
      name: string;
      exists: boolean;
      value: string | string[] | null;
    };
    return result.exists && result.value !== null
      ? `${humanPropertyValue(result.value)}\n`
      : `Property ${result.name} is not set on ${result.path}.\n`;
  }
  if (command.id === "property.set") {
    const result = data as { path: string; name: string };
    return `Set ${result.name} on ${result.path}\n`;
  }
  if (command.id === "property.remove") {
    const result = data as { status: "committed" | "missing"; path: string; name: string };
    return result.status === "missing"
      ? `Property ${result.name} is already absent from ${result.path}\n`
      : `Removed ${result.name} from ${result.path}\n`;
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
