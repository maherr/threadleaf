/**
 * Static command metadata shared by CLI help and shell completion output.
 *
 * This module is intentionally data-only. It must remain safe to import from
 * the global help and completion paths without opening a vault or loading a
 * plugin, theme, or renderer.
 */

export type CliShell = "bash" | "zsh" | "fish" | "powershell";

export type CliCommandId =
  | "help"
  | "completion"
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
  | "snippets"
  | "port.inspect"
  | "port.ci"
  | "port.scaffold";

export const cliShells: readonly CliShell[] = ["bash", "zsh", "fish", "powershell"];

export type CliGlobalOptionId =
  | "json"
  | "help"
  | "vault"
  | "directory"
  | "limit"
  | "content"
  | "inline"
  | "update-links"
  | "to"
  | "name"
  | "output"
  | "receipt";

export interface CliGlobalOptionSpec {
  id: CliGlobalOptionId;
  names: readonly string[];
  usage: string;
  takesValue: boolean;
  /** Whether an empty value is syntactically accepted for inline/spaced forms. */
  allowEmptyValue?: boolean;
}

export interface CliOptionToken {
  id: CliGlobalOptionId;
  /** The value after `--option=`, or null when the token is the bare option. */
  inlineValue: string | null;
}

export interface CliCommandSpec {
  id: CliCommandId;
  /** Every parser spelling, with the canonical spelling first. */
  names: readonly string[];
  /** Usage suffixes after the shared `threadleaf` prefix. */
  usage: readonly string[];
  requiresVault: boolean;
  /** Safe, static words to offer. Values are never read from a real vault. */
  completionWords: readonly string[];
  /** Optional spelling-specific words for aliases with a narrower grammar. */
  completionWordsByName?: Readonly<Record<string, readonly string[]>>;
  globalOptions: readonly CliGlobalOptionId[];
}

type CliCompletionValueRule =
  | "text"
  | "nonempty-text"
  | "query"
  | "path"
  | "optional-path"
  | "positive-integer"
  | "search-limit"
  | "extension"
  | "task-status"
  | "reference"
  | "plugin-id"
  | "property-name"
  | "tag-name";

interface CliCompletionGrammar {
  /** Number of free positional values accepted after the command; null is unbounded. */
  positionalMax: number | null;
  /** Group marked when a raw positional or positional static value is consumed. */
  positionalGroup?: string;
  /** Static groups that also consume one positional value. */
  positionalStaticGroups?: readonly string[];
  /** Exact bare tokens reserved by the parser but rejected for this spelling. */
  rejectedWords?: readonly string[];
  /** Candidate-token aliases that share one parser slot. */
  groupAliases?: Readonly<Record<string, string>>;
  /** Exact static words or key prefixes mapped to one parser argument slot. */
  argumentGroups?: Readonly<Record<string, string>>;
  /** Parser value rules for wildcard key=value patterns. */
  valueRules?: Readonly<Record<string, CliCompletionValueRule>>;
  /** Mutually exclusive static argument groups. */
  groupConflicts?: readonly (readonly [string, string])[];
  /** Static groups that conflict with global option ids. */
  optionConflicts?: readonly (readonly [string, CliGlobalOptionId])[];
  mode?: "help" | "completion";
}

export const cliGlobalOptions: readonly CliGlobalOptionSpec[] = [
  { id: "json", names: ["--json"], usage: "--json", takesValue: false },
  { id: "help", names: ["--help", "-h"], usage: "--help", takesValue: false },
  { id: "vault", names: ["--vault"], usage: "--vault <path>", takesValue: true },
  { id: "directory", names: ["--directory"], usage: "--directory <path>", takesValue: true },
  { id: "limit", names: ["--limit"], usage: "--limit <n>", takesValue: true },
  {
    id: "content",
    names: ["--content"],
    usage: "--content <text>",
    takesValue: true,
    allowEmptyValue: true,
  },
  { id: "inline", names: ["--inline"], usage: "--inline", takesValue: false },
  { id: "update-links", names: ["--update-links"], usage: "--update-links", takesValue: false },
  { id: "to", names: ["--to"], usage: "--to <path>", takesValue: true },
  { id: "name", names: ["--name"], usage: "--name <name>", takesValue: true },
  { id: "output", names: ["--output"], usage: "--output <path>", takesValue: true },
  { id: "receipt", names: ["--receipt"], usage: "--receipt <path>", takesValue: true },
];

/** Resolve one parser token using the same option table used by completion. */
export function parseCliOptionToken(token: string): CliOptionToken | null {
  for (const option of cliGlobalOptions) {
    for (const name of option.names) {
      if (token === name) {
        return { id: option.id, inlineValue: null };
      }
      if (option.takesValue && name.startsWith("--") && token.startsWith(`${name}=`)) {
        return { id: option.id, inlineValue: token.slice(name.length + 1) };
      }
    }
  }
  return null;
}

const vaultOptions = ["vault", "json", "help"] as const;
const directoryOptions = ["vault", "directory", "json", "help"] as const;
const searchOptions = ["vault", "directory", "limit", "json", "help"] as const;
const contentOptions = ["vault", "content", "json", "help"] as const;
const inlineContentOptions = ["vault", "content", "inline", "json", "help"] as const;
const moveOptions = ["vault", "to", "update-links", "json", "help"] as const;
const renameOptions = ["vault", "name", "update-links", "json", "help"] as const;
const globalOptions = ["json", "help"] as const;
const portInspectOptions = ["receipt", "json", "help"] as const;
const portScaffoldOptions = ["output", "receipt", "json", "help"] as const;

