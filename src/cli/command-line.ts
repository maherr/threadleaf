import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import moment, { type Moment } from "moment";
import { createMarkdownNote } from "../application/note-creation";
import { openOrCreateDailyNote } from "../application/note-daily";
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
import {
  dailyNotePath,
  listNoteTemplates,
  loadNoteTemplate,
  noteTemplateTitle,
  renderNoteTemplate,
} from "../application/note-template";
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
import { displayTitleFromVaultPath, normalizeMarkdownNotePath } from "../kernel/note-path";
import {
  canonicalizePotentialPath,
  isPathInside,
  normalizeVaultDirectoryPath,
  normalizeVaultPath,
} from "../kernel/path-policy";
import { FixedStateRoot, type StateRootPort, type VaultReadPort } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  createDefaultVaultNoteWorkflowSettings,
  normalizeNoteWorkflowFile,
  normalizeNoteWorkflowFolder,
} from "../shared/note-workflows";
import { parsePluginId } from "../shared/plugins";
import {
  type CliPluginCatalog,
  type CliPluginCatalogEntry,
  type CliSnippetCatalogEntry,
  type CliThemeCatalogEntry,
  catalogLookupKey,
  readAppearanceCatalog,
  readCommunityPluginCatalog,
} from "./compatibility-catalog";

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
  | "file"
  | "files"
  | "folder"
  | "folders"
  | "wordcount"
  | "read"
  | "search"
  | "search.context"
  | "links"
  | "backlinks"
  | "unresolved"
  | "orphans"
  | "deadends"
  | "outline"
  | "create"
  | "daily"
  | "daily.path"
  | "daily.read"
  | "daily.append"
  | "daily.prepend"
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
  | "tag"
  | "templates"
  | "template.read"
  | "random.read"
  | "plugins"
  | "plugin"
  | "themes"
  | "theme"
  | "snippets";

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
  folder: string;
  extension: string | null;
  totalOnly: boolean;
}

interface CliFileCommand extends CliVaultCommand {
  id: "file";
  filePath: string;
  targetKind: CliTargetKind;
}

interface CliFolderCommand extends CliVaultCommand {
  id: "folder";
  folder: string;
  info: "files" | "folders" | "size" | null;
}

interface CliFoldersCommand extends CliVaultCommand {
  id: "folders";
  folder: string;
  totalOnly: boolean;
}

type CliTargetKind = "path" | "file";
type CliTabularFormat = "tsv" | "csv" | "json";
type CliSearchFormat = "text" | "json";
type CliOutlineFormat = "tree" | "md" | "json";

interface CliReadCommand extends CliVaultCommand {
  id: "read";
  filePath: string;
  targetKind: CliTargetKind;
}

interface CliWordcountCommand extends CliVaultCommand {
  id: "wordcount";
  filePath: string;
  targetKind: CliTargetKind;
  valueOnly: "words" | "characters" | null;
}

interface CliSearchCommand extends CliVaultCommand {
  id: "search" | "search.context";
  query: string;
  folder: string;
  limit: number;
  format: CliSearchFormat;
  totalOnly: boolean;
  caseSensitive: boolean;
}

interface CliLinksCommand extends CliVaultCommand {
  id: "links";
  filePath: string;
  targetKind: CliTargetKind;
  totalOnly: boolean;
}

interface CliBacklinksCommand extends CliVaultCommand {
  id: "backlinks";
  filePath: string;
  targetKind: CliTargetKind;
  counts: boolean;
  totalOnly: boolean;
  format: CliTabularFormat;
}

interface CliOutlineCommand extends CliVaultCommand {
  id: "outline";
  filePath: string;
  targetKind: CliTargetKind;
  totalOnly: boolean;
  format: CliOutlineFormat;
}

interface CliUnresolvedCommand extends CliVaultCommand {
  id: "unresolved";
  counts: boolean;
  totalOnly: boolean;
  verbose: boolean;
  format: CliTabularFormat;
}

interface CliVaultMetadataCommand extends CliVaultCommand {
  id: "orphans" | "deadends";
  totalOnly: boolean;
}

interface CliCreateCommand extends CliVaultCommand {
  id: "create";
  filePath: string;
  content: string;
  templatePath: string | null;
  dateFormat: string;
  timeFormat: string;
}

interface CliDailyCommand extends CliVaultCommand {
  id: "daily";
  folder: string;
  format: string;
  templatePath: string | null;
  dateFormat: string;
  timeFormat: string;
}

interface CliDailyPathCommand extends CliVaultCommand {
  id: "daily.path" | "daily.read";
  folder: string;
  format: string;
}

interface CliDailyTextCommand extends CliVaultCommand {
  id: "daily.append" | "daily.prepend";
  folder: string;
  format: string;
  content: string;
  inline: boolean;
}

interface CliTemplatesCommand extends CliVaultCommand {
  id: "templates";
  folder: string;
  totalOnly: boolean;
}

interface CliTemplateReadCommand extends CliVaultCommand {
  id: "template.read";
  folder: string;
  templatePath: string;
  templateTargetKind: "name" | "path";
  title: string | null;
  resolve: boolean;
}