export const cliCommandSpecs: readonly CliCommandSpec[] = [
  {
    id: "help",
    names: ["help"],
    usage: ["help [command]"],
    requiresVault: false,
    completionWords: ["completion"],
    globalOptions,
  },
  {
    id: "completion",
    names: ["completion"],
    usage: ["completion <bash|zsh|fish|powershell>"],
    requiresVault: false,
    completionWords: [...cliShells],
    globalOptions,
  },
  {
    id: "vault.info",
    names: ["vault", "vault:info"],
    usage: ["vault info", "vault info=<name|path|files|folders|size>"],
    requiresVault: true,
    completionWords: ["info", "info=name", "info=path", "info=files", "info=folders", "info=size"],
    globalOptions: vaultOptions,
  },
  {
    id: "file",
    names: ["file"],
    usage: ["file <vault-file>"],
    requiresVault: true,
    completionWords: ["file=", "path="],
    globalOptions: vaultOptions,
  },
  {
    id: "files",
    names: ["files"],
    usage: ["files [folder=<path>] [ext=<extension>] [total]"],
    requiresVault: true,
    completionWords: ["folder=", "ext=", "total"],
    globalOptions: directoryOptions,
  },
  {
    id: "folder",
    names: ["folder"],
    usage: ["folder path=<path> [info=files|folders|size]"],
    requiresVault: true,
    completionWords: ["path=", "info=files", "info=folders", "info=size"],
    globalOptions: vaultOptions,
  },
  {
    id: "folders",
    names: ["folders"],
    usage: ["folders [folder=<path>] [total]"],
    requiresVault: true,
    completionWords: ["folder=", "total"],
    globalOptions: vaultOptions,
  },
  {
    id: "wordcount",
    names: ["wordcount"],
    usage: ["wordcount <note.md> [words|characters]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "words", "characters"],
    globalOptions: vaultOptions,
  },
  {
    id: "read",
    names: ["read"],
    usage: ["read <note.md>"],
    requiresVault: true,
    completionWords: ["file=", "path="],
    globalOptions: vaultOptions,
  },
  {
    id: "search",
    names: ["search"],
    usage: ["search query=<text> [path=<folder>] [limit=<n>] [format=text|json] [total] [case]"],
    requiresVault: true,
    completionWords: ["query=", "path=", "limit=", "format=text", "format=json", "total", "case"],
    globalOptions: searchOptions,
  },
  {
    id: "search.context",
    names: ["search:context"],
    usage: ["search:context query=<text> [path=<folder>] [limit=<n>] [format=text|json] [case]"],
    requiresVault: true,
    completionWords: ["query=", "path=", "limit=", "format=text", "format=json", "case"],
    completionWordsByName: {
      "search:context": ["query=", "path=", "limit=", "format=text", "format=json", "case"],
    },
    globalOptions: searchOptions,
  },
  {
    id: "links",
    names: ["links"],
    usage: ["links <note.md> [total]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "total"],
    globalOptions: vaultOptions,
  },
  {
    id: "backlinks",
    names: ["backlinks"],
    usage: ["backlinks <note.md> [counts] [total] [format=json|tsv|csv]"],
    requiresVault: true,
    completionWords: [
      "file=",
      "path=",
      "counts",
      "total",
      "format=json",
      "format=tsv",
      "format=csv",
    ],
    globalOptions: vaultOptions,
  },
  {
    id: "unresolved",
    names: ["unresolved"],
    usage: ["unresolved [counts] [total] [verbose] [format=json|tsv|csv]"],
    requiresVault: true,
    completionWords: ["counts", "total", "verbose", "format=json", "format=tsv", "format=csv"],
    globalOptions: vaultOptions,
  },
  {
    id: "orphans",
    names: ["orphans"],
    usage: ["orphans [total]"],
    requiresVault: true,
    completionWords: ["total"],
    globalOptions: vaultOptions,
  },
  {
    id: "deadends",
    names: ["deadends"],
    usage: ["deadends [total]"],
    requiresVault: true,
    completionWords: ["total"],
    globalOptions: vaultOptions,
  },
  {
    id: "outline",
    names: ["outline"],
    usage: ["outline <note.md> [format=tree|md|json] [total]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "format=tree", "format=md", "format=json", "total"],
    globalOptions: vaultOptions,
  },
  {
    id: "create",
    names: ["create"],
    usage: [
      "create <note> [--content <text> | template=<note.md>] [date-format=<format>] [time-format=<format>] [overwrite]",
    ],
    requiresVault: true,
    completionWords: [
      "path=",
      "name=",
      "content=",
      "template=",
      "date-format=",
      "time-format=",
      "overwrite",
    ],
    globalOptions: contentOptions,
  },
  {
    id: "daily",
    names: ["daily"],
    usage: [
      "daily [folder=<path>] [format=<format>] [template=<note.md>] [date-format=<format>] [time-format=<format>]",
    ],
    requiresVault: true,
    completionWords: ["folder=", "format=", "template=", "date-format=", "time-format="],
    globalOptions: vaultOptions,
  },
  {
    id: "daily.path",
    names: ["daily:path"],
    usage: ["daily:path [folder=<path>] [format=<format>]"],
    requiresVault: true,
    completionWords: ["folder=", "format="],
    globalOptions: vaultOptions,
  },
  {
    id: "daily.read",
    names: ["daily:read"],
    usage: ["daily:read [folder=<path>] [format=<format>]"],
    requiresVault: true,
    completionWords: ["folder=", "format="],
    globalOptions: vaultOptions,
  },
  {
    id: "daily.append",
    names: ["daily:append"],
    usage: ["daily:append [folder=<path>] [format=<format>] content=<text> [inline]"],
    requiresVault: true,
    completionWords: ["folder=", "format=", "content=", "inline"],
    globalOptions: inlineContentOptions,
  },
  {
    id: "daily.prepend",
    names: ["daily:prepend"],
    usage: ["daily:prepend [folder=<path>] [format=<format>] content=<text> [inline]"],
    requiresVault: true,
    completionWords: ["folder=", "format=", "content=", "inline"],
    globalOptions: inlineContentOptions,
  },
  {
    id: "append",
    names: ["append"],
    usage: ["append <note> --content <text> [--inline]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "content=", "inline"],
    globalOptions: inlineContentOptions,
  },
  {
    id: "prepend",
    names: ["prepend"],
    usage: ["prepend <note> --content <text> [--inline]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "content=", "inline"],
    globalOptions: inlineContentOptions,
  },
  {
    id: "move",
    names: ["move"],
    usage: ["move <note> --to <path> [--update-links]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "to="],
    globalOptions: moveOptions,
  },
  {
    id: "rename",
    names: ["rename"],
    usage: ["rename <note> --name <filename> [--update-links]"],
    requiresVault: true,
    completionWords: ["file=", "path=", "name="],
    globalOptions: renameOptions,
  },
  {
    id: "delete",
    names: ["delete"],
    usage: ["delete <note>"],
    requiresVault: true,
    completionWords: ["file=", "path="],
    globalOptions: vaultOptions,
  },
  {
    id: "trash.list",
    names: ["trash", "trash:list"],
    usage: ["trash list"],
    requiresVault: true,
    completionWords: ["list"],
    globalOptions: vaultOptions,
  },
  {
    id: "restore",
    names: ["restore"],
    usage: ["restore <note>"],
    requiresVault: true,
    completionWords: ["file=", "path="],
    globalOptions: vaultOptions,
  },
  {
    id: "properties",
    names: ["properties"],
    usage: ["properties path=<note.md>"],
    requiresVault: true,
    completionWords: ["path=", "file="],
    globalOptions: vaultOptions,
  },
  {
    id: "property.read",
    names: ["property:read"],
    usage: ["property:read path=<note.md> name=<name>"],
    requiresVault: true,
    completionWords: ["path=", "file=", "name="],
    globalOptions: vaultOptions,
  },
  {
    id: "property.set",
    names: ["property:set"],
    usage: ["property:set path=<note.md> name=<name> value=<value> [type=<type>]"],
    requiresVault: true,
    completionWords: [
      "path=",
      "file=",
      "name=",
      "value=",
      "type=text",
      "type=list",
      "type=number",
      "type=checkbox",
      "type=date",
      "type=datetime",
    ],
    globalOptions: vaultOptions,
  },
  {
    id: "property.remove",
    names: ["property:remove"],
    usage: ["property:remove path=<note.md> name=<name>"],
    requiresVault: true,
    completionWords: ["path=", "file=", "name="],
    globalOptions: vaultOptions,
  },
  {
    id: "tasks",
    names: ["tasks"],
    usage: [
      "tasks [path=<note.md>] [done|todo|status=<char>] [daily] [total|verbose] [format=text|json|tsv|csv]",
    ],
    requiresVault: true,
    completionWords: [
      "path=",
      "file=",
      "done",
      "todo",
      "status=",
      "daily",
      "total",
      "verbose",
      "format=text",
      "format=json",
      "format=tsv",
      "format=csv",
    ],
    globalOptions: vaultOptions,
  },
  {
    id: "task",
    names: ["task"],
    usage: ["task ref=<note.md:line> [toggle|done|todo|status=<char>] or task daily line=<n>"],
    requiresVault: true,
    completionWords: [
      "ref=",
      "path=",
      "file=",
      "daily",
      "line=",
      "toggle",
      "done",
      "todo",
      "status=",
    ],
    globalOptions: vaultOptions,
  },
  {
    id: "aliases",
    names: ["aliases"],
    usage: ["aliases [path=<note.md>] [total|verbose]"],
    requiresVault: true,
    completionWords: ["path=", "file=", "total", "verbose"],
    globalOptions: vaultOptions,
  },
  {
    id: "tags",
    names: ["tags"],
    usage: ["tags [path=<note.md>] [sort=count] [total|counts] [format=text|json|tsv|csv]"],
    requiresVault: true,
    completionWords: [
      "path=",
      "file=",
      "sort=count",
      "total",
      "counts",
      "format=text",
      "format=json",
      "format=tsv",
      "format=csv",
    ],
    globalOptions: vaultOptions,
  },
  {
    id: "tag",
    names: ["tag"],
    usage: ["tag name=<tag> [total|verbose]"],
    requiresVault: true,
    completionWords: ["name=", "total", "verbose"],
    globalOptions: vaultOptions,
  },
  {
    id: "templates",
    names: ["templates"],
    usage: ["templates [folder=<path>] [total]"],
    requiresVault: true,
    completionWords: ["folder=", "total"],
    globalOptions: vaultOptions,
  },
  {
    id: "template.read",
    names: ["template:read"],
    usage: ["template:read name=<template> [folder=<path>] [title=<title>] [resolve]"],
    requiresVault: true,
    completionWords: ["name=", "path=", "folder=", "title=", "resolve"],
    globalOptions: vaultOptions,
  },
  {
    id: "random.read",
    names: ["random:read"],
    usage: ["random:read [folder=<path>]"],
    requiresVault: true,
    completionWords: ["folder="],
    globalOptions: vaultOptions,
  },
  {
    id: "plugins",
    names: ["plugins"],
    usage: ["plugins [filter=community] [versions] [format=json|tsv|csv]"],
    requiresVault: true,
    completionWords: ["filter=community", "versions", "format=json", "format=tsv", "format=csv"],
    globalOptions: vaultOptions,
  },
  {
    id: "plugin",
    names: ["plugin"],
    usage: ["plugin id=<plugin-id>"],
    requiresVault: true,
    completionWords: ["id="],
    globalOptions: vaultOptions,
  },
  {
    id: "themes",
    names: ["themes"],
    usage: ["themes [versions]"],
    requiresVault: true,
    completionWords: ["versions"],
    globalOptions: vaultOptions,
  },
  {
    id: "theme",
    names: ["theme"],
    usage: ["theme name=<theme-name>"],
    requiresVault: true,
    completionWords: ["name="],
    globalOptions: vaultOptions,
  },
  {
    id: "snippets",
    names: ["snippets"],
    usage: ["snippets"],
    requiresVault: true,
    completionWords: [],
    globalOptions: vaultOptions,
  },
  {
    id: "port.inspect",
    names: ["port:inspect"],
    usage: ["port inspect <unpacked-plugin-directory> [--receipt <receipt.json>]"],
    requiresVault: false,
    completionWords: ["path="],
    globalOptions: portInspectOptions,
  },
  {
    id: "port.ci",
    names: ["port:ci"],
    usage: ["port ci <unpacked-plugin-directory> [--receipt <receipt.json>]"],
    requiresVault: false,
    completionWords: ["path="],
    globalOptions: portInspectOptions,
  },
  {
    id: "port.scaffold",
    names: ["port:scaffold"],
    usage: [
      "port scaffold <native|compatibility> <unpacked-plugin-directory> --output <directory> [--receipt <receipt.json>]",
    ],
    requiresVault: false,
    completionWords: ["path=", "native", "compatibility"],
    globalOptions: portScaffoldOptions,
  },
];

const targetAliases = { "file=": "target", "path=": "target" } as const;
const createTargetAliases = { "name=": "target", "path=": "target" } as const;
const templateTargetAliases = { "name=": "target", "path=": "target" } as const;
const targetValueRules = { "file=": "path", "path=": "path" } as const;
const pathValueRules = { "path=": "path" } as const;
const portTargetAliases = { "path=": "target" } as const;
const portTargetValueRules = { "path=": "path" } as const;
const optionalFolderValueRules = { "folder=": "optional-path" } as const;

/**
 * The parser's positional/static grammar is deliberately total here. The
 * generated shells must fail compilation of this table when a new command is
 * added until its consumed groups and conflicts are specified.
 */
const completionGrammarById: Record<CliCommandId, CliCompletionGrammar> = {
  help: {
    positionalMax: 1,
    positionalGroup: "topic",
    positionalStaticGroups: ["topic"],
    mode: "help",
  },
  completion: {
    positionalMax: 1,
    positionalGroup: "shell",
    positionalStaticGroups: ["shell"],
    mode: "completion",
  },
  "vault.info": {
    positionalMax: 1,
    positionalGroup: "info",
    positionalStaticGroups: ["info"],
    argumentGroups: {
      info: "info",
      "info=name": "info",
      "info=path": "info",
      "info=files": "info",
      "info=folders": "info",
      "info=size": "info",
    },
  },
  file: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  files: {
    positionalMax: 0,
    argumentGroups: { "folder=": "folder", "ext=": "extension", total: "total" },
    valueRules: { "folder=": "path", "ext=": "extension" },
    optionConflicts: [["folder", "directory"]],
  },
  folder: {
    positionalMax: 1,
    positionalGroup: "target",
    argumentGroups: {
      "path=": "target",
      "info=files": "info",
      "info=folders": "info",
      "info=size": "info",
    },
    groupAliases: { "path=": "target" },
    valueRules: pathValueRules,
  },
  folders: {
    positionalMax: 0,
    argumentGroups: { "folder=": "folder", total: "total" },
    valueRules: { "folder=": "path" },
  },
  wordcount: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    argumentGroups: { words: "count", characters: "count" },
    valueRules: targetValueRules,
  },
  read: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  search: {
    positionalMax: null,
    argumentGroups: {
      "query=": "query",
      "path=": "path",
      "limit=": "limit",
      "format=text": "format",
      "format=json": "format",
      total: "total",
      case: "case",
    },
    optionConflicts: [
      ["path", "directory"],
      ["limit", "limit"],
    ],
    valueRules: { "query=": "query", "path=": "path", "limit=": "search-limit" },
  },
  "search.context": {
    positionalMax: null,
    rejectedWords: ["total"],
    argumentGroups: {
      "query=": "query",
      "path=": "path",
      "limit=": "limit",
      "format=text": "format",
      "format=json": "format",
      case: "case",
    },
    optionConflicts: [
      ["path", "directory"],
      ["limit", "limit"],
    ],
    valueRules: { "query=": "query", "path=": "path", "limit=": "search-limit" },
  },
  links: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  backlinks: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  unresolved: { positionalMax: 0 },
  orphans: { positionalMax: 0 },
  deadends: { positionalMax: 0 },
  outline: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  create: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: createTargetAliases,
    argumentGroups: {
      "content=": "content",
      "template=": "template",
      "date-format=": "date-format",
      "time-format=": "time-format",
      overwrite: "overwrite",
    },
    groupConflicts: [["content", "template"]],
    optionConflicts: [
      ["content", "content"],
      ["template", "content"],
    ],
    valueRules: {
      "path=": "path",
      "name=": "path",
      "content=": "text",
      "template=": "path",
      "date-format=": "nonempty-text",
      "time-format=": "nonempty-text",
    },
  },
  daily: {
    positionalMax: 0,
    argumentGroups: {
      "folder=": "folder",
      "format=": "format",
      "template=": "template",
      "date-format=": "date-format",
      "time-format=": "time-format",
    },
    valueRules: {
      ...optionalFolderValueRules,
      "format=": "nonempty-text",
      "template=": "path",
      "date-format=": "nonempty-text",
      "time-format=": "nonempty-text",
    },
  },
  "daily.path": {
    positionalMax: 0,
    argumentGroups: { "folder=": "folder", "format=": "format" },
    valueRules: { ...optionalFolderValueRules, "format=": "nonempty-text" },
  },
  "daily.read": {
    positionalMax: 0,
    argumentGroups: { "folder=": "folder", "format=": "format" },
    valueRules: { ...optionalFolderValueRules, "format=": "nonempty-text" },
  },
  "daily.append": {
    positionalMax: 0,
    argumentGroups: {
      "folder=": "folder",
      "format=": "format",
      "content=": "content",
      inline: "inline",
    },
    valueRules: {
      ...optionalFolderValueRules,
      "format=": "nonempty-text",
      "content=": "nonempty-text",
    },
    optionConflicts: [
      ["content", "content"],
      ["inline", "inline"],
    ],
  },
  "daily.prepend": {
    positionalMax: 0,
    argumentGroups: {
      "folder=": "folder",
      "format=": "format",
      "content=": "content",
      inline: "inline",
    },
    valueRules: {
      ...optionalFolderValueRules,
      "format=": "nonempty-text",
      "content=": "nonempty-text",
    },
    optionConflicts: [
      ["content", "content"],
      ["inline", "inline"],
    ],
  },
  append: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    argumentGroups: { "content=": "content", inline: "inline" },
    valueRules: { ...targetValueRules, "content=": "nonempty-text" },
    optionConflicts: [
      ["content", "content"],
      ["inline", "inline"],
    ],
  },
  prepend: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    argumentGroups: { "content=": "content", inline: "inline" },
    valueRules: { ...targetValueRules, "content=": "nonempty-text" },
    optionConflicts: [
      ["content", "content"],
      ["inline", "inline"],
    ],
  },
  move: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    argumentGroups: { "to=": "to" },
    valueRules: { ...targetValueRules, "to=": "path" },
    optionConflicts: [["to", "to"]],
  },
  rename: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    argumentGroups: { "name=": "name" },
    valueRules: { ...targetValueRules, "name=": "path" },
    optionConflicts: [["name", "name"]],
  },
  delete: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  "trash.list": { positionalMax: 1, positionalGroup: "list", positionalStaticGroups: ["list"] },
  restore: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  properties: {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: targetValueRules,
  },
  "property.read": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: { ...targetValueRules, "name=": "property-name" },
  },
  "property.set": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: {
      ...targetValueRules,
      "name=": "property-name",
      "value=": "text",
    },
  },
  "property.remove": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: targetAliases,
    valueRules: { ...targetValueRules, "name=": "property-name" },
  },
  tasks: {
    positionalMax: 0,
    groupAliases: { "path=": "target", "file=": "target", "status=": "filter" },
    argumentGroups: {
      done: "filter",
      todo: "filter",
      "status=": "filter",
      daily: "daily",
      total: "total",
      verbose: "verbose",
      "format=text": "format",
      "format=json": "format",
      "format=tsv": "format",
      "format=csv": "format",
    },
    groupConflicts: [["target", "daily"]],
    valueRules: { "path=": "path", "file=": "path", "status=": "task-status" },
  },
  task: {
    positionalMax: 0,
    groupAliases: { "file=": "target", "path=": "target", "ref=": "reference" },
    argumentGroups: {
      daily: "daily",
      "line=": "line",
      toggle: "mutation",
      done: "mutation",
      todo: "mutation",
      "status=": "mutation",
    },
    groupConflicts: [
      ["mutation", "mutation"],
      ["target", "daily"],
      ["reference", "target"],
      ["reference", "daily"],
      ["reference", "line"],
    ],
    valueRules: {
      "file=": "path",
      "path=": "path",
      "ref=": "reference",
      "line=": "positive-integer",
      "status=": "task-status",
    },
  },
  aliases: {
    positionalMax: 0,
    groupAliases: targetAliases,
    argumentGroups: { total: "total", verbose: "verbose" },
    valueRules: targetValueRules,
  },
  tags: {
    positionalMax: 0,
    groupAliases: targetAliases,
    argumentGroups: {
      "sort=count": "sort",
      total: "total",
      counts: "counts",
      "format=text": "format",
      "format=json": "format",
      "format=tsv": "format",
      "format=csv": "format",
    },
    valueRules: targetValueRules,
  },
  tag: {
    positionalMax: 0,
    argumentGroups: { "name=": "name", total: "total", verbose: "verbose" },
    valueRules: { "name=": "tag-name" },
  },
  templates: {
    positionalMax: 0,
    argumentGroups: { "folder=": "folder", total: "total" },
    valueRules: optionalFolderValueRules,
  },
  "template.read": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: templateTargetAliases,
    argumentGroups: { "folder=": "folder", "title=": "title", resolve: "resolve" },
    valueRules: {
      "name=": "path",
      "path=": "path",
      ...optionalFolderValueRules,
      "title=": "text",
    },
  },
  "random.read": {
    positionalMax: 0,
    argumentGroups: { "folder=": "folder" },
    valueRules: optionalFolderValueRules,
  },
  plugins: {
    positionalMax: 0,
    argumentGroups: {
      "filter=community": "filter",
      versions: "versions",
      "format=json": "format",
      "format=tsv": "format",
      "format=csv": "format",
    },
  },
  plugin: {
    positionalMax: 0,
    argumentGroups: { "id=": "id" },
    valueRules: { "id=": "plugin-id" },
  },
  themes: { positionalMax: 0, argumentGroups: { versions: "versions" } },
  theme: {
    positionalMax: 0,
    argumentGroups: { "name=": "name" },
    valueRules: { "name=": "nonempty-text" },
  },
  snippets: { positionalMax: 0 },
  "port.inspect": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: portTargetAliases,
    valueRules: portTargetValueRules,
  },
  "port.ci": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: portTargetAliases,
    valueRules: portTargetValueRules,
  },
  "port.scaffold": {
    positionalMax: 1,
    positionalGroup: "target",
    groupAliases: portTargetAliases,
    argumentGroups: { native: "kind", compatibility: "kind" },
    groupConflicts: [["kind", "kind"]],
    valueRules: portTargetValueRules,
  },
};

function completionGrammarFor(spec: CliCommandSpec, spelling?: string): CliCompletionGrammar {
  const base = completionGrammarById[spec.id];
  if (spec.id === "vault.info" && spelling === "vault:info") {
    const adjusted = { ...base };
    delete adjusted.positionalGroup;
    adjusted.positionalMax = 0;
    adjusted.positionalStaticGroups = [];
    return adjusted;
  }
  if (spec.id === "trash.list" && spelling === "trash:list") {
    const adjusted = { ...base };
    delete adjusted.positionalGroup;
    adjusted.positionalMax = 0;
    adjusted.positionalStaticGroups = [];
    return adjusted;
  }
  return base;
}

export const cliHelpTopics: readonly string[] = cliCommandSpecs
  .flatMap((spec) => spec.names)
  .filter((name) => name !== "help");

const optionById = new Map(cliGlobalOptions.map((option) => [option.id, option]));

function optionUsage(id: CliGlobalOptionId): string {
  const option = optionById.get(id);
  if (!option) {
    throw new Error(`Unknown CLI option metadata: ${id}`);
  }
  return option.usage;
}

function usagePrefix(requiresVault: boolean): string {
  return requiresVault
    ? `threadleaf ${optionUsage("vault")} [${optionUsage("json")}]`
    : "threadleaf";
}

export function cliUsageLines(): readonly string[] {
  return cliCommandSpecs.flatMap((spec) =>
    spec.usage.map((usage) => `${usagePrefix(spec.requiresVault)} ${usage}`),
  );
}

export const cliCompatibilityUsageLines: readonly string[] = [
  "file file=<name>",
  "files folder=<path> ext=<extension> total",
  "folder path=<path> info=size",
  "folders folder=<path> total",
  "wordcount file=<note-name> words",
  "read file=<note-name>",
  "search query=<text> path=<folder> limit=<n> total case",
  "search:context query=<text> format=json",
  "links path=<note.md> total",
  "backlinks file=<note-name> counts format=csv",
  "unresolved counts verbose format=json",
  "outline path=<note.md> format=md",
  "create path=<note> [content=<text> | template=<note.md>] [overwrite]",
  "daily folder=Journal format=YYYY/MMMM/YYYY-MM-DD template=Templates/Daily.md",
  "daily:path folder=Journal format=YYYY/MMMM/YYYY-MM-DD",
  "daily:read folder=Journal format=YYYY/MMMM/YYYY-MM-DD",
  "daily:append folder=Journal format=YYYY/MMMM/YYYY-MM-DD content=<text>",
  "daily:prepend folder=Journal format=YYYY/MMMM/YYYY-MM-DD content=<text>",
  "append path=<note> content=<text> [inline]",
  "prepend path=<note> content=<text> [inline]",
  "move path=<note> to=<path>",
  "rename path=<note> name=<filename>",
  "delete path=<note>",
  "restore path=<note>",
  "properties path=<note.md>",
  "property:read path=<note.md> name=<name>",
  "property:set path=<note.md> name=<name> value=<value> [type=<type>]",
  "property:remove path=<note.md> name=<name>",
  "tasks [file=<note-name>] [done|todo|status=<char>] [daily] [total|verbose] format=<text|json|tsv|csv>",
  "task path=<note.md> line=<n> [toggle|done|todo|status=<char>]",
  "aliases [file=<note-name>] [total|verbose]",
  "tags [path=<note.md>] [sort=count] [total|counts] format=<text|json|tsv|csv>",
  "tag name=<tag> [total|verbose]",
  "templates folder=<path> total",
  "template:read name=<template> title=<title> resolve",
  "random:read folder=<path>",
  "plugins filter=community versions format=csv",
  "plugin id=<plugin-id>",
  "themes versions",
  "theme name=<theme-name>",
  "snippets",
].map((usage) => `${usagePrefix(true)} ${usage}`);

export const cliTargetRules = [
  "Target rules:",
  "  Positional note targets and path= are exact vault-relative paths.",
  "  file= resolves one case-insensitive NFC-normalized Markdown basename; .md is optional.",
  "  Missing and duplicate file= matches fail explicitly instead of choosing a note.",
  "  The file info command uses the same rule across every visible vault file type.",
  "",
  "Commands are headless and never require a running Electron process.",
  "Plugin, theme, and snippet catalogs never execute code or expose private application selections.",
  "Porting commands are vault-free and static-only; they never import, evaluate, or require() the",
  "inspected package.",
];

export function renderCliHelp(): string {
  return [
    "Threadleaf command line",
    "",
    "Usage:",
    ...cliUsageLines().map((line) => `  ${line}`),
    "",
    "Compatibility spellings:",
    ...cliCompatibilityUsageLines.map((line) => `  ${line}`),
    "",
    ...cliTargetRules,
    "",
  ].join("\n");
}

function shellSingleQuote(value: string, quote: string): string {
  return `${quote}${value.replaceAll(quote, `${quote}\\${quote}${quote}`)}${quote}`;
}

function bashQuote(value: string): string {
  return shellSingleQuote(value, "'");
}

function zshQuote(value: string): string {
  return shellSingleQuote(value, "'");
}

function fishQuote(value: string): string {
  return `"${value.replaceAll(/[\\"$`\t ]/gu, "\\$&")}"`;
}