interface CliRandomReadCommand extends CliVaultCommand {
  id: "random.read";
  folder: string;
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

interface CliPluginsCommand extends CliVaultCommand {
  id: "plugins";
  filter: "community";
  versions: boolean;
  format: CliTabularFormat;
}

interface CliPluginCommand extends CliVaultCommand {
  id: "plugin";
  pluginId: string;
}

interface CliThemesCommand extends CliVaultCommand {
  id: "themes";
  versions: boolean;
}

interface CliThemeCommand extends CliVaultCommand {
  id: "theme";
  themeName: string;
}

interface CliSnippetsCommand extends CliVaultCommand {
  id: "snippets";
}

export type ParsedCliCommand =
  | CliHelpCommand
  | CliVaultInfoCommand
  | CliFileCommand
  | CliFilesCommand
  | CliFolderCommand
  | CliFoldersCommand
  | CliWordcountCommand
  | CliReadCommand
  | CliSearchCommand
  | CliLinksCommand
  | CliBacklinksCommand
  | CliOutlineCommand
  | CliUnresolvedCommand
  | CliVaultMetadataCommand
  | CliCreateCommand
  | CliDailyCommand
  | CliDailyPathCommand
  | CliDailyTextCommand
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
  | CliTagCommand
  | CliTemplatesCommand
  | CliTemplateReadCommand
  | CliRandomReadCommand
  | CliPluginsCommand
  | CliPluginCommand
  | CliThemesCommand
  | CliThemeCommand
  | CliSnippetsCommand;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface CliRunOptions {
  stateRoot?: StateRootPort;
  /** Injectable clock for deterministic daily/template fixtures. */
  now?: Moment;
  /** Injectable index selector for deterministic random-note fixtures. */
  randomSelector?: (paths: readonly string[]) => number | string;
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

function parseMomentFormat(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    usageFailure(`${label} must contain between 1 and 256 characters on one line.`);
  }
  return normalized;
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

function parseTabularFormat(value: string, commandName: string): CliTabularFormat {
  if (value !== "tsv" && value !== "csv" && value !== "json") {
    usageFailure(`${commandName} format must be json, tsv, or csv.`);
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
  if (name === "file") {
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
      usageFailure("file requires exactly one vault file target.");
    }
    const { filePath, targetKind } = parseCliTarget(values[0] ?? "");
    if (!filePath) {
      usageFailure("file requires a non-empty target.");
    }
    return { id: "file", json, vaultPath, filePath, targetKind };
  }
  if (name === "files") {
    if (
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("files accepts folder, ext, and total arguments only.");
    }
    let parameterFolder: string | null = null;
    let extension: string | null = null;
    let totalOnly = false;
    for (const value of values) {
      if (value.startsWith("folder=")) {
        if (parameterFolder !== null) {
          usageFailure("files folder may be supplied only once.");
        }
        parameterFolder = value.slice("folder=".length);
        if (!parameterFolder) {
          usageFailure("files folder requires a value.");
        }
      } else if (value.startsWith("ext=")) {
        if (extension !== null) {
          usageFailure("files ext may be supplied only once.");
        }
        extension = value.slice("ext=".length).replace(/^\./, "");
        if (!extension || extension.includes("/") || extension.includes("\\")) {
          usageFailure("files ext requires one extension name.");
        }
        extension = extension.normalize("NFC").toLocaleLowerCase("en-US");
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("files total may be supplied only once.");
        }
        totalOnly = true;
      } else {
        usageFailure(`Unsupported files argument: ${value}`);
      }
    }
    if (directory !== null && parameterFolder !== null) {
      usageFailure("files folder may be supplied as --directory or folder=, not both.");
    }
    return {
      id: "files",
      json,
      vaultPath,
      folder: directory ?? parameterFolder ?? "",
      extension,
      totalOnly,
    };
  }
  if (name === "folders") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("folders accepts folder and total arguments only.");
    }
    let folder = "";
    let hasFolder = false;
    let totalOnly = false;
    for (const value of values) {
      if (value.startsWith("folder=")) {
        if (hasFolder) {
          usageFailure("folders folder may be supplied only once.");
        }
        folder = value.slice("folder=".length);
        if (!folder) {
          usageFailure("folders folder requires a value.");
        }
        hasFolder = true;
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("folders total may be supplied only once.");
        }
        totalOnly = true;
      } else {
        usageFailure(`Unsupported folders argument: ${value}`);
      }
    }
    return { id: "folders", json, vaultPath, folder, totalOnly };
  }
  if (name === "folder") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("folder accepts path and info arguments only.");
    }
    let folder: string | null = null;
    let info: CliFolderCommand["info"] = null;
    for (const value of values) {
      if (value.startsWith("path=")) {
        if (folder !== null) {
          usageFailure("folder path may be supplied only once.");
        }
        folder = value.slice("path=".length);
      } else if (value.startsWith("info=")) {
        if (info !== null) {
          usageFailure("folder info may be supplied only once.");
        }
        const requestedInfo = value.slice("info=".length);
        if (requestedInfo !== "files" && requestedInfo !== "folders" && requestedInfo !== "size") {
          usageFailure("folder info must be files, folders, or size.");
        }
        info = requestedInfo;
      } else if (folder === null && !value.includes("=")) {
        folder = value;
      } else {
        usageFailure(`Unsupported folder argument: ${value}`);
      }
    }
    if (!folder) {
      usageFailure("folder requires path=<folder>.");
    }
    return { id: "folder", json, vaultPath, folder, info };
  }
  if (name === "wordcount") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("wordcount accepts one note target and a count flag only.");
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let valueOnly: CliWordcountCommand["valueOnly"] = null;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure("wordcount accepts only one note target.");
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
      } else if (value === "words" || value === "characters") {
        if (valueOnly !== null) {
          usageFailure("wordcount accepts only one of words or characters.");
        }
        valueOnly = value;
      } else if (filePath === null && !value.includes("=")) {
        filePath = value;
        targetKind = "path";
      } else {
        usageFailure(`Unsupported wordcount argument: ${value}`);
      }
    }
    if (!filePath || targetKind === null) {
      usageFailure("wordcount requires one Markdown note target.");
    }
    return { id: "wordcount", json, vaultPath, filePath, targetKind, valueOnly };
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
  if (name === "templates") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("templates accepts folder and total arguments only.");
    }
    const defaults = createDefaultVaultNoteWorkflowSettings();
    let folder = defaults.templateFolder;
    let folderSet = false;
    let totalOnly = false;
    for (const value of values) {
      if (value.startsWith("folder=")) {
        if (folderSet) {
          usageFailure("templates folder may be supplied only once.");
        }
        folder = pathArgument(() =>
          normalizeNoteWorkflowFolder(value.slice("folder=".length), "Template folder"),
        );
        folderSet = true;
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure("templates total may be supplied only once.");
        }
        totalOnly = true;
      } else {
        usageFailure(`Unsupported templates argument: ${value}`);
      }
    }
    return { id: "templates", json, vaultPath, folder, totalOnly };
  }
  if (name === "template:read") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("template:read accepts name, folder, title, and resolve arguments only.");
    }
    const defaults = createDefaultVaultNoteWorkflowSettings();
    let folder = defaults.templateFolder;
    let templatePath: string | null = null;
    let templateTargetKind: CliTemplateReadCommand["templateTargetKind"] | null = null;
    let title: string | null = null;
    let resolve = false;
    let folderSet = false;
    let titleSet = false;
    for (const value of values) {
      if (value.startsWith("name=") || value.startsWith("path=")) {
        if (templatePath !== null) {
          usageFailure("template:read accepts one template name.");
        }
        templateTargetKind = value.startsWith("path=") ? "path" : "name";
        templatePath = pathArgument(() =>
          normalizeNoteWorkflowFile(value.slice(value.indexOf("=") + 1), "Template name"),
        );
      } else if (value.startsWith("folder=")) {
        if (folderSet) {
          usageFailure("template:read folder may be supplied only once.");
        }
        folder = pathArgument(() =>
          normalizeNoteWorkflowFolder(value.slice("folder=".length), "Template folder"),
        );
        folderSet = true;
      } else if (value.startsWith("title=")) {
        if (titleSet) {
          usageFailure("template:read title may be supplied only once.");
        }
        title = value.slice("title=".length);
        titleSet = true;
      } else if (value === "resolve") {
        if (resolve) {
          usageFailure("template:read resolve may be supplied only once.");
        }
        resolve = true;
      } else if (templatePath === null && !value.includes("=")) {
        templateTargetKind = "name";
        templatePath = pathArgument(() => normalizeNoteWorkflowFile(value, "Template name"));
      } else {
        usageFailure(`Unsupported template:read argument: ${value}`);
      }
    }
    if (templatePath === null) {
      usageFailure("template:read requires name=<template>.");
    }
    return {
      id: "template.read",
      json,
      vaultPath,
      folder,
      templatePath,
      templateTargetKind: templateTargetKind as CliTemplateReadCommand["templateTargetKind"],
      title,
      resolve,
    };
  }
  if (name === "random:read") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("random:read accepts only the optional folder argument.");
    }
    let folder = "";
    let folderSet = false;
    for (const value of values) {
      if (!value.startsWith("folder=")) {
        usageFailure(`Unsupported random:read argument: ${value}`);
      }
      if (folderSet) {
        usageFailure("random:read folder may be supplied only once.");
      }
      folder = pathArgument(() =>
        normalizeNoteWorkflowFolder(value.slice("folder=".length), "Random-note folder"),
      );
      folderSet = true;
    }
    return { id: "random.read", json, vaultPath, folder };
  }
  if (name === "plugins") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("plugins accepts filter, versions, and format arguments only.");
    }
    let filter: CliPluginsCommand["filter"] = "community";
    let hasFilter = false;
    let versions = false;
    let format: CliTabularFormat = "tsv";
    let hasFormat = false;
    for (const value of values) {
      if (value.startsWith("filter=")) {
        if (hasFilter) {
          usageFailure("plugins filter may be supplied only once.");
        }
        const requestedFilter = value.slice("filter=".length);
        if (requestedFilter === "core") {
          usageFailure(
            "plugins filter=core is unavailable because Threadleaf has no safe headless core-plugin catalog.",
          );
        }
        if (requestedFilter !== "community") {
          usageFailure("plugins filter must be community.");
        }
        filter = requestedFilter;
        hasFilter = true;
      } else if (value === "versions") {
        if (versions) {
          usageFailure("plugins versions may be supplied only once.");
        }
        versions = true;
      } else if (value.startsWith("format=")) {
        if (hasFormat) {
          usageFailure("plugins format may be supplied only once.");
        }
        format = parseTabularFormat(value.slice("format=".length), "plugins");
        hasFormat = true;
      } else {
        usageFailure(`Unsupported plugins argument: ${value}`);
      }
    }
    return { id: "plugins", json, vaultPath, filter, versions, format };
  }
  if (name === "plugin") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("plugin accepts id=<plugin-id> only.");
    }
    let pluginId: string | null = null;
    for (const value of values) {
      if (!value.startsWith("id=")) {
        usageFailure(`Unsupported plugin argument: ${value}`);
      }
      if (pluginId !== null) {
        usageFailure("plugin id may be supplied only once.");
      }
      try {
        pluginId = parsePluginId(value.slice("id=".length));
      } catch (error) {
        usageFailure(error instanceof Error ? error.message : "plugin id is invalid.");
      }
    }
    if (pluginId === null) {
      usageFailure("plugin requires id=<plugin-id>.");
    }
    return { id: "plugin", json, vaultPath, pluginId };
  }
  if (name === "themes") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks ||
      values.some((value) => value !== "versions") ||
      values.filter((value) => value === "versions").length > 1
    ) {
      usageFailure("themes accepts only the optional versions flag.");
    }
    return { id: "themes", json, vaultPath, versions: values.includes("versions") };
  }
  if (name === "theme") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("theme accepts name=<theme-name> only.");
    }
    let themeName: string | null = null;
    for (const value of values) {
      if (!value.startsWith("name=")) {
        usageFailure(`Unsupported theme argument: ${value}`);
      }
      if (themeName !== null) {
        usageFailure("theme name may be supplied only once.");
      }
      themeName = value.slice("name=".length);
      if (!catalogLookupKey(themeName)) {
        usageFailure("theme name requires a value.");
      }
    }
    if (themeName === null) {
      usageFailure(
        "theme requires name=<theme-name>; active-theme selection remains private application state.",
      );
    }
    return { id: "theme", json, vaultPath, themeName };
  }
  if (name === "snippets") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks ||
      values.length > 0
    ) {
      usageFailure("snippets does not accept arguments.");
    }
    return { id: "snippets", json, vaultPath };
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
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} accepts one note target and its documented output flags only.`);
    }
    let filePath: string | null = null;
    let targetKind: CliTargetKind | null = null;
    let totalOnly = false;
    let counts = false;
    let format: CliTabularFormat | CliOutlineFormat = name === "outline" ? "tree" : "tsv";
    let hasFormat = false;
    for (const value of values) {
      if (value.startsWith("path=") || value.startsWith("file=")) {
        if (filePath !== null) {
          usageFailure(`${name} accepts only one note target.`);
        }
        const target = parseCliTarget(value);
        filePath = target.filePath;
        targetKind = target.targetKind;
      } else if (value === "total") {
        if (totalOnly) {
          usageFailure(`${name} total may be supplied only once.`);
        }
        totalOnly = true;
      } else if (value === "counts" && name === "backlinks") {
        if (counts) {
          usageFailure("backlinks counts may be supplied only once.");
        }
        counts = true;
      } else if (value.startsWith("format=") && name !== "links") {
        if (hasFormat) {
          usageFailure(`${name} format may be supplied only once.`);
        }
        const requestedFormat = value.slice("format=".length);
        if (name === "outline") {
          if (
            requestedFormat !== "tree" &&
            requestedFormat !== "md" &&
            requestedFormat !== "json"
          ) {
            usageFailure("outline format must be tree, md, or json.");
          }
          format = requestedFormat;
        } else {
          format = parseTabularFormat(requestedFormat, name);
        }
        hasFormat = true;
      } else if (filePath === null && !value.includes("=")) {
        filePath = value;
        targetKind = "path";
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (!filePath || targetKind === null) {
      usageFailure(`${name} requires exactly one Markdown note target.`);
    }
    if (name === "links") {
      return { id: "links", json, vaultPath, filePath, targetKind, totalOnly };
    }
    if (name === "backlinks") {
      return {
        id: "backlinks",
        json,
        vaultPath,
        filePath,
        targetKind,
        counts,
        totalOnly,
        format: format as CliTabularFormat,
      };
    }
    return {
      id: "outline",
      json,
      vaultPath,
      filePath,
      targetKind,
      totalOnly,
      format: format as CliOutlineFormat,
    };
  }
  if (name === "unresolved") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("unresolved accepts output flags only.");
    }
    let totalOnly = false;
    let counts = false;
    let verbose = false;
    let format: CliTabularFormat = "tsv";
    let hasFormat = false;
    for (const value of values) {
      if (value === "total") {
        if (totalOnly) {
          usageFailure("unresolved total may be supplied only once.");
        }
        totalOnly = true;
      } else if (value === "counts") {
        if (counts) {
          usageFailure("unresolved counts may be supplied only once.");
        }
        counts = true;
      } else if (value === "verbose") {
        if (verbose) {
          usageFailure("unresolved verbose may be supplied only once.");
        }
        verbose = true;
      } else if (value.startsWith("format=")) {
        if (hasFormat) {
          usageFailure("unresolved format may be supplied only once.");
        }
        format = parseTabularFormat(value.slice("format=".length), "unresolved");
        hasFormat = true;
      } else {
        usageFailure(`Unsupported unresolved argument: ${value}`);
      }
    }
    return { id: "unresolved", json, vaultPath, counts, totalOnly, verbose, format };
  }
  if (name === "orphans" || name === "deadends") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks ||
      values.some((value) => value !== "total") ||
      values.filter((value) => value === "total").length > 1
    ) {
      usageFailure(`${name} accepts only the optional total flag.`);
    }
    return { id: name, json, vaultPath, totalOnly: values.includes("total") };
  }
  if (name === "search" || name === "search:context") {
    if (content !== null || inline || destination !== null || renamedName !== null || updateLinks) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    let explicitQuery: string | null = null;
    const queryParts: string[] = [];
    let parameterFolder: string | null = null;
    let parameterLimit: number | null = null;
    let format: CliSearchFormat = "text";
    let hasFormat = false;
    let totalOnly = false;
    let caseSensitive = false;
    for (const value of values) {
      if (value.startsWith("query=")) {
        if (explicitQuery !== null) {
          usageFailure(`${name} query may be supplied only once.`);
        }
        explicitQuery = value.slice("query=".length);
      } else if (value.startsWith("path=")) {
        if (parameterFolder !== null) {
          usageFailure(`${name} path may be supplied only once.`);
        }
        parameterFolder = value.slice("path=".length);
        if (!parameterFolder) {
          usageFailure(`${name} path requires a folder.`);
        }
      } else if (value.startsWith("limit=")) {
        if (parameterLimit !== null) {
          usageFailure(`${name} limit may be supplied only once.`);
        }
        parameterLimit = parsePositiveInteger(value.slice("limit=".length), "limit");
      } else if (value.startsWith("format=")) {
        if (hasFormat) {
          usageFailure(`${name} format may be supplied only once.`);
        }
        const requestedFormat = value.slice("format=".length);
        if (requestedFormat !== "text" && requestedFormat !== "json") {
          usageFailure(`${name} format must be text or json.`);
        }
        format = requestedFormat;
        hasFormat = true;
      } else if (value === "total") {
        if (name !== "search") {
          usageFailure("search:context does not accept total.");
        }
        if (totalOnly) {
          usageFailure("search total may be supplied only once.");
        }
        totalOnly = true;
      } else if (value === "case") {
        if (caseSensitive) {
          usageFailure(`${name} case may be supplied only once.`);
        }
        caseSensitive = true;
      } else if (!value.includes("=")) {
        queryParts.push(value);
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (directory !== null && parameterFolder !== null) {
      usageFailure(`${name} path may be supplied as --directory or path=, not both.`);
    }
    if (limit !== null && parameterLimit !== null) {
      usageFailure(`${name} limit may be supplied as --limit or limit=, not both.`);
    }
    const query = [explicitQuery ?? "", ...queryParts].join(" ").trim();
    if (!query) {
      usageFailure(`${name} requires query=<text>.`);
    }
    const requestedLimit = limit ?? parameterLimit ?? 50;
    if (requestedLimit > maxSearchResults) {
      usageFailure(`search limits may not exceed ${maxSearchResults}.`);
    }
    return {
      id: name === "search" ? "search" : "search.context",
      json,
      vaultPath,
      query,
      folder: directory ?? parameterFolder ?? "",
      limit: requestedLimit,
      format,
      totalOnly,
      caseSensitive,
    };
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
    let templatePath: string | null = null;
    let dateFormat = createDefaultVaultNoteWorkflowSettings().templateDateFormat;
    let timeFormat = createDefaultVaultNoteWorkflowSettings().templateTimeFormat;
    let dateFormatSet = false;
    let timeFormatSet = false;
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
      } else if (value.startsWith("template=")) {
        if (templatePath !== null) {
          usageFailure("create template may be supplied only once.");
        }
        templatePath = pathArgument(() =>
          normalizeNoteWorkflowFile(value.slice("template=".length), "Create template"),
        );
      } else if (value.startsWith("date-format=")) {
        if (dateFormatSet) {
          usageFailure("create date-format may be supplied only once.");
        }
        dateFormat = parseMomentFormat(value.slice("date-format=".length), "create date-format");
        dateFormatSet = true;
      } else if (value.startsWith("time-format=")) {
        if (timeFormatSet) {
          usageFailure("create time-format may be supplied only once.");
        }
        timeFormat = parseMomentFormat(value.slice("time-format=".length), "create time-format");
        timeFormatSet = true;
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
    if (templatePath !== null && (content !== null || parameterContent !== null)) {
      usageFailure("create accepts template or content, not both.");
    }
    return {
      id: "create",
      json,
      vaultPath,
      filePath,
      content: decodeContentEscapes(content ?? parameterContent ?? ""),
      templatePath,
      dateFormat,
      timeFormat,
    };
  }
  if (name === "daily") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure("daily received an option that it does not accept.");
    }
    const defaults = createDefaultVaultNoteWorkflowSettings();
    let folder = defaults.dailyNoteFolder;
    let format = defaults.dailyNoteDateFormat;
    let templatePath: string | null = defaults.dailyNoteTemplate;
    let dateFormat = defaults.templateDateFormat;
    let timeFormat = defaults.templateTimeFormat;
    const seen = new Set<string>();
    for (const value of values) {
      const separator = value.indexOf("=");
      if (separator <= 0) {
        usageFailure(`Unsupported daily argument: ${value}`);
      }
      const key = value.slice(0, separator);
      const argument = value.slice(separator + 1);
      if (seen.has(key)) {
        usageFailure(`daily ${key} may be supplied only once.`);
      }
      seen.add(key);
      if (key === "folder") {
        folder = pathArgument(() => normalizeNoteWorkflowFolder(argument, "Daily folder"));
      } else if (key === "format") {
        format = parseMomentFormat(argument, "daily format");
      } else if (key === "template") {
        templatePath = pathArgument(() => normalizeNoteWorkflowFile(argument, "Daily template"));
      } else if (key === "date-format") {
        dateFormat = parseMomentFormat(argument, "daily date-format");
      } else if (key === "time-format") {
        timeFormat = parseMomentFormat(argument, "daily time-format");
      } else {
        usageFailure(`Unsupported daily argument: ${value}`);
      }
    }
    return {
      id: "daily",
      json,
      vaultPath,
      folder,
      format,
      templatePath,
      dateFormat,
      timeFormat,
    };
  }
  if (name === "daily:path" || name === "daily:read") {
    if (
      directory !== null ||
      limit !== null ||
      content !== null ||
      inline ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    const defaults = createDefaultVaultNoteWorkflowSettings();
    let folder = defaults.dailyNoteFolder;
    let format = defaults.dailyNoteDateFormat;
    let folderSet = false;
    let formatSet = false;
    for (const value of values) {
      if (value.startsWith("folder=")) {
        if (folderSet) {
          usageFailure(`${name} folder may be supplied only once.`);
        }
        folder = pathArgument(() =>
          normalizeNoteWorkflowFolder(value.slice("folder=".length), `${name} folder`),
        );
        folderSet = true;
      } else if (value.startsWith("format=")) {
        if (formatSet) {
          usageFailure(`${name} format may be supplied only once.`);
        }
        format = parseMomentFormat(value.slice("format=".length), `${name} format`);
        formatSet = true;
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    return {
      id: name === "daily:path" ? "daily.path" : "daily.read",
      json,
      vaultPath,
      folder,
      format,
    };
  }
  if (name === "daily:append" || name === "daily:prepend") {
    if (
      directory !== null ||
      limit !== null ||
      destination !== null ||
      renamedName !== null ||
      updateLinks
    ) {
      usageFailure(`${name} received an option that it does not accept.`);
    }
    const defaults = createDefaultVaultNoteWorkflowSettings();
    let folder = defaults.dailyNoteFolder;
    let format = defaults.dailyNoteDateFormat;
    let parameterContent: string | null = null;
    let folderSet = false;
    let formatSet = false;
    let inlineFlag = inline;
    for (const value of values) {
      if (value.startsWith("folder=")) {
        if (folderSet) {
          usageFailure(`${name} folder may be supplied only once.`);
        }
        folder = pathArgument(() =>
          normalizeNoteWorkflowFolder(value.slice("folder=".length), `${name} folder`),
        );
        folderSet = true;
      } else if (value.startsWith("format=")) {
        if (formatSet) {
          usageFailure(`${name} format may be supplied only once.`);
        }
        format = parseMomentFormat(value.slice("format=".length), `${name} format`);
        formatSet = true;
      } else if (value.startsWith("content=")) {
        if (parameterContent !== null) {
          usageFailure(`${name} content may be supplied only once.`);
        }
        parameterContent = value.slice("content=".length);
      } else if (value === "inline") {
        if (inlineFlag) {
          usageFailure(`${name} inline may be supplied only once.`);
        }
        inlineFlag = true;
      } else {
        usageFailure(`Unsupported ${name} argument: ${value}`);
      }
    }
    if (content !== null && parameterContent !== null) {
      usageFailure(`${name} content may be supplied as an option or parameter, not both.`);
    }
    const decodedContent = decodeContentEscapes(content ?? parameterContent ?? "");
    if (!decodedContent) {
      usageFailure(`${name} requires non-empty content.`);
    }
    return {
      id: name === "daily:append" ? "daily.append" : "daily.prepend",
      json,
      vaultPath,
      folder,
      format,
      content: decodedContent,
      inline: inlineFlag,
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
  threadleaf --vault <path> [--json] file <vault-file>
  threadleaf --vault <path> [--json] files [folder=<path>] [ext=<extension>] [total]
  threadleaf --vault <path> [--json] folder path=<path> [info=files|folders|size]
  threadleaf --vault <path> [--json] folders [folder=<path>] [total]
  threadleaf --vault <path> [--json] wordcount <note.md> [words|characters]
  threadleaf --vault <path> [--json] read <note.md>
  threadleaf --vault <path> [--json] search query=<text> [path=<folder>] [limit=<n>] [format=text|json] [total] [case]
  threadleaf --vault <path> [--json] search:context query=<text> [path=<folder>] [limit=<n>] [format=text|json] [case]
  threadleaf --vault <path> [--json] links <note.md> [total]
  threadleaf --vault <path> [--json] backlinks <note.md> [counts] [total] [format=json|tsv|csv]
  threadleaf --vault <path> [--json] unresolved [counts] [total] [verbose] [format=json|tsv|csv]
  threadleaf --vault <path> [--json] orphans [total]
  threadleaf --vault <path> [--json] deadends [total]
  threadleaf --vault <path> [--json] outline <note.md> [format=tree|md|json] [total]
  threadleaf --vault <path> [--json] create <note> [--content <text> | template=<note.md>] [date-format=<format>] [time-format=<format>]
  threadleaf --vault <path> [--json] daily [folder=<path>] [format=<format>] [template=<note.md>] [date-format=<format>] [time-format=<format>]
  threadleaf --vault <path> [--json] daily:path [folder=<path>] [format=<format>]
  threadleaf --vault <path> [--json] daily:read [folder=<path>] [format=<format>]
  threadleaf --vault <path> [--json] daily:append [folder=<path>] [format=<format>] content=<text> [inline]
  threadleaf --vault <path> [--json] daily:prepend [folder=<path>] [format=<format>] content=<text> [inline]
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
  threadleaf --vault <path> [--json] templates [folder=<path>] [total]
  threadleaf --vault <path> [--json] template:read name=<template> [folder=<path>] [title=<title>] [resolve]
  threadleaf --vault <path> [--json] random:read [folder=<path>]
  threadleaf --vault <path> [--json] plugins [filter=community] [versions] [format=json|tsv|csv]
  threadleaf --vault <path> [--json] plugin id=<plugin-id>
  threadleaf --vault <path> [--json] themes [versions]
  threadleaf --vault <path> [--json] theme name=<theme-name>
  threadleaf --vault <path> [--json] snippets

Compatibility spellings:
  threadleaf --vault <path> file file=<name>
  threadleaf --vault <path> files folder=<path> ext=<extension> total
  threadleaf --vault <path> folder path=<path> info=size
  threadleaf --vault <path> folders folder=<path> total
  threadleaf --vault <path> wordcount file=<note-name> words
  threadleaf --vault <path> read file=<note-name>
  threadleaf --vault <path> search query=<text> path=<folder> limit=<n> total case
  threadleaf --vault <path> search:context query=<text> format=json
  threadleaf --vault <path> links path=<note.md> total
  threadleaf --vault <path> backlinks file=<note-name> counts format=csv
  threadleaf --vault <path> unresolved counts verbose format=json
  threadleaf --vault <path> outline path=<note.md> format=md
  threadleaf --vault <path> create path=<note> [content=<text> | template=<note.md>]
  threadleaf --vault <path> daily folder=Journal format=YYYY/MMMM/YYYY-MM-DD template=Templates/Daily.md
  threadleaf --vault <path> daily:path folder=Journal format=YYYY/MMMM/YYYY-MM-DD
  threadleaf --vault <path> daily:read folder=Journal format=YYYY/MMMM/YYYY-MM-DD
  threadleaf --vault <path> daily:append folder=Journal format=YYYY/MMMM/YYYY-MM-DD content=<text>
  threadleaf --vault <path> daily:prepend folder=Journal format=YYYY/MMMM/YYYY-MM-DD content=<text>
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
  threadleaf --vault <path> templates folder=<path> total
  threadleaf --vault <path> template:read name=<template> title=<title> resolve
  threadleaf --vault <path> random:read folder=<path>
  threadleaf --vault <path> plugins filter=community versions format=csv
  threadleaf --vault <path> plugin id=<plugin-id>
  threadleaf --vault <path> themes versions
  threadleaf --vault <path> theme name=<theme-name>
  threadleaf --vault <path> snippets

Target rules:
  Positional note targets and path= are exact vault-relative paths.
  file= resolves one case-insensitive NFC-normalized Markdown basename; .md is optional.
  Missing and duplicate file= matches fail explicitly instead of choosing a note.
  The file info command uses the same rule across every visible vault file type.

Commands are headless and never require a running Electron process.
Plugin, theme, and snippet catalogs never execute code or expose private application selections.
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
    const normalizedPath = normalizeMarkdownNotePath(requestedPath);
    if (!(await vault.listMarkdownPaths()).includes(normalizedPath)) {
      throw new Error(`Markdown note is not indexed in this vault: ${normalizedPath}`);
    }
    return normalizedPath;
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

function visibleFileLookupKey(rawTarget: string): { key: string; includesExtension: boolean } {
  const portableTarget = rawTarget.replaceAll("\\", "/");
  const basename = path.posix.basename(portableTarget).normalize("NFC");
  const extension = path.posix.extname(basename);
  return {
    key: basename.toLocaleLowerCase("en-US"),
    includesExtension: extension.length > 0,
  };
}

async function resolveCliVisibleFileTarget(
  kernel: VaultKernel,
  requestedPath: string,
  targetKind: CliTargetKind,
): Promise<string> {
  const inventory = await kernel.listVisiblePaths();
  if (targetKind === "path") {
    const normalizedPath = normalizeVaultPath(requestedPath);
    if (!inventory.files.includes(normalizedPath)) {
      throw new Error(`Vault file is not visible in this vault: ${normalizedPath}`);
    }
    return normalizedPath;
  }
  if (
    requestedPath.length > 4096 ||
    requestedPath.includes("\0") ||
    requestedPath.endsWith("/") ||
    requestedPath.endsWith("\\")
  ) {
    throw new Error(`Invalid file= target name: ${requestedPath}`);
  }
  const requested = visibleFileLookupKey(requestedPath);
  if (!requested.key) {
    throw new Error("file= requires a non-empty vault file name.");
  }
  const matches = inventory.files.filter((candidatePath) => {
    const candidateBasename = path.posix.basename(candidatePath).normalize("NFC");
    const candidateExtension = path.posix.extname(candidateBasename);
    const candidate = requested.includesExtension
      ? candidateBasename
      : candidateBasename.slice(0, candidateBasename.length - candidateExtension.length);
    return candidate.toLocaleLowerCase("en-US") === requested.key;
  });
  if (matches.length === 0) {
    throw new Error(`No vault file matches file=${requestedPath}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous file=${requestedPath}. Matches: ${matches.join(", ")}`);
  }
  return matches[0] as string;
}

async function visibleFileInfo(kernel: VaultKernel, filePath: string) {
  const absolutePath = await kernel.paths.resolveForRead(filePath);
  const stat = await fs.stat(absolutePath);
  const basename = path.posix.basename(filePath);
  const extension = path.posix.extname(basename);
  return {
    path: filePath,
    name: extension ? basename.slice(0, -extension.length) : basename,
    extension: extension.replace(/^\./, ""),
    size: stat.size,
    created: Math.trunc(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs),
    modified: Math.trunc(stat.mtimeMs),
  };
}

function countSourceText(content: string): { words: number; characters: number } {
  const source = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(source)].filter(
    (segment) => segment.isWordLike,
  ).length;
  const characters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source)]
    .length;
  return { words, characters };
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
  const byTarget = new Map<
    string,
    { target: string; count: number; sources: Set<string>; statuses: Set<string> }
  >();
  for (const link of links) {
    const target = `${link.target}${link.subpath ?? ""}`;
    const current = byTarget.get(target) ?? {
      target,
      count: 0,
      sources: new Set<string>(),
      statuses: new Set<string>(),
    };
    current.count += 1;
    current.sources.add(link.sourcePath);
    current.statuses.add(link.resolution.status);
    byTarget.set(target, current);
  }
  const entries = [...byTarget.values()]
    .map((entry) => ({
      target: entry.target,
      count: entry.count,
      sources: [...entry.sources].sort((left, right) => left.localeCompare(right)),
      statuses: [...entry.statuses].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.target.localeCompare(right.target));
  return { total: entries.length, occurrences: links.length, entries, links };
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

async function requireVisibleFolder(
  kernel: VaultKernel,
  folder: string,
  label: string,
): Promise<string> {
  const normalizedFolder = normalizeVaultDirectoryPath(folder);
  const inventory = await kernel.listVisiblePaths(normalizedFolder);
  if (!inventory.exists) {
    throw new Error(`${label} is not visible in this vault: ${normalizedFolder || "."}`);
  }
  return normalizedFolder;
}

async function resolveCliTemplatePath(
  kernel: VaultKernel,
  folder: string,
  requestedPath: string,
  targetKind: CliTemplateReadCommand["templateTargetKind"],
): Promise<string> {
  const normalizedFolder = await requireVisibleFolder(kernel, folder, "Template folder");
  const templates = await listNoteTemplates(kernel, normalizedFolder);
  if (targetKind === "name" && !requestedPath.includes("/")) {
    const requestedName = path.posix.basename(requestedPath).toLocaleLowerCase("en-US");
    const matches = templates.filter((templatePath) => {
      const basename = path.posix.basename(templatePath).toLocaleLowerCase("en-US");
      return basename === requestedName;
    });
    if (matches.length === 0) {
      throw new Error(
        `No template named ${requestedPath} is present in ${normalizedFolder || "the vault root"}.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous template name ${requestedPath}. Matches: ${matches.join(", ")}`);
    }
    return matches[0] as string;
  }

  const candidate =
    normalizedFolder !== "" && !requestedPath.startsWith(`${normalizedFolder}/`)
      ? normalizeNoteWorkflowFile(`${normalizedFolder}/${requestedPath}`, "Template path")
      : normalizeNoteWorkflowFile(requestedPath, "Template path");
  if (!templates.includes(candidate)) {
    throw new Error(
      `Template is not present in ${normalizedFolder || "the vault root"}: ${candidate}`,
    );
  }
  return candidate;
}

function cliNow(options: CliRunOptions): Moment {
  return (options.now ?? moment()).clone();
}

function selectRandomNote(
  paths: readonly string[],
  selector: ((paths: readonly string[]) => number | string) | undefined,
): string {
  const selected = selector ? selector(paths) : Math.floor(Math.random() * paths.length);
  if (typeof selected === "number") {
    if (!Number.isInteger(selected) || selected < 0 || selected >= paths.length) {
      throw new Error("The random-note selector returned an invalid index.");
    }
    return paths[selected] as string;
  }
  if (typeof selected === "string" && paths.includes(selected)) {
    return selected;
  }
  throw new Error("The random-note selector returned a path outside the candidate set.");
}

function isCliMutationCommand(command: Exclude<ParsedCliCommand, CliHelpCommand>): boolean {
  return (
    command.id === "create" ||
    command.id === "daily" ||
    command.id === "daily.append" ||
    command.id === "daily.prepend" ||
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
      const content = command.templatePath
        ? (
            await renderNoteTemplate(kernel, command.templatePath, {
              title: noteTemplateTitle(command.filePath),
              now: cliNow(options),
              dateFormat: command.dateFormat,
              timeFormat: command.timeFormat,
            })
          ).content
        : command.content;
      const outcome = await createMarkdownNote(kernel, command.filePath, content);
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
    if (command.id === "daily") {
      const result = await openOrCreateDailyNote(
        kernel,
        {
          ...createDefaultVaultNoteWorkflowSettings(),
          dailyNoteFolder: command.folder,
          dailyNoteDateFormat: command.format,
          dailyNoteTemplate: command.templatePath,
          templateDateFormat: command.dateFormat,
          templateTimeFormat: command.timeFormat,
        },
        cliNow(options),
      );
      if (result.outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `Today's daily note appeared during creation. The proposed note was preserved as ${result.outcome.conflictPath}.`,
          { details: result },
        );
      }
      return result;
    }
    if (command.id === "daily.path") {
      return { path: dailyNotePath(command.folder, command.format, cliNow(options)) };
    }
    if (command.id === "daily.read") {
      const filePath = dailyNotePath(command.folder, command.format, cliNow(options));
      return await kernel.readText(filePath);
    }
    if (command.id === "daily.append" || command.id === "daily.prepend") {
      const filePath = dailyNotePath(command.folder, command.format, cliNow(options));
      const outcome = await mutateMarkdownNoteText(
        kernel,
        filePath,
        command.content,
        command.id === "daily.append" ? "append" : "prepend",
        command.inline,
      );
      if (outcome.status === "conflict") {
        throw new CliFailure(
          "CONFLICT",
          cliExitCodes.conflict,
          `The note changed during ${command.id === "daily.append" ? "append" : "prepend"}. The proposed version was preserved as ${outcome.conflictPath}.`,
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
    if (command.id === "file") {
      const filePath = await resolveCliVisibleFileTarget(
        kernel,
        command.filePath,
        command.targetKind,
      );
      return visibleFileInfo(kernel, filePath);
    }
    if (command.id === "files") {
      const inventory = await kernel.listVisiblePaths(command.folder);
      const files = command.extension
        ? inventory.files.filter(
            (filePath) =>
              path.posix
                .extname(filePath)
                .replace(/^\./, "")
                .normalize("NFC")
                .toLocaleLowerCase("en-US") === command.extension,
          )
        : inventory.files;
      return {
        folder: inventory.directory,
        extension: command.extension,
        total: files.length,
        files,
      };
    }
    if (command.id === "folders") {
      const inventory = await kernel.listVisiblePaths(command.folder);
      return {
        folder: inventory.directory,
        total: inventory.folders.length,
        folders: inventory.folders,
      };
    }
    if (command.id === "folder") {
      const folder = normalizeVaultDirectoryPath(command.folder);
      const inventory = await kernel.listVisiblePaths(folder);
      if (!inventory.exists) {
        throw new Error(`Vault folder is not visible in this vault: ${folder}`);
      }
      const sizes = await Promise.all(
        inventory.files.map(async (filePath) => {
          const absolutePath = await kernel.paths.resolveForRead(filePath);
          return (await fs.stat(absolutePath)).size;
        }),
      );
      return {
        path: folder,
        files: inventory.files.length,
        folders: inventory.folders.length,
        size: sizes.reduce((total, size) => total + size, 0),
      };
    }
    if (command.id === "wordcount") {
      const filePath = await resolveCliMarkdownTarget(kernel, command.filePath, command.targetKind);
      const snapshot = await kernel.readText(filePath);
      return { path: filePath, ...countSourceText(snapshot.content) };
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
    if (command.id === "templates") {
      const folder = await requireVisibleFolder(kernel, command.folder, "Template folder");
      const templates = await listNoteTemplates(kernel, folder);
      return { folder, total: templates.length, templates };
    }
    if (command.id === "template.read") {
      const templatePath = await resolveCliTemplatePath(
        kernel,
        command.folder,
        command.templatePath,
        command.templateTargetKind,
      );
      const title = command.title ?? noteTemplateTitle(templatePath);
      if (!command.resolve) {
        const template = await loadNoteTemplate(kernel, templatePath);
        return {
          path: template.path,
          title: command.title,
          resolved: false,
          content: template.content,
          revision: template.revision,
          size: template.size,
        };
      }
      const rendered = await renderNoteTemplate(kernel, templatePath, {
        title,
        now: cliNow(options),
        dateFormat: createDefaultVaultNoteWorkflowSettings().templateDateFormat,
        timeFormat: createDefaultVaultNoteWorkflowSettings().templateTimeFormat,
      });
      return {
        path: rendered.sourcePath,
        title,
        resolved: true,
        content: rendered.content,
        revision: rendered.sourceRevision,
        size: rendered.size,
      };
    }
    if (command.id === "random.read") {
      const folder = await requireVisibleFolder(kernel, command.folder, "Random-note folder");
      const paths = await kernel.listMarkdownPaths(folder);
      if (paths.length === 0) {
        throw new Error(`No Markdown notes are available in ${folder || "the vault"}.`);
      }
      const selectedPath = selectRandomNote(paths, options.randomSelector);
      const note = await kernel.readText(selectedPath);
      return {
        path: selectedPath,
        folder,
        content: note.content,
        revision: note.revision,
        size: note.size,
      };
    }
    if (command.id === "trash.list") {
      return listTrashedMarkdownNotes(kernel);
    }
    if (command.id === "plugins") {
      return {
        filter: command.filter,
        ...(await readCommunityPluginCatalog(kernel.paths.rootPath)),
      };
    }
    if (command.id === "plugin") {
      const catalog = await readCommunityPluginCatalog(kernel.paths.rootPath);
      const plugin = catalog.plugins.find((candidate) => candidate.id === command.pluginId);
      if (!plugin) {
        throw new CliFailure(
          "VAULT",
          cliExitCodes.vault,
          `No discovered community plugin matches id=${command.pluginId}.`,
          {
            details: {
              sourceState: catalog.sourceState,
              diagnostics: catalog.diagnostics,
            },
          },
        );
      }
      return {
        sourceState: catalog.sourceState,
        diagnostics: catalog.diagnostics,
        plugin,
      };
    }
    if (command.id === "themes" || command.id === "theme" || command.id === "snippets") {
      const catalog = await readAppearanceCatalog(kernel.paths.rootPath, kernel.vaultId);
      if (command.id === "themes") {
        return {
          sourceState: catalog.themeSourceState,
          diagnostics: catalog.themeDiagnostics,
          total: catalog.themes.length,
          themes: catalog.themes,
        };
      }
      if (command.id === "snippets") {
        return {
          sourceState: catalog.snippetSourceState,
          diagnostics: catalog.snippetDiagnostics,
          total: catalog.snippets.length,
          snippets: catalog.snippets,
        };
      }
      const themeName = catalogLookupKey(command.themeName);
      const matches = catalog.themes.filter((theme) => catalogLookupKey(theme.name) === themeName);
      if (matches.length === 0) {
        throw new CliFailure(
          "VAULT",
          cliExitCodes.vault,
          `No discovered community theme matches name=${command.themeName}.`,
          {
            details: {
              sourceState: catalog.themeSourceState,
              diagnostics: catalog.themeDiagnostics,
            },
          },
        );
      }
      if (matches.length > 1) {
        throw new CliFailure(
          "VAULT",
          cliExitCodes.vault,
          `Theme name is ambiguous: ${command.themeName}.`,
          { details: { matches } },
        );
      }
      return {
        sourceState: catalog.themeSourceState,
        diagnostics: catalog.themeDiagnostics,
        theme: matches[0],
      };
    }

    const index = await MetadataIndex.build(kernel);
    if (command.id === "search" || command.id === "search.context") {
      const folder = normalizeVaultDirectoryPath(command.folder);
      const page = index.search(command.query, command.limit, {
        caseSensitive: command.caseSensitive,
        folder,
        maxContexts: command.id === "search.context" ? 100 : 3,
      });
      return {
        ...page,
        folder,
        caseSensitive: command.caseSensitive,
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

function compatibilityJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tabularRows(rows: Array<Array<string | number>>, format: "tsv" | "csv"): string {
  if (rows.length === 0) {
    return "";
  }
  const separator = format === "csv" ? "," : "\t";
  return `${rows
    .map((row) =>
      row.map((value) => (format === "csv" ? csvField(value) : String(value))).join(separator),
    )
    .join("\n")}\n`;
}

function catalogSourceMessage(label: string, sourceState: "present" | "missing" | "unreadable") {
  if (sourceState === "missing") {
    return `No ${label} catalog source was found.\n`;
  }
  if (sourceState === "unreadable") {
    return `${label} catalog source could not be inspected.\n`;
  }
  return null;
}

function catalogDiagnosticSuffix(diagnostics: number): string {
  return diagnostics > 0
    ? `Catalog diagnostics: ${diagnostics}. Details are withheld from CLI output.\n`
    : "";
}

function humanOutput(command: ParsedCliCommand, data: unknown): string {
  if (command.id === "help") {
    return cliHelp;
  }
  if (command.id === "read") {
    return (data as { content: string }).content;
  }
  if (command.id === "daily.read" || command.id === "template.read") {
    return (data as { content: string }).content;
  }
  if (command.id === "daily.path") {
    return `${(data as { path: string }).path}\n`;
  }
  if (command.id === "random.read") {
    const result = data as { path: string; content: string };
    return `Path: ${result.path}\n\n${result.content}`;
  }
  if (command.id === "templates") {
    const result = data as { total: number; templates: string[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    return result.templates.length > 0 ? `${result.templates.join("\n")}\n` : "No templates.\n";
  }
  if (command.id === "plugins") {
    const result = data as CliPluginCatalog & { filter: "community" };
    if (command.format === "json") {
      return compatibilityJson(result);
    }
    const sourceMessage = catalogSourceMessage("community plugin", result.sourceState);
    if (sourceMessage) {
      return `${sourceMessage}${catalogDiagnosticSuffix(result.diagnostics)}`;
    }
    if (result.plugins.length === 0) {
      return `No community plugins.\n${catalogDiagnosticSuffix(result.diagnostics)}`;
    }
    return `${tabularRows(
      result.plugins.map((plugin) => [
        plugin.id,
        plugin.name,
        ...(command.versions ? [plugin.version] : []),
        plugin.state,
      ]),
      command.format,
    )}${catalogDiagnosticSuffix(result.diagnostics)}`;
  }
  if (command.id === "plugin") {
    const result = data as {
      sourceState: "present" | "missing" | "unreadable";
      diagnostics: number;
      plugin: CliPluginCatalogEntry;
    };
    return [
      `Plugin: ${result.plugin.id}`,
      `Name: ${result.plugin.name}`,
      `Version: ${result.plugin.version}`,
      `Package state: ${result.plugin.state}`,
      `Stylesheet: ${result.plugin.stylesheetDiscovered ? "present" : "absent"}`,
      `Compatibility evidence: level ${result.plugin.compatibilityLevel} (${result.plugin.compatibilityStatus})`,
      "",
    ].join("\n");
  }
  if (command.id === "themes") {
    const result = data as {
      sourceState: "present" | "missing" | "unreadable";
      diagnostics: number;
      total: number;
      themes: CliThemeCatalogEntry[];
    };
    const sourceMessage = catalogSourceMessage("community theme", result.sourceState);
    if (sourceMessage) {
      return `${sourceMessage}${catalogDiagnosticSuffix(result.diagnostics)}`;
    }
    if (result.themes.length === 0) {
      return `No community themes.\n${catalogDiagnosticSuffix(result.diagnostics)}`;
    }
    return `${result.themes
      .map((theme) =>
        command.versions ? `${theme.name}\t${theme.version ?? "unknown"}` : theme.name,
      )
      .join("\n")}\n${catalogDiagnosticSuffix(result.diagnostics)}`;
  }
  if (command.id === "theme") {
    const result = data as {
      sourceState: "present" | "missing" | "unreadable";
      diagnostics: number;
      theme: CliThemeCatalogEntry;
    };
    return [
      `Theme: ${result.theme.name}`,
      `ID: ${result.theme.id}`,
      `Version: ${result.theme.version ?? "unknown"}`,
      "",
    ].join("\n");
  }
  if (command.id === "snippets") {
    const result = data as {
      sourceState: "present" | "missing" | "unreadable";
      diagnostics: number;
      total: number;
      snippets: CliSnippetCatalogEntry[];
    };
    const sourceMessage = catalogSourceMessage("CSS snippet", result.sourceState);
    if (sourceMessage) {
      return `${sourceMessage}${catalogDiagnosticSuffix(result.diagnostics)}`;
    }
    if (result.snippets.length === 0) {
      return `No CSS snippets.\n${catalogDiagnosticSuffix(result.diagnostics)}`;
    }
    return `${result.snippets.map((snippet) => snippet.name).join("\n")}\n${catalogDiagnosticSuffix(
      result.diagnostics,
    )}`;
  }
  if (command.id === "file") {
    const result = data as {
      path: string;
      name: string;
      extension: string;
      size: number;
      created: number;
      modified: number;
    };
    return `path\t${result.path}\nname\t${result.name}\nextension\t${result.extension}\nsize\t${result.size}\ncreated\t${result.created}\nmodified\t${result.modified}\n`;
  }
  if (command.id === "files") {
    const result = data as { total: number; files: string[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    return result.files.length > 0 ? `${result.files.join("\n")}\n` : "No vault files.\n";
  }
  if (command.id === "folders") {
    const result = data as { total: number; folders: string[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    return result.folders.length > 0 ? `${result.folders.join("\n")}\n` : "No vault folders.\n";
  }
  if (command.id === "folder") {
    const result = data as { path: string; files: number; folders: number; size: number };
    if (command.info !== null) {
      return `${result[command.info]}\n`;
    }
    return `path\t${result.path}\nfiles\t${result.files}\nfolders\t${result.folders}\nsize\t${result.size}\n`;
  }
  if (command.id === "wordcount") {
    const result = data as { path: string; words: number; characters: number };
    if (command.valueOnly !== null) {
      return `${result[command.valueOnly]}\n`;
    }
    return `path\t${result.path}\nwords\t${result.words}\ncharacters\t${result.characters}\n`;
  }
  if (command.id === "search" || command.id === "search.context") {
    const result = data as {
      total: number;
      results: Array<{
        path: string;
        contexts: Array<{ kind: string; text: string; line?: number }>;
      }>;
    };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (command.id === "search") {
      const paths = result.results.map((entry) => entry.path);
      return command.format === "json"
        ? compatibilityJson(paths)
        : paths.length > 0
          ? `${paths.join("\n")}\n`
          : "";
    }
    const matches = result.results.flatMap<{
      path: string;
      line: number | null;
      text: string | null;
    }>((entry) => {
      const contexts = entry.contexts.filter(
        (context): context is { kind: string; text: string; line: number } =>
          context.kind === "content" && context.line !== undefined,
      );
      return contexts.length > 0
        ? contexts.map((context) => ({ path: entry.path, line: context.line, text: context.text }))
        : [{ path: entry.path, line: null, text: null }];
    });
    if (command.format === "json") {
      return compatibilityJson(matches);
    }
    return matches.length > 0
      ? `${matches
          .map((match) =>
            match.line === null ? match.path : `${match.path}:${match.line}: ${match.text}`,
          )
          .join("\n")}\n`
      : "";
  }
  if (command.id === "links") {
    const result = data as { total: number; links: LinkMetadata[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    const targets = result.links.map((link) => `${link.target}${link.subpath ?? ""}`);
    return targets.length > 0 ? `${targets.join("\n")}\n` : "";
  }
  if (command.id === "backlinks") {
    const result = data as {
      total: number;
      backlinks: Array<{ path: string; count: number }>;
    };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (command.format === "json") {
      return compatibilityJson(
        command.counts ? result.backlinks : result.backlinks.map((backlink) => backlink.path),
      );
    }
    return tabularRows(
      result.backlinks.map((backlink) =>
        command.counts ? [backlink.path, backlink.count] : [backlink.path],
      ),
      command.format,
    );
  }
  if (command.id === "unresolved") {
    const result = data as {
      total: number;
      entries: Array<{ target: string; count: number; sources: string[] }>;
    };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (command.format === "json") {
      return compatibilityJson(
        command.counts || command.verbose
          ? result.entries.map((entry) => ({
              target: entry.target,
              ...(command.counts ? { count: entry.count } : {}),
              ...(command.verbose ? { sources: entry.sources } : {}),
            }))
          : result.entries.map((entry) => entry.target),
      );
    }
    return tabularRows(
      result.entries.map((entry) => [
        entry.target,
        ...(command.counts ? [entry.count] : []),
        ...(command.verbose ? [entry.sources.join(", ")] : []),
      ]),
      command.format,
    );
  }
  if (command.id === "orphans" || command.id === "deadends") {
    const result = data as { total: number; files: string[] };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    return result.files.length > 0 ? `${result.files.join("\n")}\n` : "";
  }
  if (command.id === "outline") {
    const result = data as {
      total: number;
      headings: Array<{ level: number; text: string; line: number }>;
    };
    if (command.totalOnly) {
      return `${result.total}\n`;
    }
    if (command.format === "json") {
      return compatibilityJson(result.headings);
    }
    const headings = result.headings.map((heading) =>
      command.format === "md"
        ? `${"#".repeat(heading.level)} ${heading.text}`
        : `${"  ".repeat(Math.max(0, heading.level - 1))}${heading.text}`,
    );
    return headings.length > 0 ? `${headings.join("\n")}\n` : "";
  }
  if (command.id === "create") {
    return `Created ${(data as { path: string }).path}\n`;
  }
  if (command.id === "daily") {
    const result = data as {
      path: string;
      outcome: { status: "committed" | "exists" };
    };
    return `${result.outcome.status === "committed" ? "Created" : "Opened"} ${result.path}\n`;
  }
  if (command.id === "append" || command.id === "daily.append") {
    return `Appended ${(data as { path: string }).path}\n`;
  }
  if (command.id === "prepend" || command.id === "daily.prepend") {
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