function fishCondition(value: string): string {
  return `'${value.replaceAll("'", "\\'")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Exported for fixture coverage of shell-safe metadata escaping. */
export function quoteCompletionToken(shell: CliShell, value: string): string {
  switch (shell) {
    case "bash":
      return bashQuote(value);
    case "zsh":
      return zshQuote(value);
    case "fish":
      return fishQuote(value);
    case "powershell":
      return powershellQuote(value);
  }
}

function optionNamesFor(spec: CliCommandSpec): string[] {
  const names = spec.globalOptions.flatMap((id) => optionById.get(id)?.names ?? []);
  return [...new Set(names)];
}

function completionStaticWordsFor(spec: CliCommandSpec, spelling?: string): string[] {
  const words =
    spec.id === "help"
      ? cliHelpTopics
      : spelling && spec.completionWordsByName?.[spelling]
        ? spec.completionWordsByName[spelling]
        : spec.completionWords;
  const terminalAliasLeaf = spelling?.includes(":")
    ? spelling.slice(spelling.lastIndexOf(":") + 1)
    : null;
  const spellingWords =
    terminalAliasLeaf === null ? words : words.filter((word) => word !== terminalAliasLeaf);
  return [...new Set(spellingWords)];
}

function completionValuesFor(spec: CliCommandSpec, spelling?: string): string[] {
  return completionStaticWordsFor(spec, spelling);
}

function completionWordsFor(spec: CliCommandSpec, spelling?: string): string[] {
  return [
    ...new Set([
      ...(spelling === undefined ? spec.names : [spelling]),
      ...completionStaticWordsFor(spec, spelling),
      ...optionNamesFor(spec),
    ]),
  ];
}

function completionWordKey(word: string): string {
  const equals = word.indexOf("=");
  return equals < 0 ? word : word.slice(0, equals + 1);
}

function completionGroupFor(
  spec: CliCommandSpec,
  spelling: string | undefined,
  word: string,
): string {
  const grammar = completionGrammarFor(spec, spelling);
  if (grammar.mode && grammar.positionalGroup) {
    return grammar.positionalGroup;
  }
  const key = completionWordKey(word);
  return (
    grammar.argumentGroups?.[word] ??
    grammar.argumentGroups?.[key] ??
    grammar.groupAliases?.[key] ??
    key
  );
}

function completionGroupsFor(spec: CliCommandSpec, spelling?: string): string[] {
  const grammar = completionGrammarFor(spec, spelling);
  return [
    ...(grammar.positionalGroup ? [grammar.positionalGroup] : []),
    ...(grammar.positionalStaticGroups ?? []),
    ...completionStaticWordsFor(spec, spelling).map((word) =>
      completionGroupFor(spec, spelling, word),
    ),
  ].filter((group, index, groups) => groups.indexOf(group) === index);
}

function shellGrammarVariable(spec: CliCommandSpec, group: string): string {
  const command = spec.id.replaceAll(/[^a-zA-Z0-9]/gu, "_");
  const argument = group.replaceAll(/[^a-zA-Z0-9]/gu, "_");
  return `argument_${command}_${argument}_seen`;
}

function completionStaticGroupIsPositional(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
): boolean {
  const grammar = completionGrammarFor(spec, spelling);
  return (grammar.positionalStaticGroups ?? []).includes(group);
}

function completionPositionalGroupIsFinite(
  spec: CliCommandSpec,
  spelling: string | undefined,
): boolean {
  const grammar = completionGrammarFor(spec, spelling);
  return (
    grammar.positionalMax !== null &&
    grammar.positionalMax !== undefined &&
    grammar.positionalMax > 0 &&
    grammar.positionalGroup !== undefined &&
    (grammar.positionalStaticGroups ?? []).includes(grammar.positionalGroup)
  );
}

function completionRejectedWordsFor(
  spec: CliCommandSpec,
  spelling: string | undefined,
): readonly string[] {
  return completionGrammarFor(spec, spelling).rejectedWords ?? [];
}

function bashRejectedWordCondition(spec: CliCommandSpec, spelling: string | undefined): string {
  return completionRejectedWordsFor(spec, spelling)
    .map((word) => `"$token" == ${bashQuote(word)}`)
    .join(" || ");
}

function fishRejectedWordCondition(spec: CliCommandSpec, spelling: string | undefined): string {
  return completionRejectedWordsFor(spec, spelling)
    .map((word) => `test "$token" = ${fishQuote(word)}`)
    .join("; or ");
}

function powershellRejectedWordCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
): string {
  return completionRejectedWordsFor(spec, spelling)
    .map((word) => `$text -ceq ${powershellQuote(word)}`)
    .join(" -or ");
}

interface CompletionWordPattern {
  group: string;
  word: string;
  wildcard: boolean;
  valueRule: CliCompletionValueRule | null;
}

function completionWordPatterns(spec: CliCommandSpec, spelling?: string): CompletionWordPattern[] {
  const words = completionStaticWordsFor(spec, spelling);
  const patterns: CompletionWordPattern[] = [];
  for (const word of words) {
    const group = completionGroupFor(spec, spelling, word);
    if (word.endsWith("=")) {
      const prefix = word.slice(0, -1);
      const valueRule = completionGrammarFor(spec, spelling).valueRules?.[word];
      if (!valueRule) {
        throw new Error(`Missing completion value rule for ${spelling ?? spec.id} ${word}`);
      }
      // Parser aliases such as path= and file= share one argument group but
      // remain distinct accepted tokens. Keep every prefix in the scanner;
      // deduplicating them here would make one alias look like an unknown
      // equals-token and poison the rest of completion state.
      patterns.push({ group, word: `${prefix}=`, wildcard: true, valueRule });
    } else {
      patterns.push({ group, word, wildcard: false, valueRule: null });
    }
  }
  return patterns;
}

function commandSpec(name: string): CliCommandSpec | undefined {
  return cliCommandSpecs.find((spec) => spec.names.includes(name));
}

function allCommandNames(): string[] {
  return [...new Set(cliCommandSpecs.flatMap((spec) => spec.names))];
}

function optionIdsFor(spec: CliCommandSpec): readonly CliGlobalOptionId[] {
  return spec.globalOptions;
}

function allOptionIds(): readonly CliGlobalOptionId[] {
  return cliGlobalOptions.map((option) => option.id);
}

/** Whether a command spelling remains parser-eligible after root options were consumed. */
export function commandAllowsConsumedOptions(
  spec: CliCommandSpec,
  consumedOptionIds: readonly CliGlobalOptionId[],
): boolean {
  const allowedOptionIds = spec.id === "help" ? allOptionIds() : spec.globalOptions;
  return consumedOptionIds.every((optionId) => allowedOptionIds.includes(optionId));
}

function disallowedRootOptionIds(spec: CliCommandSpec): CliGlobalOptionId[] {
  return allOptionIds().filter((optionId) => !commandAllowsConsumedOptions(spec, [optionId]));
}

function bashCommandAllowedCondition(spec: CliCommandSpec): string {
  const disallowed = disallowedRootOptionIds(spec);
  return disallowed.length === 0
    ? "true"
    : disallowed.map((optionId) => `(( ! ${shellOptionVariable(optionId)}_seen ))`).join(" && ");
}

function zshCommandAllowedCondition(spec: CliCommandSpec): string {
  return bashCommandAllowedCondition(spec);
}

function shellOptionVariable(id: CliGlobalOptionId): string {
  return id.replaceAll("-", "_");
}

function completionOptionValueRule(id: CliGlobalOptionId): CliCompletionValueRule {
  switch (id) {
    case "content":
      return "text";
    case "limit":
      return "positive-integer";
    case "vault":
    case "directory":
    case "to":
    case "name":
    case "output":
    case "receipt":
      return "path";
    default:
      throw new Error(`CLI option ${id} does not take a completion value.`);
  }
}

function bashOptionScanCases(): string {
  return cliGlobalOptions
    .map((option) => {
      const seenVariable = `${shellOptionVariable(option.id)}_seen`;
      const duplicate =
        option.id === "json" || option.id === "help"
          ? ""
          : `if (( ${seenVariable} )); then invalid_option=1; fi; `;
      const seen = `${seenVariable}=1`;
      const helpMode =
        option.id === "help"
          ? 'if [[ -n "$command" && "$command" != "help" ]]; then (( argument_count > 0 )) && invalid_argument=1; argument_help_topic_seen=1; argument_count=$((argument_count + 1)); positional_count=$((positional_count + 1)); fi; command="help"; '
          : "";
      if (option.takesValue) {
        const valueRule = completionOptionValueRule(option.id);
        const bareNames = option.names.filter((name) => !name.includes("="));
        const inlineNames = option.names
          .filter((name) => name.startsWith("--"))
          .map((name) => `${name}=*`);
        const emptyInlineNames = option.allowEmptyValue
          ? []
          : option.names.filter((name) => name.startsWith("--")).map((name) => `${name}=`);
        const pendingEmpty = option.allowEmptyValue ? 0 : 1;
        return [
          `      ${bareNames.join("|")}) ${duplicate}${seen}; ${helpMode}pending_value=1; pending_nonempty=${pendingEmpty}; pending_value_rule=${bashQuote(valueRule)};;`,
          ...(emptyInlineNames.length > 0
            ? [`      ${emptyInlineNames.join("|")}) ${duplicate}${seen}; invalid_option=1;;`]
            : []),
          `      ${inlineNames.join("|")}) ${duplicate}${seen}; ${helpMode}if ! _threadleaf_completion_value_valid ${bashQuote(valueRule)} "\${token#*=}"; then invalid_option=1; fi;;`,
        ].join("\n");
      }
      return `      ${option.names.join("|")}) ${duplicate}${seen}; ${helpMode};;`;
    })
    .join("\n");
}

function zshOptionScanCases(): string {
  return cliGlobalOptions
    .map((option) => {
      const seenVariable = `${shellOptionVariable(option.id)}_seen`;
      const duplicate =
        option.id === "json" || option.id === "help"
          ? ""
          : `if (( ${seenVariable} )); then invalid_option=1; fi; `;
      const seen = `${seenVariable}=1`;
      const helpMode =
        option.id === "help"
          ? 'if [[ -n "$command" && "$command" != "help" ]]; then (( argument_count > 0 )) && invalid_argument=1; argument_help_topic_seen=1; argument_count=$((argument_count + 1)); positional_count=$((positional_count + 1)); fi; command="help"; '
          : "";
      if (option.takesValue) {
        const valueRule = completionOptionValueRule(option.id);
        const bareNames = option.names.filter((name) => !name.includes("="));
        const inlineNames = option.names
          .filter((name) => name.startsWith("--"))
          .map((name) => `${name}=*`);
        const emptyInlineNames = option.allowEmptyValue
          ? []
          : option.names.filter((name) => name.startsWith("--")).map((name) => `${name}=`);
        const pendingEmpty = option.allowEmptyValue ? 0 : 1;
        return [
          `      ${bareNames.join("|")}) ${duplicate}${seen}; ${helpMode}pending_value=1; pending_nonempty=${pendingEmpty}; pending_value_rule=${zshQuote(valueRule)};;`,
          ...(emptyInlineNames.length > 0
            ? [`      ${emptyInlineNames.join("|")}) ${duplicate}${seen}; invalid_option=1;;`]
            : []),
          `      ${inlineNames.join("|")}) ${duplicate}${seen}; ${helpMode}if ! _threadleaf_completion_value_valid ${zshQuote(valueRule)} "\${token#*=}"; then invalid_option=1; fi;;`,
        ].join("\n");
      }
      return `      ${option.names.join("|")}) ${duplicate}${seen}; ${helpMode};;`;
    })
    .join("\n");
}

function valueOptionCurrentCases(): string {
  return cliGlobalOptions
    .filter((option) => option.takesValue)
    .flatMap((option) =>
      option.names
        .filter((name) => name.startsWith("--"))
        .map((name) => `      ${name}|${name}=*) return 0;;`),
    )
    .join("\n");
}

function shellValueValidationFunctions(): string[] {
  return [
    "_threadleaf_completion_safe_integer() {",
    '  local value="$1"',
    '  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1',
    "  (( ${#value} < 16 )) && return 0",
    "  (( ${#value} > 16 )) && return 1",
    '  [[ "$value" < "9007199254740992" ]]',
    "}",
    "_threadleaf_completion_value_valid() {",
    '  local rule="$1"',
    '  local value="$2"',
    "  local line target",
    '  case "$rule" in',
    "    text) return 0;;",
    "    nonempty-text)",
    '      [[ -n "$value" && ${#value} -le 256 && "$value" != *$\'\\n\'* && "$value" != *$\'\\r\'* && "$value" =~ [^[:space:]] ]];;',
    '    query) [[ "$value" =~ [^[:space:]] ]];;',
    '    path) [[ -n "$value" ]];;',
    "    optional-path) (( ${#value} <= 4096 )) && [[ \"$value\" != *$'\\n'* && \"$value\" != *$'\\r'* ]];;",
    '    positive-integer) _threadleaf_completion_safe_integer "$value";;',
    '    search-limit) _threadleaf_completion_safe_integer "$value" && (( 10#$value <= 100 ));;',
    "    extension)",
    '      value="${value#.}"',
    '      [[ -n "$value" && "$value" != */* && "$value" != *\\\\* ]];;',
    "    task-status)",
    '      [[ ${#value} -eq 1 && "$value" != "]" && "$value" != *$\'\\t\'* && "$value" != *$\'\\n\'* && "$value" != *$\'\\r\'* ]];;',
    "    reference)",
    '      line="${value##*:}"',
    '      target="${value%:*}"',
    '      [[ -n "$target" && "$target" != "$value" ]] && _threadleaf_completion_safe_integer "$line";;',
    '    plugin-id) [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]];;',
    '    property-name) [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]];;',
    "    tag-name)",
    '      value="${value#\\#}"',
    '      [[ -n "$value" && "$value" =~ ^[[:alnum:]_/-]+$ ]];;',
    "    *) return 1;;",
    "  esac",
    "}",
  ];
}

function grammarConflictGroups(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
): string[] {
  const grammar = completionGrammarFor(spec, spelling);
  return (grammar.groupConflicts ?? [])
    .flatMap(([left, right]) => (left === group ? [right] : right === group ? [left] : []))
    .filter(
      (candidate, index, groups) => candidate !== group && groups.indexOf(candidate) === index,
    );
}

function grammarOptionConflictGroups(
  spec: CliCommandSpec,
  spelling: string | undefined,
  optionId: CliGlobalOptionId,
): string[] {
  return (completionGrammarFor(spec, spelling).optionConflicts ?? [])
    .filter(([, id]) => id === optionId)
    .map(([group]) => group)
    .filter((group, index, groups) => groups.indexOf(group) === index);
}

function bashGroupAllowedCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
): string {
  const grammar = completionGrammarFor(spec, spelling);
  const terms = [`(( ! ${shellGrammarVariable(spec, group)} ))`];
  for (const conflict of grammarConflictGroups(spec, spelling, group)) {
    terms.push(`(( ! ${shellGrammarVariable(spec, conflict)} ))`);
  }
  for (const optionId of cliGlobalOptions.map((option) => option.id)) {
    if (
      (grammar.optionConflicts ?? []).some(
        ([candidateGroup, candidateOption]) =>
          candidateGroup === group && candidateOption === optionId,
      )
    ) {
      terms.push(`(( ! ${shellOptionVariable(optionId)}_seen ))`);
    }
  }
  return terms.join(" && ");
}

function zshGroupAllowedCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
): string {
  return bashGroupAllowedCondition(spec, spelling, group);
}

function bashOptionAllowedCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
  optionId: CliGlobalOptionId,
): string {
  const terms = [`(( ! ${shellOptionVariable(optionId)}_seen ))`];
  // `--help` is a global parser escape. Once a command has consumed an
  // argument, appending it is rejected; help topics likewise cannot be
  // followed by another global option.
  if (optionId === "help" || spec.id === "help") {
    terms.push("(( argument_count == 0 ))");
  }
  for (const group of grammarOptionConflictGroups(spec, spelling, optionId)) {
    terms.push(`(( ! ${shellGrammarVariable(spec, group)} ))`);
  }
  return terms.join(" && ");
}

function zshOptionAllowedCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
  optionId: CliGlobalOptionId,
): string {
  return bashOptionAllowedCondition(spec, spelling, optionId);
}

function bashStaticCasePattern(pattern: CompletionWordPattern): string {
  return pattern.wildcard ? `${bashQuote(pattern.word)}*` : bashQuote(pattern.word);
}

function zshStaticCasePattern(pattern: CompletionWordPattern): string {
  return pattern.wildcard ? `${zshQuote(pattern.word)}*` : zshQuote(pattern.word);
}

function bashArgumentAction(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
  positional: boolean,
): string {
  const variable = shellGrammarVariable(spec, group);
  const allowed = bashGroupAllowedCondition(spec, spelling, group);
  const increment = positional ? "; positional_count=$((positional_count + 1))" : "";
  return `if ${allowed}; then ${variable}=1; argument_count=$((argument_count + 1))${increment}; else invalid_argument=1; fi`;
}

function zshArgumentAction(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
  positional: boolean,
): string {
  return bashArgumentAction(spec, spelling, group, positional);
}

function bashArgumentTokenCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const grammar = completionGrammarFor(spec, spelling);
        const staticCases = completionWordPatterns(spec, spelling).map((pattern) => {
          const positional = completionStaticGroupIsPositional(spec, spelling, pattern.group);
          const action = bashArgumentAction(spec, spelling, pattern.group, positional);
          const validatedAction = pattern.valueRule
            ? `if _threadleaf_completion_value_valid ${bashQuote(pattern.valueRule)} "\${token#*=}"; then ${action}; else invalid_argument=1; fi`
            : action;
          return `        ${bashStaticCasePattern(pattern)}) ${validatedAction};;`;
        });
        const rejectedWordCondition = bashRejectedWordCondition(spec, spelling);
        const rawAction =
          grammar.positionalMax === null
            ? `        *) ${
                rejectedWordCondition
                  ? `if [[ ${rejectedWordCondition} ]]; then invalid_argument=1; elif [[ "$token" == *"="* ]]; then invalid_argument=1; else argument_count=$((argument_count + 1)); fi`
                  : 'if [[ "$token" == *"="* ]]; then invalid_argument=1; else argument_count=$((argument_count + 1)); fi'
              };;`
            : grammar.positionalMax !== undefined &&
                grammar.positionalMax > 0 &&
                grammar.positionalGroup
              ? completionPositionalGroupIsFinite(spec, spelling)
                ? "        *) invalid_argument=1;;"
                : `        *) if [[ "$token" == *"="* ]]; then invalid_argument=1; elif (( positional_count < ${grammar.positionalMax} )) && ${bashGroupAllowedCondition(spec, spelling, grammar.positionalGroup)}; then ${bashArgumentAction(spec, spelling, grammar.positionalGroup, true)}; else invalid_argument=1; fi;;`
              : "        *) invalid_argument=1;;";
        return [
          `      ${spelling})`,
          '        case "$token" in',
          ...staticCases,
          rawAction,
          "        esac;;",
        ].join("\n");
      }),
    )
    .join("\n");
}

function zshArgumentTokenCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const grammar = completionGrammarFor(spec, spelling);
        const staticCases = completionWordPatterns(spec, spelling).map((pattern) => {
          const positional = completionStaticGroupIsPositional(spec, spelling, pattern.group);
          const action = zshArgumentAction(spec, spelling, pattern.group, positional);
          const validatedAction = pattern.valueRule
            ? `if _threadleaf_completion_value_valid ${zshQuote(pattern.valueRule)} "\${token#*=}"; then ${action}; else invalid_argument=1; fi`
            : action;
          return `        ${zshStaticCasePattern(pattern)}) ${validatedAction};;`;
        });
        const rejectedWordCondition = bashRejectedWordCondition(spec, spelling);
        const rawAction =
          grammar.positionalMax === null
            ? `        *) ${
                rejectedWordCondition
                  ? `if [[ ${rejectedWordCondition} ]]; then invalid_argument=1; elif [[ "$token" == *"="* ]]; then invalid_argument=1; else argument_count=$((argument_count + 1)); fi`
                  : 'if [[ "$token" == *"="* ]]; then invalid_argument=1; else argument_count=$((argument_count + 1)); fi'
              };;`
            : grammar.positionalMax !== undefined &&
                grammar.positionalMax > 0 &&
                grammar.positionalGroup
              ? completionPositionalGroupIsFinite(spec, spelling)
                ? "        *) invalid_argument=1;;"
                : `        *) if [[ "$token" == *"="* ]]; then invalid_argument=1; elif (( positional_count < ${grammar.positionalMax} )) && ${zshGroupAllowedCondition(spec, spelling, grammar.positionalGroup)}; then ${zshArgumentAction(spec, spelling, grammar.positionalGroup, true)}; else invalid_argument=1; fi;;`
              : "        *) invalid_argument=1;;";
        return [
          `      ${spelling})`,
          '        case "$token" in',
          ...staticCases,
          rawAction,
          "        esac;;",
        ].join("\n");
      }),
    )
    .join("\n");
}

function bashGrammarValidationCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const allowed = new Set(spec.id === "help" ? allOptionIds() : spec.globalOptions);
        const optionChecks = cliGlobalOptions
          .filter((option) => !allowed.has(option.id))
          .map(
            (option) => `      (( ${shellOptionVariable(option.id)}_seen )) && invalid_option=1;`,
          )
          .join("\n");
        const conflictChecks = (completionGrammarFor(spec, spelling).optionConflicts ?? [])
          .map(
            ([group, optionId]) =>
              `      (( ${shellGrammarVariable(spec, group)} && ${shellOptionVariable(optionId)}_seen )) && invalid_argument=1;`,
          )
          .join("\n");
        return [`    ${spelling})`, optionChecks, conflictChecks, "      ;;"]
          .filter(Boolean)
          .join("\n");
      }),
    )
    .join("\n");
}

function zshGrammarValidationCases(): string {
  return bashGrammarValidationCases();
}

function bashOptionCandidatesCase(): string {
  return cliCommandSpecs
    .map((spec) => {
      const names = spec.names.join("|");
      const options = optionIdsFor(spec)
        .map((id) => {
          const candidates = optionById.get(id)?.names.map(bashQuote).join(" ") ?? "";
          return `        if ${bashOptionAllowedCondition(spec, names.split("|")[0], id)}; then candidates+=(${candidates}); fi`;
        })
        .join("\n");
      return `        ${names})\n${options}\n          ;;`;
    })
    .join("\n");
}

function zshOptionCandidatesCase(): string {
  return cliCommandSpecs
    .map((spec) => {
      const names = spec.names.join("|");
      const options = optionIdsFor(spec)
        .map((id) => {
          const candidates = optionById.get(id)?.names.map(zshQuote).join(" ") ?? "";
          return `        if ${zshOptionAllowedCondition(spec, names.split("|")[0], id)}; then candidates+=(${candidates}); fi`;
        })
        .join("\n");
      return `        ${names})\n${options}\n          ;;`;
    })
    .join("\n");
}

function bashRootOptionCandidates(): string {
  return cliGlobalOptions
    .map((option) => {
      const names = option.names.map(bashQuote).join(" ");
      return `        if (( ! ${shellOptionVariable(option.id)}_seen )); then candidates+=(${names}); fi`;
    })
    .join("\n");
}

function zshRootOptionCandidates(): string {
  return cliGlobalOptions
    .map((option) => {
      const names = option.names.map(zshQuote).join(" ");
      return `        if (( ! ${shellOptionVariable(option.id)}_seen )); then candidates+=(${names}); fi`;
    })
    .join("\n");
}

function bashRootCommandCandidates(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map(
        (name) =>
          `    if ${bashCommandAllowedCondition(spec)}; then candidates+=(${bashQuote(name)}); fi`,
      ),
    )
    .join("\n");
}

function zshRootCommandCandidates(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map(
        (name) =>
          `    if ${zshCommandAllowedCondition(spec)}; then candidates+=(${zshQuote(name)}); fi`,
      ),
    )
    .join("\n");
}

function bashStaticCandidatesCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((name) => {
        const candidates = completionValuesFor(spec, name).map((word) => {
          const group = completionGroupFor(spec, name, word);
          return `        if ${bashGroupAllowedCondition(spec, name, group)}; then candidates+=(${bashQuote(word)}); fi`;
        });
        return `        ${name})\n${candidates.join("\n")}\n          ;;`;
      }),
    )
    .join("\n");
}

function zshStaticCandidatesCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((name) => {
        const candidates = completionValuesFor(spec, name).map((word) => {
          const group = completionGroupFor(spec, name, word);
          return `        if ${zshGroupAllowedCondition(spec, name, group)}; then candidates+=(${zshQuote(word)}); fi`;
        });
        return `        ${name})\n${candidates.join("\n")}\n          ;;`;
      }),
    )
    .join("\n");
}

function allGrammarVariables(): string[] {
  return cliCommandSpecs
    .flatMap((spec) => completionGroupsFor(spec).map((group) => shellGrammarVariable(spec, group)))
    .filter((variable, index, variables) => variables.indexOf(variable) === index);
}

function fishValueValidationFunctions(): string[] {
  return [
    "function __threadleaf_fish_safe_integer",
    '  set -l value "$argv[1]"',
    "  string match -rq -- '^[1-9][0-9]*$' \"$value\"; or return 1",
    '  set -l length (string length -- "$value")',
    "  if test $length -lt 16; return 0; end",
    "  if test $length -gt 16; return 1; end",
    '  test "$value" \\< "9007199254740992"',
    "end",
    "",
    "function __threadleaf_fish_value_valid",
    '  set -l rule "$argv[1]"',
    '  set -l value "$argv[2]"',
    '  switch "$rule"',
    "    case text",
    "      return 0",
    "    case nonempty-text",
    '      test -n (string trim -- "$value"); or return 1',
    '      test (string length -- "$value") -le 256; or return 1',
    "      string match -rq -- '[\\r\\n]' \"$value\"; and return 1",
    "      return 0",
    "    case query",
    '      test -n (string trim -- "$value")',
    "    case path",
    '      test -n "$value"',
    "    case optional-path",
    '      test (string length -- "$value") -le 4096; or return 1',
    "      not string match -rq -- '[\\r\\n]' \"$value\"",
    "    case positive-integer",
    '      __threadleaf_fish_safe_integer "$value"',
    "    case search-limit",
    '      __threadleaf_fish_safe_integer "$value"; and test "$value" -le 100',
    "    case extension",
    "      set value (string replace -r '^\\.' '' -- \"$value\")",
    '      test -n "$value"; and not string match -q -- "*/*" "$value"; and not string match -q -- "*\\\\*" "$value"',
    "    case task-status",
    '      test (string length -- "$value") -eq 1; and test "$value" != "]"; and not string match -rq -- \'[\\t\\r\\n]\' "$value"',
    "    case reference",
    "      set -l line (string replace -r '^.*:' '' -- \"$value\")",
    "      set -l target (string replace -r ':[^:]*$' '' -- \"$value\")",
    '      test -n "$target"; and test "$target" != "$value"; and __threadleaf_fish_safe_integer "$line"',
    "    case plugin-id",
    "      string match -rq -- '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' \"$value\"",
    "    case property-name",
    "      string match -rq -- '^[A-Za-z0-9_-]+$' \"$value\"",
    "    case tag-name",
    "      set value (string replace -r '^#' '' -- \"$value\")",
    "      string match -rq -- '^[\\p{L}\\p{N}_/-]+$' \"$value\"",
    "    case '*'",
    "      return 1",
    "  end",
    "end",
    "",
  ];
}

function fishGroupAllowedCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
): string[] {
  const lines = ["contains -- " + fishQuote(group) + " $seen; and set invalid 1"];
  for (const conflict of grammarConflictGroups(spec, spelling, group)) {
    lines.push("contains -- " + fishQuote(conflict) + " $seen; and set invalid 1");
  }
  for (const optionId of cliGlobalOptions.map((option) => option.id)) {
    if (
      (completionGrammarFor(spec, spelling).optionConflicts ?? []).some(
        ([candidateGroup, candidateOption]) =>
          candidateGroup === group && candidateOption === optionId,
      )
    ) {
      lines.push("contains -- " + fishQuote(optionId) + " $consumed; and set invalid 1");
    }
  }
  return lines;
}

function fishArgumentAction(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
  positional: boolean,
): string[] {
  const lines = ["if contains -- " + fishQuote(group) + " $seen"];
  lines.push("  set invalid 1");
  lines.push("else");
  for (const check of fishGroupAllowedCondition(spec, spelling, group).slice(1)) {
    lines.push("  " + check);
  }
  lines.push("  if not contains -- " + fishQuote(group) + " $seen");
  lines.push("    set -a seen " + fishQuote(group));
  lines.push("    set argument_count (math $argument_count + 1)");
  if (positional) {
    lines.push("    set positional_count (math $positional_count + 1)");
  }
  lines.push("  end");
  lines.push("end");
  return lines;
}

function fishArgumentTokenCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const grammar = completionGrammarFor(spec, spelling);
        const lines = ["      case " + fishQuote(spelling)];
        const patterns = completionWordPatterns(spec, spelling);
        for (const pattern of patterns) {
          const predicate = pattern.wildcard
            ? "string match -q -- " + fishQuote(pattern.word + "*") + ' "$token"'
            : 'test "$token" = ' + fishQuote(pattern.word);
          lines.push("        if " + predicate);
          const action = fishArgumentAction(
            spec,
            spelling,
            pattern.group,
            completionStaticGroupIsPositional(spec, spelling, pattern.group),
          );
          if (pattern.valueRule) {
            lines.push(
              "          if __threadleaf_fish_value_valid " +
                fishQuote(pattern.valueRule) +
                " (string replace -r '^[^=]*=' '' -- \"$token\")",
            );
            lines.push(...action.map((line) => "            " + line));
            lines.push("          else", "            set invalid 1", "          end");
          } else {
            lines.push(...action.map((line) => "          " + line));
          }
          lines.push("        else");
        }
        if (grammar.positionalMax === null) {
          const rejectedWordCondition = fishRejectedWordCondition(spec, spelling);
          if (rejectedWordCondition) {
            lines.push(
              "          if " +
                rejectedWordCondition +
                '; set invalid 1; else if string match -q -- "*=*" "$token"; set invalid 1; else; set argument_count (math $argument_count + 1); end',
            );
          } else {
            lines.push(
              '          if string match -q -- "*=*" "$token"; set invalid 1; else; set argument_count (math $argument_count + 1); end',
            );
          }
        } else if (grammar.positionalMax > 0 && grammar.positionalGroup) {
          if (completionPositionalGroupIsFinite(spec, spelling)) {
            lines.push("          set invalid 1");
          } else {
            lines.push('          if string match -q -- "*=*" "$token"; set invalid 1');
            lines.push(
              "          else if test $positional_count -lt " +
                grammar.positionalMax +
                "; and not contains -- " +
                fishQuote(grammar.positionalGroup) +
                " $seen",
            );
            lines.push(
              ...fishArgumentAction(spec, spelling, grammar.positionalGroup, true).map(
                (line) => "            " + line,
              ),
            );
            lines.push("          else");
            lines.push("            set invalid 1");
            lines.push("          end");
          }
        } else {
          lines.push("          set invalid 1");
        }
        for (const _pattern of patterns) {
          lines.push("        end");
        }
        lines.push("");
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function fishOptionValidationCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const allowed = new Set(spec.id === "help" ? allOptionIds() : spec.globalOptions);
        const checks = cliGlobalOptions
          .filter((option) => !allowed.has(option.id))
          .map(
            (option) =>
              "        contains -- " + fishQuote(option.id) + " $consumed; and set invalid 1",
          )
          .join("\n");
        const conflictChecks = (completionGrammarFor(spec, spelling).optionConflicts ?? [])
          .map(
            ([group, optionId]) =>
              "        contains -- " +
              fishQuote(group) +
              " $seen; and contains -- " +
              fishQuote(optionId) +
              " $consumed; and set invalid 1",
          )
          .join("\n");
        return ["      case " + fishQuote(spelling), checks, conflictChecks]
          .filter(Boolean)
          .join("\n");
      }),
    )
    .join("\n");
}

function fishStaticConflictCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const groups = completionGroupsFor(spec, spelling);
        const lines = ["      case " + fishQuote(spelling)];
        for (const group of groups) {
          const checks: string[] = [];
          for (const conflict of grammarConflictGroups(spec, spelling, group)) {
            checks.push(
              "          if __threadleaf_fish_state seen " +
                fishQuote(conflict) +
                "; return 1; end",
            );
          }
          for (const optionId of cliGlobalOptions.map((option) => option.id)) {
            if (
              (completionGrammarFor(spec, spelling).optionConflicts ?? []).some(
                ([candidateGroup, candidateOption]) =>
                  candidateGroup === group && candidateOption === optionId,
              )
            ) {
              checks.push(
                "          if __threadleaf_fish_option_consumed " +
                  fishQuote(optionId) +
                  "; return 1; end",
              );
            }
          }
          if (checks.length > 0) {
            lines.push('        if test "$wanted" = ' + fishQuote(group));
            lines.push(...checks);
            lines.push("        end");
          }
        }
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function fishOptionConflictCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const lines = ["      case " + fishQuote(spelling)];
        for (const [group, optionId] of completionGrammarFor(spec, spelling).optionConflicts ??
          []) {
          lines.push(
            '        if test "$wanted" = ' +
              fishQuote(optionId) +
              "; and __threadleaf_fish_state seen " +
              fishQuote(group) +
              "; return 0; end",
          );
        }
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function fishCommandAllowedCases(): string {
  return cliCommandSpecs
    .map((spec) => {
      const disallowed = disallowedRootOptionIds(spec);
      return [
        `    case ${spec.names.map(fishQuote).join(" ")}`,
        ...disallowed.map(
          (optionId) =>
            `      if __threadleaf_fish_option_consumed ${fishQuote(optionId)}; return 1; end`,
        ),
        "      return 0",
      ].join("\n");
    })
    .join("\n");
}

function powershellArgumentKey(spec: CliCommandSpec, group: string): string {
  return spec.id + ":" + group;
}

function powershellRegexEscape(value: string): string {
  return value.replace(/[^\w]/gu, "\\$&");
}

function powershellValueValidationFunctions(): string[] {
  return [
    "function Test-ThreadleafSafeInteger {",
    "  param([string]$Value)",
    "  if ($Value -cnotmatch '^[1-9][0-9]*$') { return $false }",
    "  [UInt64]$parsed = 0",
    "  if (-not [UInt64]::TryParse($Value, [ref]$parsed)) { return $false }",
    "  return $parsed -le 9007199254740991",
    "}",
    "function Test-ThreadleafCompletionValue {",
    "  param([string]$Rule, [string]$Value)",
    "  switch -CaseSensitive ($Rule) {",
    "    'text' { return $true }",
    "    'nonempty-text' { return $Value.Trim().Length -gt 0 -and $Value.Length -le 256 -and $Value -cnotmatch '[\\r\\n]' }",
    "    'query' { return $Value.Trim().Length -gt 0 }",
    "    'path' { return $Value.Length -gt 0 }",
    "    'optional-path' { return $Value.Length -le 4096 -and $Value -cnotmatch '[\\r\\n]' }",
    "    'positive-integer' { return Test-ThreadleafSafeInteger $Value }",
    "    'search-limit' { if (-not (Test-ThreadleafSafeInteger $Value)) { return $false }; return [UInt64]$Value -le 100 }",
    "    'extension' { $normalized = $Value -creplace '^\\.', ''; return $normalized.Length -gt 0 -and $normalized -cnotmatch '[\\\\/]' }",
    "    'task-status' {",
    "      $codePoints = 0",
    "      for ($index = 0; $index -lt $Value.Length; $index++) {",
    "        if ([Char]::IsHighSurrogate($Value[$index]) -and ($index + 1) -lt $Value.Length -and [Char]::IsLowSurrogate($Value[$index + 1])) { $index++ }",
    "        $codePoints++",
    "      }",
    "      return $codePoints -eq 1 -and $Value -cne ']' -and $Value -cnotmatch '[\\t\\r\\n]'",
    "    }",
    "    'reference' { $colon = $Value.LastIndexOf(':'); return $colon -gt 0 -and (Test-ThreadleafSafeInteger $Value.Substring($colon + 1)) }",
    "    'plugin-id' { return $Value -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' }",
    "    'property-name' { return $Value -cmatch '^[A-Za-z0-9_-]+$' }",
    "    'tag-name' { $normalized = $Value -creplace '^#', ''; return $normalized -cmatch '^[\\p{L}\\p{N}_/-]+$' }",
    "  }",
    "  return $false",
    "}",
  ];
}

function powershellCommandAllowedFunction(): string[] {
  return [
    "function Test-ThreadleafCommandAllowsConsumedOptions {",
    "  param([string]$Command, [string[]]$Consumed)",
    "  switch -CaseSensitive ($Command) {",
    ...cliCommandSpecs.flatMap((spec) => {
      const disallowed = disallowedRootOptionIds(spec);
      const condition =
        disallowed.length === 0
          ? "$true"
          : disallowed
              .map((optionId) => "$Consumed -notcontains " + powershellQuote(optionId))
              .join(" -and ");
      return spec.names.map((name) => `    ${powershellQuote(name)} { return ${condition} }`);
    }),
    "  }",
    "  return $false",
    "}",
  ];
}

function powershellGroupAllowedCondition(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
): string {
  const key = powershellArgumentKey(spec, group);
  const terms = ["-not $argumentSeen.ContainsKey(" + powershellQuote(key) + ")"];
  for (const conflict of grammarConflictGroups(spec, spelling, group)) {
    terms.push(
      "-not $argumentSeen.ContainsKey(" +
        powershellQuote(powershellArgumentKey(spec, conflict)) +
        ")",
    );
  }
  for (const optionId of cliGlobalOptions.map((option) => option.id)) {
    if (
      (completionGrammarFor(spec, spelling).optionConflicts ?? []).some(
        ([candidateGroup, candidateOption]) =>
          candidateGroup === group && candidateOption === optionId,
      )
    ) {
      terms.push("$consumed -notcontains " + powershellQuote(optionId));
    }
  }
  return terms.join(" -and ");
}

function powershellArgumentAction(
  spec: CliCommandSpec,
  spelling: string | undefined,
  group: string,
  positional: boolean,
): string {
  const key = powershellArgumentKey(spec, group);
  const lines = [
    "if (" + powershellGroupAllowedCondition(spec, spelling, group) + ") {",
    "  $argumentSeen[" + powershellQuote(key) + "] = $true",
    "  $argumentCount++",
  ];
  if (positional) {
    lines.push("  $positionalCount++");
  }
  lines.push("} else { $invalidArgument = $true }");
  return lines.join("\n");
}

function powershellArgumentTokenCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const grammar = completionGrammarFor(spec, spelling);
        const lines = [
          "    " + powershellQuote(spelling) + " {",
          "      switch -Regex -CaseSensitive ($text) {",
        ];
        for (const pattern of completionWordPatterns(spec, spelling)) {
          const regex = pattern.wildcard
            ? "^" + powershellRegexEscape(pattern.word) + ".*$"
            : "^" + powershellRegexEscape(pattern.word) + "$";
          const action = powershellArgumentAction(
            spec,
            spelling,
            pattern.group,
            completionStaticGroupIsPositional(spec, spelling, pattern.group),
          );
          const validatedAction = pattern.valueRule
            ? "if (Test-ThreadleafCompletionValue " +
              powershellQuote(pattern.valueRule) +
              " $text.Substring($text.IndexOf('=') + 1)) { " +
              action +
              " } else { $invalidArgument = $true }"
            : action;
          lines.push("        " + powershellQuote(regex) + " { " + validatedAction + "; break }");
        }
        if (grammar.positionalMax === null) {
          const rejectedWordCondition = powershellRejectedWordCondition(spec, spelling);
          lines.push(
            rejectedWordCondition
              ? "        default { if (" +
                  rejectedWordCondition +
                  ") { $invalidArgument = $true } elseif ($text -cmatch '=') { $invalidArgument = $true } else { $argumentCount++ }; break }"
              : "        default { if ($text -cmatch '=') { $invalidArgument = $true } else { $argumentCount++ }; break }",
          );
        } else if (grammar.positionalMax > 0 && grammar.positionalGroup) {
          lines.push(
            completionPositionalGroupIsFinite(spec, spelling)
              ? "        default { $invalidArgument = $true; break }"
              : "        default { if ($text -cmatch '=') { $invalidArgument = $true } elseif (($positionalCount -lt " +
                  grammar.positionalMax +
                  ") -and " +
                  powershellGroupAllowedCondition(spec, spelling, grammar.positionalGroup) +
                  ") { " +
                  powershellArgumentAction(spec, spelling, grammar.positionalGroup, true) +
                  " } else { $invalidArgument = $true }; break }",
          );
        } else {
          lines.push("        default { $invalidArgument = $true; break }");
        }
        lines.push("      }");
        lines.push("      break");
        lines.push("    }");
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function powershellValidationCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const allowed = new Set(spec.id === "help" ? allOptionIds() : spec.globalOptions);
        const lines = ["    " + powershellQuote(spelling) + " {"];
        for (const option of cliGlobalOptions.filter((candidate) => !allowed.has(candidate.id))) {
          lines.push(
            "      if ($consumed -contains " +
              powershellQuote(option.id) +
              ") { $invalidOption = $true }",
          );
        }
        for (const [group, optionId] of completionGrammarFor(spec, spelling).optionConflicts ??
          []) {
          lines.push(
            "      if ($argumentSeen.ContainsKey(" +
              powershellQuote(powershellArgumentKey(spec, group)) +
              ") -and $consumed -contains " +
              powershellQuote(optionId) +
              ") { $invalidArgument = $true }",
          );
        }
        lines.push("      break", "    }");
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function powershellStaticCandidatesCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const lines = ["    " + powershellQuote(spelling) + " {"];
        for (const word of completionValuesFor(spec, spelling)) {
          const group = completionGroupFor(spec, spelling, word);
          lines.push(
            "      if (" +
              powershellGroupAllowedCondition(spec, spelling, group) +
              ") { $candidates += " +
              powershellQuote(word) +
              " }",
          );
        }
        lines.push("      break", "    }");
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function powershellOptionCandidatesCases(): string {
  return cliCommandSpecs
    .flatMap((spec) =>
      spec.names.map((spelling) => {
        const lines = ["        " + powershellQuote(spelling) + " {"];
        for (const optionId of spec.globalOptions) {
          const option = optionById.get(optionId);
          if (!option) continue;
          const condition = ["$consumed -notcontains " + powershellQuote(optionId)];
          if (optionId === "help" || spec.id === "help") {
            condition.push("$argumentCount -eq 0");
          }
          for (const group of grammarOptionConflictGroups(spec, spelling, optionId)) {
            condition.push(
              "-not $argumentSeen.ContainsKey(" +
                powershellQuote(powershellArgumentKey(spec, group)) +
                ")",
            );
          }
          lines.push(
            "          if (" +
              condition.join(" -and ") +
              ") { $candidates += @(" +
              option.names.map(powershellQuote).join(", ") +
              ") }",
          );
        }
        lines.push("          break", "        }");
        return lines.join("\n");
      }),
    )
    .join("\n");
}

function bashScript(): string {
  return [
    "# bash completion for Threadleaf (generated from the CLI schema)",
    ...shellValueValidationFunctions(),
    "_threadleaf_completion_impl() {",
    `  local cur="\${COMP_WORDS[COMP_CWORD]-}"`,
    '  local command=""',
    "  local candidates=()",
    "  local i token",
    "  local pending_value=0",
    "  local pending_nonempty=0",
    '  local pending_value_rule=""',
    "  local after_terminator=0",
    "  local invalid_option=0",
    "  local invalid_argument=0",
    "  local argument_count=0",
    "  local positional_count=0",
    ...cliGlobalOptions.map((option) => `  local ${shellOptionVariable(option.id)}_seen=0`),
    ...allGrammarVariables().map((variable) => `  local ${variable}=0`),
    "  COMPREPLY=()",
    "  compopt +o default 2>/dev/null || :",
    "  for ((i=1; i<COMP_CWORD; i++)); do",
    `    token="\${COMP_WORDS[i]}"`,
    "    if (( pending_value )); then",
    '      if [[ "$token" == --* ]]; then invalid_option=1; elif (( pending_nonempty )) && [[ -z "$token" ]]; then invalid_option=1; elif ! _threadleaf_completion_value_valid "$pending_value_rule" "$token"; then invalid_option=1; fi',
    '      pending_value=0; pending_nonempty=0; pending_value_rule=""; continue',
    "    fi",
    "    if (( after_terminator )); then",
    '      if [[ -z "$command" ]]; then command="$token"; else case "$command" in',
    bashArgumentTokenCases(),
    "      esac; fi",
    "      continue",
    "    fi",
    '    case "$token" in',
    "      --) after_terminator=1;;",
    bashOptionScanCases(),
    "      --permanent|--*) invalid_option=1;;",
    '      -*) [[ "$token" == "-" ]] || invalid_option=1;;',
    '      *) if [[ -z "$command" ]]; then command="$token"; else case "$command" in',
    bashArgumentTokenCases(),
    "      esac; fi;;",
    "    esac",
    "  done",
    '  case "$command" in',
    bashGrammarValidationCases(),
    "  esac",
    "  if (( pending_value || invalid_option || invalid_argument )); then",
    "    return 0",
    "  fi",
    "  if (( after_terminator )); then return 0; fi",
    '  if [[ "$cur" == "--" ]]; then return 0; fi',
    '  if [[ "$cur" == --* || "$cur" == -* ]]; then',
    '    case "$cur" in',
    valueOptionCurrentCases(),
    "    esac",
    "    if (( ! after_terminator )); then",
    '      case "$command" in',
    '        "")',
    bashRootOptionCandidates(),
    "          ;;",
    bashOptionCandidatesCase(),
    "      esac",
    "    fi",
    '  elif [[ -z "$command" ]]; then',
    bashRootCommandCandidates(),
    "  else",
    '    case "$command" in',
    bashStaticCandidatesCases(),
    "    esac",
    "    if (( ! after_terminator )); then",
    '      case "$command" in',
    bashOptionCandidatesCase(),
    "      esac",
    "    fi",
    "  fi",
    "  local candidate",
    `  for candidate in "\${candidates[@]}"; do`,
    `    [[ "$candidate" == "$cur"* ]] && COMPREPLY+=("$candidate")`,
    "  done",
    "}",
    "_threadleaf_completion() {",
    "  local _threadleaf_restore_nocasematch=0",
    "  if shopt -q nocasematch; then",
    "    _threadleaf_restore_nocasematch=1",
    "    shopt -u nocasematch",
    "  fi",
    "  _threadleaf_completion_impl",
    "  local _threadleaf_completion_status=$?",
    "  if (( _threadleaf_restore_nocasematch )); then shopt -s nocasematch; fi",
    "  return $_threadleaf_completion_status",
    "}",
    "complete -o nosort -F _threadleaf_completion threadleaf",
    "",
  ].join("\n");
}

function zshScript(): string {
  return [
    "#compdef threadleaf",
    "# zsh completion for Threadleaf (generated from the CLI schema)",
    ...shellValueValidationFunctions(),
    "_threadleaf() {",
    '  local command=""',
    "  local -a candidates=()",
    "  local i token cur",
    "  local pending_value=0",
    "  local pending_nonempty=0",
    '  local pending_value_rule=""',
    "  local after_terminator=0",
    "  local invalid_option=0",
    "  local invalid_argument=0",
    "  local argument_count=0",
    "  local positional_count=0",
    ...cliGlobalOptions.map((option) => `  local ${shellOptionVariable(option.id)}_seen=0`),
    ...allGrammarVariables().map((variable) => `  local ${variable}=0`),
    "  for ((i=2; i<CURRENT; i++)); do",
    `    token="\${words[i]}"`,
    "    if (( pending_value )); then",
    '      if [[ "$token" == --* ]]; then invalid_option=1; elif (( pending_nonempty )) && [[ -z "$token" ]]; then invalid_option=1; elif ! _threadleaf_completion_value_valid "$pending_value_rule" "$token"; then invalid_option=1; fi',
    '      pending_value=0; pending_nonempty=0; pending_value_rule=""; continue',
    "    fi",
    "    if (( after_terminator )); then",
    '      if [[ -z "$command" ]]; then command="$token"; else case "$command" in',
    zshArgumentTokenCases(),
    "      esac; fi",
    "      continue",
    "    fi",
    '    case "$token" in',
    "      --) after_terminator=1;;",
    zshOptionScanCases(),
    "      --permanent|--*) invalid_option=1;;",
    '      -*) [[ "$token" == "-" ]] || invalid_option=1;;',
    '      *) if [[ -z "$command" ]]; then command="$token"; else case "$command" in',
    zshArgumentTokenCases(),
    "      esac; fi;;",
    "    esac",
    "  done",
    '  case "$command" in',
    zshGrammarValidationCases(),
    "  esac",
    "  if (( pending_value || invalid_option || invalid_argument )); then",
    "    return 0",
    "  fi",
    "  if (( after_terminator )); then return 0; fi",
    `  cur="\${words[CURRENT]-}"`,
    '  if [[ "$cur" == "--" ]]; then return 0; fi',
    '  if [[ "$cur" == --* || "$cur" == -* ]]; then',
    '    case "$cur" in',
    valueOptionCurrentCases(),
    "    esac",
    "    if (( ! after_terminator )); then",
    '      case "$command" in',
    '        "")',
    zshRootOptionCandidates(),
    "          ;;",
    zshOptionCandidatesCase(),
    "      esac",
    "    fi",
    '  elif [[ -z "$command" ]]; then',
    zshRootCommandCandidates(),
    "  else",
    '    case "$command" in',
    zshStaticCandidatesCases(),
    "    esac",
    "    if (( ! after_terminator )); then",
    '      case "$command" in',
    zshOptionCandidatesCase(),
    "      esac",
    "    fi",
    "  fi",
    `  if (( \${#candidates[@]} == 0 )); then return 0; fi`,
    "  local candidate",
    "  local -a filtered=()",
    `  for candidate in "\${candidates[@]}"; do`,
    '    [[ "$candidate" == "$cur"* ]] || continue',
    '    filtered+=("$candidate")',
    "  done",
    `  candidates=("\${filtered[@]}")`,
    `  (( \${#candidates[@]} == 0 )) && return 0`,
    "  _describe 'threadleaf' candidates",
    "}",
    "compdef _threadleaf threadleaf",
    "",
  ].join("\n");
}

function fishScript(): string {
  const commandNames = allCommandNames();
  const allIds = allOptionIds();
  const optionIdFunction = cliGlobalOptions
    .flatMap((option) =>
      option.names.map((name) => {
        const exact = [
          `  if test "$token" = ${fishQuote(name)}`,
          `    echo ${fishQuote(option.id)}`,
          "    return 0",
          "  end",
        ];
        if (option.takesValue && name.startsWith("--")) {
          exact.push(
            `  if string match -q -- ${fishQuote(`${name}=*`)} "$token"`,
            `    echo ${fishQuote(option.id)}`,
            "    return 0",
            "  end",
          );
        }
        return exact.join("\n");
      }),
    )
    .join("\n");
  const commandCases = cliCommandSpecs
    .map((spec) => {
      const aliases = spec.names.map(fishQuote).join(" ");
      const ids = (spec.id === "help" ? allIds : spec.globalOptions).map(fishQuote).join(" ");
      return "    case " + aliases + "\n      set allowed " + ids;
    })
    .join("\n");
  const staticLines = cliCommandSpecs.flatMap((spec) =>
    spec.names.flatMap((name) =>
      completionValuesFor(spec, name).map((word) => {
        const group = completionGroupFor(spec, name, word);
        const condition = "__threadleaf_fish_static_allowed " + name + " " + group;
        return (
          "complete -c threadleaf -f -n " + fishCondition(condition) + " -a " + fishQuote(word)
        );
      }),
    ),
  );
  const optionValueCases = cliGlobalOptions
    .filter((option) => option.takesValue)
    .map(
      (option) =>
        "    case " +
        fishQuote(option.id) +
        "\n      __threadleaf_fish_value_valid " +
        fishQuote(completionOptionValueRule(option.id)) +
        ' "$value"',
    );
  const grammarState = [
    "function __threadleaf_fish_state",
    '  set -l mode "$argv[1]"',
    '  set -l wanted ""',
    '  if test (count $argv) -gt 1; set wanted "$argv[2]"; end',
    '  set -l command ""',
    "  set -l pending 0",
    '  set -l pending_id ""',
    "  set -l terminator 0",
    "  set -l invalid 0",
    "  set -l argument_count 0",
    "  set -l positional_count 0",
    "  set -l seen",
    "  set -l consumed",
    "  set -l skip_command 1",
    "  for token in (commandline -opc)",
    "    if test $skip_command -eq 1",
    "      set skip_command 0",
    "      continue",
    "    end",
    "    if test $pending -eq 1",
    '      if string match -q -- "--*" "$token"; set invalid 1; end',
    '      if not string match -q -- "--*" "$token"; and not __threadleaf_fish_option_value_valid "$pending_id" "$token"; set invalid 1; end',
    "      set pending 0",
    '      set pending_id ""',
    "      continue",
    "    end",
    "    if test $terminator -eq 1",
    '      if test -z "$command"; set command "$token"; else',
    '        switch "$command"',
    fishArgumentTokenCases(),
    "        end",
    "      end",
    "      continue",
    "    end",
    '    if test "$token" = "--"',
    "      set terminator 1",
    "      continue",
    "    end",
    '    set -l id (__threadleaf_fish_option_id "$token")',
    "    if test (count $id) -gt 0",
    '      if __threadleaf_fish_has_empty_inline_value "$token"; set invalid 1; end',
    '      if __threadleaf_fish_has_inline_value "$token"',
    "        set -l inline_value (string replace -r '^[^=]*=' '' -- \"$token\")",
    '        if not __threadleaf_fish_option_value_valid "$id" "$inline_value"; set invalid 1; end',
    "      end",
    '      if contains -- "$id" $consumed; and test "$id" != "json"; and test "$id" != "help"; set invalid 1; end',
    "      set -a consumed $id",
    '      if __threadleaf_fish_takes_value "$id"; and not __threadleaf_fish_has_inline_value "$token"',
    "        set pending 1",
    '        set pending_id "$id"',
    "      end",
    '      if test "$id" = "help"',
    '        if test -n "$command"; and test "$command" != "help"',
    "          if test $argument_count -gt 0; set invalid 1; end",
    "          set -a seen topic",
    "          set argument_count (math $argument_count + 1)",
    "          set positional_count (math $positional_count + 1)",
    "        end",
    '        set command "help"',
    "      end",
    "      continue",
    "    end",
    '    if test "$token" = "--permanent"; set invalid 1; continue; end',
    '    if string match -q -- "--*" "$token"; set invalid 1; continue; end',
    '    if string match -q -- "-*" "$token"; and test "$token" != "-"; set invalid 1; continue; end',
    '    if test -z "$command"; set command "$token"; else',
    '      switch "$command"',
    fishArgumentTokenCases(),
    "      end",
    "    end",
    "  end",
    '  switch "$command"',
    fishOptionValidationCases(),
    "  end",
    '  switch "$mode"',
    "    case command",
    '      test -n "$command"; and echo "$command"',
    "    case pending",
    "      test $pending -eq 1",
    "    case invalid",
    "      test $invalid -eq 1",
    "    case terminator",
    "      test $terminator -eq 1",
    "    case help-option",
    "      test $argument_count -eq 0",
    "    case seen",
    '      contains -- "$wanted" $seen',
    "  end",
    "end",
    "",
  ];
  const lines = [
    "# fish completion for Threadleaf (generated from the CLI schema)",
    "complete -c threadleaf -f",
    "",
    ...fishValueValidationFunctions(),
    "function __threadleaf_fish_option_value_valid",
    '  set -l id "$argv[1]"',
    '  set -l value "$argv[2]"',
    '  switch "$id"',
    ...optionValueCases,
    "    case '*'",
    "      return 1",
    "  end",
    "end",
    "",
    "function __threadleaf_fish_option_id",
    '  set -l token "$argv[1]"',
    optionIdFunction,
    "  return 1",
    "end",
    "",
    "function __threadleaf_fish_takes_value",
    '  contains -- "$argv[1]" vault directory limit content to name',
    "end",
    "",
    "function __threadleaf_fish_has_inline_value",
    '  set -l token "$argv[1]"',
    ...cliGlobalOptions
      .filter((option) => option.takesValue)
      .flatMap((option) =>
        option.names
          .filter((name) => name.startsWith("--"))
          .map((name) =>
            [
              `  if string match -q -- ${fishQuote(`${name}=*`)} "$token"`,
              "    return 0",
              "  end",
            ].join("\n"),
          ),
      ),
    "  return 1",
    "end",
    "",
    "function __threadleaf_fish_has_empty_inline_value",
    '  set -l token "$argv[1]"',
    ...cliGlobalOptions
      .filter((option) => option.takesValue && !option.allowEmptyValue)
      .flatMap((option) =>
        option.names
          .filter((name) => name.startsWith("--"))
          .map((name) => `  if test "$token" = ${fishQuote(`${name}=`)}; return 0; end`),
      ),
    "  return 1",
    "end",
    "",
    "function __threadleaf_fish_allows_empty_value",
    '  test "$argv[1]" = "content"',
    "end",
    "",
    "function __threadleaf_fish_current_value_option",
    "  set -l current (commandline -ct)",
    ...cliGlobalOptions
      .filter((option) => option.takesValue)
      .flatMap((option) =>
        option.names
          .filter((name) => name.startsWith("--"))
          .map(
            (name) =>
              `  if test "$current" = ${fishQuote(name)}; or string match -q -- ${fishQuote(`${name}=*`)} "$current"; return 0; end`,
          ),
      ),
    "  return 1",
    "end",
    "",
    ...grammarState,
    "function __threadleaf_fish_option_consumed",
    '  set -l wanted "$argv[1]"',
    "  set -l pending 0",
    "  set -l skip_command 1",
    "  for token in (commandline -opc)",
    "    if test $skip_command -eq 1",
    "      set skip_command 0",
    "      continue",
    "    end",
    "    if test $pending -eq 1",
    "      set pending 0",
    "      continue",
    "    end",
    '    if test "$token" = "--"; return 1; end',
    '    set -l id (__threadleaf_fish_option_id "$token")',
    "    if test (count $id) -gt 0",
    '      if test "$id" = "$wanted"; return 0; end',
    '      if __threadleaf_fish_takes_value "$id"; and not __threadleaf_fish_has_inline_value "$token"; set pending 1; end',
    "    end",
    "  end",
    "  return 1",
    "end",
    "",
    "function __threadleaf_fish_option_conflict",
    '  set -l wanted "$argv[1]"',
    "  set -l command (__threadleaf_fish_state command)",
    '  switch "$command"',
    fishOptionConflictCases(),
    "  end",
    "  return 1",
    "end",
    "",
    "function __threadleaf_fish_static_allowed",
    '  set -l wanted_command "$argv[1]"',
    '  set -l wanted "$argv[2]"',
    "  if __threadleaf_fish_state pending; return 1; end",
    "  if __threadleaf_fish_state invalid; return 1; end",
    "  if __threadleaf_fish_state terminator; return 1; end",
    "  set -l command (__threadleaf_fish_state command)",
    '  test "$command" = "$wanted_command"; or return 1',
    '  if __threadleaf_fish_state seen "$wanted"; return 1; end',
    '  switch "$command"',
    fishStaticConflictCases(),
    "  end",
    "  return 0",
    "end",
    "",
    "function __threadleaf_fish_option_allowed",
    '  set -l wanted "$argv[1]"',
    '  if test "$(commandline -ct)" = "--"; return 1; end',
    "  if __threadleaf_fish_state pending; return 1; end",
    "  if __threadleaf_fish_state invalid; return 1; end",
    "  if __threadleaf_fish_state terminator; return 1; end",
    "  if __threadleaf_fish_current_value_option; return 1; end",
    "  set -l command (__threadleaf_fish_state command)",
    '  if test "$wanted" = "help"; and not __threadleaf_fish_state help-option; return 1; end',
    '  if test "$command" = "help"; and not __threadleaf_fish_state help-option; return 1; end',
    "  set -l allowed",
    '  if test -z "$command"',
    `    set allowed ${allIds.map(fishQuote).join(" ")}`,
    "  else",
    '    switch "$command"',
    commandCases,
    "      case '*'; return 1",
    "    end",
    "  end",
    '  __threadleaf_fish_option_conflict "$wanted"; and return 1',
    '  contains -- "$wanted" $allowed; or return 1',
    '  __threadleaf_fish_option_consumed "$wanted"; and return 1',
    "  return 0",
    "end",
    "",
    "function __threadleaf_fish_can_offer_command",
    '  set -l wanted "$argv[1]"',
    "  if __threadleaf_fish_state pending; return 1; end",
    "  if __threadleaf_fish_state invalid; return 1; end",
    "  if __threadleaf_fish_state terminator; return 1; end",
    "  set -l command (__threadleaf_fish_state command)",
    '  test -z "$command"; or return 1',
    '  switch "$wanted"',
    fishCommandAllowedCases(),
    "    case '*'",
    "      return 1",
    "  end",
    "end",
    "",
    "function __threadleaf_fish_command_is",
    "  if __threadleaf_fish_state pending; return 1; end",
    "  if __threadleaf_fish_state invalid; return 1; end",
    "  set -l command (__threadleaf_fish_state command)",
    '  test -n "$command"; and contains -- "$command" $argv',
    "end",
    "",
    ...commandNames.map(
      (name) =>
        `complete -c threadleaf -f -n ${fishCondition(`__threadleaf_fish_can_offer_command ${name}`)} -a ${fishQuote(name)}`,
    ),
  ];
  for (const option of cliGlobalOptions) {
    const names = option.names;
    const condition = fishCondition(`__threadleaf_fish_option_allowed ${option.id}`);
    lines.push(
      [
        "complete -c threadleaf -f",
        `-n ${condition}`,
        `-a "${names.join(" ")}"`,
        option.takesValue ? "-r" : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }
  lines.push(...staticLines);
  lines.push("");
  return lines.join("\n");
}

function powershellScript(): string {
  const commandNames = allCommandNames();
  const commandCases = powershellStaticCandidatesCases();
  const optionCandidateCases = powershellOptionCandidatesCases();
  const optionNames = cliGlobalOptions
    .map(
      (option) =>
        `    ${powershellQuote(option.id)} = @(${option.names.map(powershellQuote).join(", ")})`,
    )
    .join("\n");
  const optionTakesValue = cliGlobalOptions
    .map(
      (option) => `    ${powershellQuote(option.id)} = ${option.takesValue ? "$true" : "$false"}`,
    )
    .join("\n");
  const optionTokenCases = cliGlobalOptions
    .flatMap((option) =>
      option.names.map((name) => {
        const pattern =
          option.takesValue && name.startsWith("--") ? `^${name}(?:=.*)?$` : `^${name}$`;
        return `      ${powershellQuote(pattern)} { $optionId = ${powershellQuote(option.id)}; break }`;
      }),
    )
    .join("\n");
  const optionValueRuleCases = cliGlobalOptions
    .filter((option) => option.takesValue)
    .map(
      (option) =>
        "    " +
        powershellQuote(option.id) +
        " { return Test-ThreadleafCompletionValue " +
        powershellQuote(completionOptionValueRule(option.id)) +
        " $Value }",
    );
  return [
    "# PowerShell completion for Threadleaf (generated from the CLI schema)",
    ...powershellValueValidationFunctions(),
    ...powershellCommandAllowedFunction(),
    "function Test-ThreadleafCompletionOptionValue {",
    "  param([string]$OptionId, [string]$Value)",
    "  switch -CaseSensitive ($OptionId) {",
    ...optionValueRuleCases,
    "  }",
    "  return $false",
    "}",
    "Register-ArgumentCompleter -CommandName threadleaf -ScriptBlock {",
    "  param($wordToComplete, $commandAst, $cursorPosition)",
    "  function ConvertTo-ThreadleafCompletionText {",
    "    param([string]$text)",
    "    if ($text.Length -ge 2) {",
    "      $first = $text[0]",
    "      $last = $text[$text.Length - 1]",
    "      if (($first -eq \"'\" -and $last -eq \"'\") -or ($first -eq '\"' -and $last -eq '\"')) {",
    "        return $text.Substring(1, $text.Length - 2)",
    "      }",
    "    }",
    "    $equals = $text.IndexOf('=')",
    "    if ($equals -gt 0 -and $equals -lt ($text.Length - 1)) {",
    "      $value = $text.Substring($equals + 1)",
    "      if ($value.Length -eq 2) {",
    "        $firstValue = $value[0]",
    "        $lastValue = $value[1]",
    "        if (($firstValue -eq \"'\" -and $lastValue -eq \"'\") -or ($firstValue -eq '\"' -and $lastValue -eq '\"')) {",
    "          return $text.Substring(0, $equals + 1)",
    "        }",
    "      }",
    "    }",
    "    return $text",
    "  }",
    `  $allCommands = @(${commandNames.map(powershellQuote).join(",")})`,
    "  $optionNames = @{",
    optionNames,
    "  }",
    "  $optionTakesValue = @{",
    optionTakesValue,
    "  }",
    `  $allOptionIds = @(${allOptionIds().map(powershellQuote).join(", ")})`,
    "  $command = $null",
    "  $pendingValue = $false",
    "  $pendingOptionId = $null",
    "  $afterTerminator = $false",
    "  $invalidOption = $false",
    "  $invalidArgument = $false",
    "  $argumentCount = 0",
    "  $positionalCount = 0",
    "  $argumentSeen = @{}",
    "  $consumed = @()",
    "  foreach ($element in @($commandAst.CommandElements | Select-Object -Skip 1)) {",
    "    if ($element.Extent.EndOffset -ge $cursorPosition) { continue }",
    "    $text = ConvertTo-ThreadleafCompletionText $element.Extent.Text",
    "    if ($pendingValue) {",
    "      if ($text.StartsWith('--') -or (-not (Test-ThreadleafCompletionOptionValue $pendingOptionId $text))) { $invalidOption = $true }",
    "      $pendingValue = $false; $pendingOptionId = $null; continue",
    "    }",
    "    if ($afterTerminator) {",
    "      if ($null -eq $command) { $command = $text } else { switch -CaseSensitive ($command) {",
    powershellArgumentTokenCases(),
    "      } }",
    "      continue",
    "    }",
    "    if ($text -eq '--') { $afterTerminator = $true; continue }",
    "    $optionId = $null",
    "    switch -Regex -CaseSensitive ($text) {",
    optionTokenCases,
    "    }",
    "    if ($null -ne $optionId) {",
    "      if ($consumed -contains $optionId -and $optionId -ne 'json' -and $optionId -ne 'help') { $invalidOption = $true }",
    "      if ($consumed -notcontains $optionId) { $consumed += $optionId }",
    "      if ($optionTakesValue[$optionId] -and $text -cmatch '^--[^=]+=$' -and $optionId -ne 'content') { $invalidOption = $true }",
    "      if ($optionTakesValue[$optionId] -and $text -cmatch '=') { $inlineValue = $text.Substring($text.IndexOf('=') + 1); if (-not (Test-ThreadleafCompletionOptionValue $optionId $inlineValue)) { $invalidOption = $true } }",
    "      if ($optionTakesValue[$optionId] -and $text -cnotmatch '=') { $pendingValue = $true; $pendingOptionId = $optionId }",
    "      if ($optionId -eq 'help') {",
    "        if ($null -ne $command -and $command -ne 'help') { if ($argumentCount -gt 0) { $invalidArgument = $true }; $argumentSeen['help:topic'] = $true; $argumentCount++; $positionalCount++ }",
    "        $command = 'help'",
    "      }",
    "      continue",
    "    }",
    "    if ($text -eq '--permanent' -or $text.StartsWith('--') -or ($text.StartsWith('-') -and $text -ne '-')) { $invalidOption = $true; continue }",
    "    if ($null -eq $command) { $command = $text } else { switch -CaseSensitive ($command) {",
    powershellArgumentTokenCases(),
    "    } }",
    "  }",
    "  switch -CaseSensitive ($command) {",
    powershellValidationCases(),
    "  }",
    "  if ($pendingValue -or $invalidOption -or $invalidArgument) { return }",
    "  if ($afterTerminator) { return }",
    "  $wordToComplete = ConvertTo-ThreadleafCompletionText $wordToComplete",
    "  if ($wordToComplete -eq '--') { return }",
    "  $candidates = @()",
    "  foreach ($candidate in $allCommands) {",
    "    if (Test-ThreadleafCommandAllowsConsumedOptions $candidate $consumed) { $candidates += $candidate }",
    "  }",
    "  if ($wordToComplete.StartsWith('-')) {",
    ...cliGlobalOptions
      .filter((option) => option.takesValue)
      .flatMap((option) =>
        option.names
          .filter((name) => name.startsWith("--"))
          .map(
            (name) =>
              `    if ($wordToComplete -cmatch ${powershellQuote(`^${name}(?:=.*)?$`)}) { return }`,
          ),
      ),
    "    $candidates = @()",
    "    if (-not $afterTerminator) {",
    "      $allowedOptionIds = if ($null -eq $command) { $allOptionIds } else { @() }",
    "      if ($null -ne $command) {",
    "        switch -CaseSensitive ($command) {",
    optionCandidateCases,
    "        }",
    "      }",
    "      if ($null -eq $command) { foreach ($optionId in $allOptionIds) { if ($consumed -notcontains $optionId) { $candidates += $optionNames[$optionId] } } }",
    "    }",
    "  } elseif ($null -ne $command) {",
    "    $candidates = @()",
    "    switch -CaseSensitive ($command) {",
    commandCases,
    "    }",
    "    if (-not $afterTerminator) {",
    "      switch -CaseSensitive ($command) {",
    optionCandidateCases,
    "      }",
    "    }",
    "  }",
    "  foreach ($candidate in $candidates) {",
    "    if ($candidate.StartsWith($wordToComplete, [System.StringComparison]::Ordinal)) {",
    "      [System.Management.Automation.CompletionResult]::new($candidate, $candidate, 'ParameterValue', $candidate)",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}

export function generateCliCompletion(shell: CliShell): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    case "powershell":
      return powershellScript();
  }
}

export function parseCliShell(value: string): CliShell | null {
  return (cliShells as readonly string[]).includes(value) ? (value as CliShell) : null;
}

export function completionWordsForCommand(name: string): readonly string[] {
  const spec = commandSpec(name);
  return spec ? completionWordsFor(spec, name) : [];
}

/** Static, vault-independent candidates emitted for one parser spelling. */
export function completionStaticWordsForCommand(name: string): readonly string[] {
  const spec = commandSpec(name);
  return spec ? completionStaticWordsFor(spec, name) : [];
}
