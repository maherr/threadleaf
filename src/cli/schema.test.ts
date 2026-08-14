import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliExitCodes, parseCliArguments, runCli } from "./command-line";
import {
  cliCommandSpecs,
  cliGlobalOptions,
  cliHelpTopics,
  cliShells,
  cliUsageLines,
  commandAllowsConsumedOptions,
  completionStaticWordsForCommand,
  completionWordsForCommand,
  generateCliCompletion,
  parseCliOptionToken,
  quoteCompletionToken,
  renderCliHelp,
} from "./schema";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runShell(shell: string, scriptPath: string, command: string, cwd: string) {
  const result = spawnSync(shell, ["-c", `source ${shellQuote(scriptPath)}; ${command}`], {
    cwd,
    encoding: "utf8",
  });
  expect(result.status, `${shell} fixture failed: ${result.stderr}`).toBe(0);
  expect(result.stderr, `${shell} fixture wrote stderr`).toBe("");
  return result.stdout.trimEnd().split("\n").filter(Boolean);
}

function runShellAsync(
  shell: string,
  scriptPath: string,
  command: string,
  cwd: string,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-c", `source ${shellQuote(scriptPath)}; ${command}`], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0 || stderr !== "") {
        reject(new Error(`${shell} fixture failed (${status}): ${stderr}`));
        return;
      }
      resolve(stdout.trimEnd().split("\n").filter(Boolean));
    });
  });
}

function bashCompletionCommand(words: readonly string[]): string {
  return [
    `COMP_WORDS=(${words.map(shellQuote).join(" ")})`,
    `COMP_CWORD=${words.length - 1}`,
    "_threadleaf_completion",
    "printf '%s\\n' \"${" + 'COMPREPLY[@]}"',
  ].join("; ");
}

function fishCompletionCommand(line: string): string {
  return `complete -C ${shellQuote(line)}`;
}

function completionCandidateToken(word: string): string {
  if (!word.endsWith("=")) {
    return word;
  }
  const key = word.slice(0, -1);
  const values: Record<string, string> = {
    content: "fixture content",
    "date-format": "YYYY-MM-DD",
    directory: "Notes",
    ext: "md",
    file: "Note.md",
    filter: "community",
    folder: "Notes",
    format: "YYYY-MM-DD",
    id: "fixture-plugin",
    info: "files",
    limit: "5",
    line: "1",
    name: "Note",
    path: "Note.md",
    query: "needle",
    ref: "Note.md:1",
    status: "?",
    template: "Templates/Daily.md",
    "time-format": "HH:mm",
    title: "Title",
    to: "Archive/Note.md",
    value: "fixture",
  };
  return word + (values[key] ?? "fixture");
}

function completionCommandPrefix(
  spec: (typeof cliCommandSpecs)[number],
  spelling: string,
): string[] {
  return [...(spec.requiresVault ? ["--vault", "/vault"] : []), spelling];
}

function isTargetCandidate(commandId: string, word: string): boolean {
  if (commandId === "folder") {
    return word === "path=";
  }
  if (commandId === "create" || commandId === "template.read") {
    return word === "path=" || word === "name=";
  }
  if (commandId === "task") {
    return word === "path=" || word === "file=";
  }
  if (
    [
      "file",
      "wordcount",
      "read",
      "links",
      "backlinks",
      "outline",
      "append",
      "prepend",
      "move",
      "rename",
      "delete",
      "restore",
      "properties",
      "property.read",
      "property.set",
      "property.remove",
      "aliases",
      "tags",
    ].includes(commandId)
  ) {
    return word === "path=" || word === "file=";
  }
  return false;
}

function completionCandidateArgs(
  spec: (typeof cliCommandSpecs)[number],
  spelling: string,
  word: string,
): string[] {
  const command = completionCommandPrefix(spec, spelling);
  const candidate = completionCandidateToken(word);
  const target = ["path=Note.md"];
  const content = ["content=fixture content"];
  switch (spec.id) {
    case "help":
    case "completion":
    case "vault.info":
    case "files":
    case "folders":
    case "daily":
    case "daily.path":
    case "daily.read":
    case "tasks":
    case "aliases":
    case "tags":
    case "plugins":
    case "themes":
    case "snippets":
    case "random.read":
      return [...command, candidate];
    case "folder":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate]
        : [...command, ...target, candidate];
    case "wordcount":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate]
        : [...command, "Note.md", candidate];
    case "file":
    case "read":
    case "delete":
    case "restore":
    case "properties":
      return [...command, candidate];
    case "links":
    case "backlinks":
    case "outline":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate]
        : [...command, ...target, candidate];
    case "search":
    case "search.context":
      return word === "query=" ? [...command, candidate] : [...command, "query=needle", candidate];
    case "create":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate]
        : [...command, "Note.md", candidate];
    case "daily.append":
    case "daily.prepend":
      return word === "content=" ? [...command, candidate] : [...command, ...content, candidate];
    case "append":
    case "prepend":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate, ...content]
        : word === "inline"
          ? [...command, ...target, ...content, candidate]
          : [...command, ...target, candidate];
    case "move":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate, "to=Archive/Note.md"]
        : [...command, ...target, candidate];
    case "rename":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate, "name=Renamed"]
        : [...command, ...target, candidate];
    case "trash.list":
      return [...command, candidate];
    case "property.read":
    case "property.remove":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate, "name=status"]
        : [...command, ...target, candidate];
    case "property.set":
      if (isTargetCandidate(spec.id, word)) {
        return [...command, candidate, "name=priority", "value=4"];
      }
      if (word === "name=") {
        return [...command, ...target, candidate, "value=4"];
      }
      if (word === "value=") {
        return [...command, ...target, "name=priority", candidate];
      }
      return [...command, ...target, "name=priority", "value=4", candidate];
    case "task":
      if (word === "ref=") {
        return [...command, candidate];
      }
      if (word === "path=" || word === "file=") {
        return [...command, candidate, "line=1"];
      }
      if (word === "line=") {
        return [...command, "path=Note.md", candidate];
      }
      if (word === "daily") {
        return [...command, candidate, "line=1"];
      }
      return [...command, "path=Note.md", "line=1", candidate];
    case "tag":
      return word === "name=" ? [...command, candidate] : [...command, "name=fixture", candidate];
    case "template.read":
      return isTargetCandidate(spec.id, word)
        ? [...command, candidate]
        : [...command, "name=Template", candidate];
    case "plugin":
    case "theme":
      return [...command, candidate];
    case "port.scaffold":
      // Unlike port.inspect/port.ci (whose single path= candidate is already a complete
      // invocation), scaffold also requires a kind literal and --output; every static candidate
      // must be completed into a full <kind> <target> --output <dir> invocation to parse.
      return word === "path="
        ? [...command, "native", candidate, "--output", "/tmp/threadleaf-scaffold-output"]
        : [...command, candidate, ...target, "--output", "/tmp/threadleaf-scaffold-output"];
    default:
      return [...command, candidate];
  }
}

// Specs are static for the process lifetime, so the parser-valid suffix for a
// given (spec, spelling) pair never changes. Root states repeatedly complete
// the same command spellings, and each lookup here reruns a parser-oracle
// search; memoizing removes that redundant work from the sweep's hot path.
const parserValidSuffixCache = new Map<(typeof cliCommandSpecs)[number], Map<string, string[]>>();

function parserValidSuffixForCommand(
  spec: (typeof cliCommandSpecs)[number],
  spelling: string,
): string[] {
  let bySpelling = parserValidSuffixCache.get(spec);
  if (!bySpelling) {
    bySpelling = new Map();
    parserValidSuffixCache.set(spec, bySpelling);
  }
  const cached = bySpelling.get(spelling);
  if (cached) {
    return cached;
  }
  const prefix = completionCommandPrefix(spec, spelling);
  const parserCandidates = [
    prefix,
    ...completionStaticWordsForCommand(spelling).map((word) =>
      completionCandidateArgs(spec, spelling, word),
    ),
  ];
  const accepted = parserCandidates.find(parserAccepts);
  if (!accepted) {
    throw new Error(`No parser-valid completion suffix for ${spelling}`);
  }
  const suffix = accepted.slice(prefix.length);
  bySpelling.set(spelling, suffix);
  return suffix;
}

interface CompletionState {
  args: string[];
  label: string;
}

function parserAccepts(args: readonly string[]): boolean {
  try {
    parseCliArguments(args);
    return true;
  } catch {
    return false;
  }
}

interface LiteralParserOracleCase {
  args: string[];
  accepted: boolean;
  terminal?: boolean;
  label: string;
}

// Keep these as literal argv histories. The runtime oracle below deliberately
// does not repair missing or malformed values before asking the real parser
// and generated completion scripts what they do with the exact history.
const literalParserOracleCases: readonly LiteralParserOracleCase[] = [
  {
    args: ["--vault", "/v", "search", "query=needle", "--limit"],
    accepted: false,
    label: "pending option value",
  },
  {
    args: ["--vault", "/v", "search", "query=needle", "--limit=0"],
    accepted: false,
    label: "malformed option value",
  },
  { args: ["--vault=", "vault"], accepted: false, label: "empty option value" },
  {
    args: ["--vault", "/v", "search", "query="],
    accepted: false,
    label: "empty static value",
  },
  {
    args: ["--vault", "/v", "files", "folder="],
    accepted: false,
    label: "empty static key value",
  },
  {
    args: ["--vault", "/v", "search", "query=needle", "path=Notes", "--directory", "Notes"],
    accepted: false,
    label: "static/global conflict",
  },
  {
    args: ["--vault", "/v", "search", "query=needle", "--limit=1", "--limit=2"],
    accepted: false,
    label: "duplicate option",
  },
  { args: ["--vault", "/v", "SEARCH"], accepted: false, label: "case-sensitive command" },
  { args: ["completion", "BASH"], accepted: false, label: "case-sensitive completion" },
  {
    args: ["completion", "bash", "extra"],
    accepted: false,
    label: "completion terminal state",
  },
  { args: ["--help", "search"], accepted: true, terminal: true, label: "help terminal state" },
  { args: ["completion", "bash"], accepted: true, label: "completion terminal option state" },
  {
    args: ["--vault", "/v", "read", "Note"],
    accepted: true,
    label: "read consumed target option state",
  },
  {
    args: ["--vault", "/v", "create", "Note", "--content="],
    accepted: true,
    label: "empty content allowed by schema",
  },
  {
    args: ["--vault", "/v", "search", "query=needle"],
    accepted: true,
    label: "static value continuation",
  },
];

function completionStates(): CompletionState[] {
  const states = new Map<string, CompletionState>();
  const add = (args: string[], label: string): void => {
    if (!parserAccepts(args)) return;
    // Values do not change parser state in this corpus. Collapse them to
    // their parameter prefix so one representative exercises each grammar
    // state instead of launching hundreds of equivalent shell parses.
    const key = JSON.stringify(
      args.map((arg) => {
        const equals = arg.indexOf("=");
        return equals > 0 ? arg.slice(0, equals + 1) : arg;
      }),
    );
    if (!states.has(key)) states.set(key, { args, label });
  };

  // Root option states exercise global options before a command is known. A
  // vault-bearing root also lets the command-specific states remain fully
  // executable without opening a real vault.
  add([], "root");
  add(["--vault", "/vault"], "root with vault");
  for (const spec of cliCommandSpecs) {
    for (const spelling of spec.names) {
      add(completionCommandPrefix(spec, spelling), spelling);
      for (const word of completionStaticWordsForCommand(spelling)) {
        add(completionCandidateArgs(spec, spelling, word), `${spelling} ${word}`);
      }
    }
  }
  return [...states.values()];
}

function completionInvocationWords(state: CompletionState, current: string): string[] {
  return ["threadleaf", ...state.args, current];
}

function rootStateHasOption(state: CompletionState, optionId: string): boolean {
  return state.args.some((token) => parseCliOptionToken(token)?.id === optionId);
}

function completionCandidateArgsForState(state: CompletionState, candidate: string): string[] {
  if (state.label.startsWith("root") && !candidate.startsWith("-")) {
    const spec = cliCommandSpecs.find((item) => item.names.includes(candidate));
    if (spec) {
      const vault =
        spec.requiresVault && !rootStateHasOption(state, "vault") ? ["--vault", "/vault"] : [];
      return [...state.args, candidate, ...vault, ...parserValidSuffixForCommand(spec, candidate)];
    }
  }
  return [...state.args, candidate];
}

function completionCandidateIsParserPrefix(candidate: string): boolean {
  if (candidate.endsWith("=")) return true;
  const option = parseCliOptionToken(candidate);
  return (
    option !== null &&
    option.inlineValue === null &&
    (cliGlobalOptions.find((item) => item.id === option.id)?.takesValue ?? false)
  );
}

/**
 * Materializes a parser-prefix candidate (a bare value-taking option or a
 * `key=` prefix) into the args the real parser would see once a value is
 * chosen, so the sweep can assert the completed form is still accepted.
 */
function completionOptionArgsForCheck(token: string): string[] {
  if (token.endsWith("=")) {
    return [completionCandidateToken(token)];
  }
  const option = parseCliOptionToken(token);
  if (
    !option ||
    option.inlineValue !== null ||
    !cliGlobalOptions.find((item) => item.id === option.id)?.takesValue
  ) {
    return [token];
  }
  const values: Record<string, string> = {
    vault: "/vault",
    directory: "Notes",
    limit: "5",
    content: "fixture content",
    to: "Archive/Note.md",
    name: "Renamed",
  };
  return [token, values[option.id] ?? "fixture"];
}

async function shellOutputByState(
  shell: "bash" | "fish",
  scriptPath: string,
  states: readonly CompletionState[],
  cwd: string,
): Promise<Map<string, string[]>> {
  // Fish's generated parser is deliberately explicit and therefore costly to
  // initialize. Run independent state batches concurrently so the exhaustive
  // oracle remains a bounded focused test instead of a serial minute-long
  // process. Each batch preserves state indices, so merge order is irrelevant.
  const batchSize = shell === "fish" ? Math.max(1, Math.ceil(states.length / 8)) : states.length;
  const batches: Array<{ offset: number; states: readonly CompletionState[] }> = [];
  for (let offset = 0; offset < states.length; offset += batchSize) {
    batches.push({ offset, states: states.slice(offset, offset + batchSize) });
  }
  const batchLines = await Promise.all(
    batches.map(async ({ offset, states: batchStates }) => {
      const commandLines: string[] = [];
      for (const [relativeIndex, state] of batchStates.entries()) {
        const index = offset + relativeIndex;
        for (const current of ["", "-"]) {
          const words = completionInvocationWords(state, current);
          if (shell === "bash") {
            commandLines.push(
              `COMP_WORDS=(${words.map(shellQuote).join(" ")}); COMP_CWORD=$((${words.length} - 1)); _threadleaf_completion; for candidate in "\${COMPREPLY[@]}"; do printf '%s\\t%s\\t%s\\n' ${shellQuote(current || "empty")} ${index} "$candidate"; done`,
            );
          } else {
            const line = words.map(shellQuote).join(" ");
            commandLines.push(
              `for candidate in (complete -C ${shellQuote(line)}); printf '%s\\t%s\\t%s\\n' ${shellQuote(current || "empty")} ${index} $candidate; end`,
            );
          }
        }
      }
      return runShellAsync(shell, scriptPath, commandLines.join("; "), cwd);
    }),
  );
  const output = new Map<string, string[]>();
  for (const lines of batchLines) {
    for (const line of lines) {
      const [current, indexText, candidate] = line.split("\t");
      if (!current || !indexText || candidate === undefined) continue;
      const key = `${current}:${indexText}`;
      const values = output.get(key) ?? [];
      values.push(candidate);
      output.set(key, values);
    }
  }
  return output;
}

function executable(name: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

describe("CLI schema and generated completion", () => {
  it("keeps help and completion usage on one metadata source", () => {
    const help = renderCliHelp();
    for (const usage of cliUsageLines()) {
      expect(help).toContain(`  ${usage}\n`);
    }

    const helpTopics = new Set(cliHelpTopics);
    for (const spec of cliCommandSpecs) {
      for (const name of spec.names) {
        if (name !== "help") {
          expect(helpTopics.has(name)).toBe(true);
        }
      }
    }
  });

  it("keeps parser option tokens and schema metadata in parity", () => {
    for (const option of cliGlobalOptions) {
      for (const name of option.names) {
        expect(parseCliOptionToken(name)?.id).toBe(option.id);
        if (option.takesValue && name.startsWith("--")) {
          expect(parseCliOptionToken(`${name}=value`)?.id).toBe(option.id);
        }
      }
    }
    expect(parseCliOptionToken("--not-a-schema-option")).toBeNull();
    expect(parseCliArguments(["--json", "help"]).id).toBe("help");
    expect(
      parseCliArguments([
        "--vault",
        "/vault",
        "search",
        "query=foo",
        "--directory",
        "docs",
        "--limit",
        "1",
      ]).id,
    ).toBe("search");
    expect(
      parseCliArguments(["--vault", "/vault", "append", "Note", "--content", "text", "--inline"])
        .id,
    ).toBe("append");
    expect(
      parseCliArguments(["--vault", "/vault", "move", "Note", "--to", "Archive/Note"]).id,
    ).toBe("move");
    expect(parseCliArguments(["--vault", "/vault", "rename", "Note", "--name", "Renamed"]).id).toBe(
      "rename",
    );
  });

  it("renders deterministic static scripts with aliases and options", () => {
    const commandNames = cliCommandSpecs.flatMap((spec) => spec.names);
    const optionNames = cliGlobalOptions.flatMap((option) => option.names);

    for (const shell of cliShells) {
      const first = generateCliCompletion(shell);
      expect(first).toBe(generateCliCompletion(shell));
      for (const name of commandNames) {
        expect(first).toContain(name);
      }
      for (const name of optionNames) {
        expect(first).toContain(name);
      }
      expect(first).not.toMatch(
        /(?:\/home\/|\/tmp\/|\.obsidian\/|child_process|readFile|spawn\()/u,
      );
      expect(first).not.toContain("process.env");
    }
  });

  it("keeps shell parser seams and terminators in the static fallback", () => {
    const bash = generateCliCompletion("bash");
    const zsh = generateCliCompletion("zsh");
    const fish = generateCliCompletion("fish");
    const powershell = generateCliCompletion("powershell");

    expect(bash).toContain("--) after_terminator=1;;");
    expect(bash).toContain("if (( pending_value )); then");
    expect(bash).toContain("complete -o nosort -F _threadleaf_completion threadleaf");
    expect(zsh).toContain("--) after_terminator=1;;");
    expect(zsh).toContain("if (( pending_value )); then");
    expect(zsh).toContain(
      "--vault=) if (( vault_seen )); then invalid_option=1; fi; vault_seen=1; invalid_option=1;;",
    );
    expect(zsh).toContain("--permanent|--*) invalid_option=1;;");
    expect(zsh).toContain("_describe 'threadleaf' candidates");
    expect(zsh).toContain("argument_help_topic_seen");
    expect(zsh).toContain("argument_tasks_filter_seen");
    expect(zsh).toContain("argument_task_mutation_seen");
    expect(fish).toContain("complete -c threadleaf -f\n");
    expect(fish).toContain("for token in (commandline -opc)");
    expect(fish).not.toContain("commandline -xpc");
    expect(fish).toContain('if test "$token" = "--vault"');
    expect(fish).toContain('if string match -q -- "--vault=*" "$token"');
    expect(fish).toContain('if test "$token" = "--"');
    expect(powershell).toContain("if ($element.Extent.EndOffset -ge $cursorPosition) { continue }");
    expect(powershell).toContain("if ($pendingValue) {");
    expect(powershell).toContain("$pendingOptionId = $null");
    expect(powershell).toContain("$invalidOption = $true");
    expect(powershell).toContain("ConvertTo-ThreadleafCompletionText");
    expect(powershell).toContain("Test-ThreadleafCompletionOptionValue");
    expect(powershell).toContain("if ($text -eq '--') { $afterTerminator = $true; continue }");
    expect(powershell).toContain("if ($consumed -notcontains $optionId)");
    expect(powershell).toContain("'search' {");
    expect(powershell).toContain("$argumentSeen");
    expect(powershell).toContain("switch -CaseSensitive ($command)");
    expect(powershell).toContain("switch -Regex -CaseSensitive ($text)");
    expect(powershell).toContain("-cmatch");
    expect(powershell).toContain("-cnotmatch");
    expect(powershell).toContain("'search' {");
    expect(powershell).not.toContain("'SEARCH' {");
    expect(powershell).toContain("'^--json$'");
    expect(powershell).not.toContain("'^--JSON$'");
    expect(powershell).not.toContain("switch ($command)");
    expect(powershell).not.toContain(" -match ");
    expect(powershell).not.toContain(" -notmatch ");
    for (const option of cliGlobalOptions.filter((item) => item.takesValue)) {
      expect(powershell).toContain(`'${option.id}' = $true`);
    }
    expect(powershell).not.toContain("/vault café/space");

    const powershellLines = powershell.split("\n");
    const vaultAliasIndex = powershellLines.findIndex((line) => line.includes("'vault:info' {"));
    expect(vaultAliasIndex).toBeGreaterThanOrEqual(0);
    expect(powershellLines.slice(vaultAliasIndex, vaultAliasIndex + 10).join("\n")).not.toContain(
      "'info'",
    );
    const trashAliasIndex = powershellLines.findIndex((line) => line.includes("'trash:list' {"));
    expect(trashAliasIndex).toBeGreaterThanOrEqual(0);
    expect(powershellLines.slice(trashAliasIndex, trashAliasIndex + 6).join("\n")).not.toContain(
      "'list'",
    );
  });

  it("keeps terminal alias spellings aligned with parser grammar", () => {
    expect(completionWordsForCommand("vault")).toContain("info");
    expect(completionWordsForCommand("vault:info")).not.toContain("info");
    expect(completionWordsForCommand("trash")).toContain("list");
    expect(completionWordsForCommand("trash:list")).not.toContain("list");
    expect(parseCliArguments(["--vault=/vault", "vault", "info"]).id).toBe("vault.info");
    expect(parseCliArguments(["--vault=/vault", "vault:info", "info=name"])).toMatchObject({
      id: "vault.info",
      info: "name",
    });
    expect(parseCliArguments(["--vault=/vault", "trash", "list"]).id).toBe("trash.list");
    expect(parseCliArguments(["--vault=/vault", "trash:list"]).id).toBe("trash.list");
    expect(() => parseCliArguments(["--vault=/vault", "vault:info", "info"])).toThrow(
      "Unknown command: vault:info info",
    );
    expect(() => parseCliArguments(["--vault=/vault", "trash:list", "list"])).toThrow(
      "Unknown command: trash:list list",
    );
    expect(parseCliOptionToken("--vault=")).toEqual({ id: "vault", inlineValue: "" });
    expect(() => parseCliArguments(["--vault=", "vault"])).toThrow("--vault requires a value.");
    expect(() => parseCliArguments(["-x", "help"])).toThrow("Unknown option: -x");
    expect(() => parseCliArguments(["--vault", "/vault", "-x"])).toThrow("Unknown option: -x");
    expect(() => parseCliArguments(["--vault", "/vault", "--permanent", "help"])).toThrow(
      "permanent deletion",
    );
    const searchContextUsage = cliUsageLines().find((line) => line.includes("search:context"));
    expect(searchContextUsage).toBeDefined();
    expect(searchContextUsage).not.toContain("[total]");
    expect(renderCliHelp()).not.toContain(
      "search:context query=<text> [path=<folder>] [limit=<n>] [format=text|json] [total] [case]",
    );
    expect(completionWordsForCommand("search:context")).not.toContain("total");
    expect(generateCliCompletion("bash")).not.toContain("argument_search_context_total_seen");
    expect(completionWordsForCommand("append")).toEqual(
      expect.arrayContaining(["content=", "inline"]),
    );
    expect(completionWordsForCommand("prepend")).toEqual(
      expect.arrayContaining(["content=", "inline"]),
    );
    expect(completionWordsForCommand("property:set")).toEqual(
      expect.arrayContaining([
        "type=text",
        "type=list",
        "type=number",
        "type=checkbox",
        "type=date",
        "type=datetime",
      ]),
    );
  });

  it("keeps documented option order, value forms, sentinel, and help forms executable", () => {
    expect(
      parseCliArguments([
        "search",
        "query=hello world",
        "--vault",
        "/vault café/space",
        "--directory=Folder With Spaces",
        "--limit",
        "3",
        "--json",
      ]),
    ).toMatchObject({
      id: "search",
      vaultPath: "/vault café/space",
      folder: "Folder With Spaces",
      limit: 3,
      json: true,
    });
    expect(parseCliArguments(["--vault=/vault", "create", "New note", "--content="])).toMatchObject(
      { id: "create", filePath: "New note", content: "" },
    );
    expect(
      parseCliArguments(["--vault", "/vault", "create", "New note", "--content", ""]),
    ).toMatchObject({ id: "create", filePath: "New note", content: "" });
    expect(
      parseCliArguments(["move", "Note.md", "--to=Archive/Note.md", "--vault=/vault"]),
    ).toMatchObject({ id: "move", targetValue: "Archive/Note.md" });
    expect(
      parseCliArguments(["rename", "Note.md", "--vault", "/vault", "--name", "New name"]),
    ).toMatchObject({ id: "rename", targetValue: "New name" });
    expect(parseCliArguments(["--vault=/vault", "read", "--", "-dash note.md"])).toMatchObject({
      id: "read",
      filePath: "-dash note.md",
      targetKind: "path",
    });
    expect(parseCliArguments(["--help", "search"])).toMatchObject({ id: "help", topic: "search" });
    expect(parseCliArguments(["help", "completion"])).toMatchObject({
      id: "help",
      topic: "completion",
    });
  });

  it("quotes leading dashes, spaces, quotes, and Unicode without changing tokens", () => {
    const token = "-dash with space 'quote' café\u0301😀";
    expect(quoteCompletionToken("bash", token)).toBe("'-dash with space '\\''quote'\\'' café́😀'");
    expect(quoteCompletionToken("zsh", token)).toBe("'-dash with space '\\''quote'\\'' café́😀'");
    expect(quoteCompletionToken("fish", token)).toBe("\"-dash\\ with\\ space\\ 'quote'\\ café́😀\"");
    expect(quoteCompletionToken("powershell", token)).toBe("'-dash with space ''quote'' café́😀'");
  });

  it("keeps completion global, reports unknown shells on stderr, and treats EPIPE as success", async () => {
    const generated = { stdout: "", stderr: "" };
    const generatedExit = await runCli(["completion", "bash"], {
      stdout: (value) => {
        generated.stdout += value;
      },
      stderr: (value) => {
        generated.stderr += value;
      },
    });
    expect(generatedExit).toBe(cliExitCodes.success);
    expect(generated.stdout).toContain("complete -o nosort -F _threadleaf_completion threadleaf");
    expect(generated.stderr).toBe("");

    const unknown = { stdout: "", stderr: "" };
    const unknownExit = await runCli(["completion", "unknown"], {
      stdout: (value) => {
        unknown.stdout += value;
      },
      stderr: (value) => {
        unknown.stderr += value;
      },
    });
    expect(unknownExit).toBe(cliExitCodes.usage);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("completion shell must be");

    const rejectedVault = { stdout: "", stderr: "" };
    const rejectedVaultExit = await runCli(["completion", "bash", "--vault", "/private"], {
      stdout: (value) => {
        rejectedVault.stdout += value;
      },
      stderr: (value) => {
        rejectedVault.stderr += value;
      },
    });
    expect(rejectedVaultExit).toBe(cliExitCodes.usage);
    expect(rejectedVault.stdout).toBe("");
    expect(rejectedVault.stderr).toContain("completion accepts only");
    expect(rejectedVault.stderr).not.toContain("/private");

    const epipe = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
    const epipeExit = await runCli(["completion", "bash"], {
      stdout: () => {
        throw epipe;
      },
      stderr: () => {
        throw new Error("stderr must stay empty on EPIPE");
      },
    });
    expect(epipeExit).toBe(cliExitCodes.success);
  });

  it("runs Bash and Fish fixtures without turning vault values into commands or files", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-shell-"));
    const cwdEntry = path.join(temporaryRoot, "cwd-entry");
    await fs.writeFile(cwdEntry, "fixture", "utf8");
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    const fishPath = path.join(temporaryRoot, "threadleaf.fish");
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      await fs.writeFile(fishPath, generateCliCompletion("fish"), "utf8");

      const bashVaultWords = ["threadleaf", "--vault", "/vault café/space", "vault", ""];
      const bashVault = runShell(
        "bash",
        bashPath,
        bashCompletionCommand(bashVaultWords),
        temporaryRoot,
      );
      expect(bashVault).toContain("info");
      expect(bashVault).not.toContain("/vault café/space");
      expect(bashVault).not.toContain("cwd-entry");

      const bashTerminalAlias = runShell(
        "bash",
        bashPath,
        bashCompletionCommand(["threadleaf", "--vault=/vault", "vault:info", ""]),
        temporaryRoot,
      );
      expect(bashTerminalAlias).not.toContain("info");
      expect(bashTerminalAlias).toContain("info=name");

      const bashTrashAlias = runShell(
        "bash",
        bashPath,
        bashCompletionCommand(["threadleaf", "--vault=/vault", "trash:list", ""]),
        temporaryRoot,
      );
      expect(bashTrashAlias).not.toContain("list");

      const bashEquals = runShell(
        "bash",
        bashPath,
        bashCompletionCommand(["threadleaf", "--vault=/vault café/space", "vault", ""]),
        temporaryRoot,
      );
      expect(bashEquals).toContain("info");
      expect(bashEquals).not.toContain("cwd-entry");

      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", "--vault", ""]),
          temporaryRoot,
        ),
      ).toEqual([]);
      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", "--vault="]),
          temporaryRoot,
        ),
      ).toEqual([]);
      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", "--not-a-real-option", ""]),
          temporaryRoot,
        ),
      ).toEqual([]);
      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", "search", "--not-a-real-option", ""]),
          temporaryRoot,
        ),
      ).toEqual([]);

      const bashOptions = runShell(
        "bash",
        bashPath,
        bashCompletionCommand([
          "threadleaf",
          "search",
          "--vault",
          "/v",
          "--directory",
          "d",
          "--json",
          "-",
        ]),
        temporaryRoot,
      );
      expect(bashOptions).toContain("--limit");
      expect(bashOptions).not.toContain("--json");
      expect(bashOptions).not.toContain("--content");
      expect(bashOptions).not.toContain("--to");
      expect(bashOptions).not.toContain("--inline");
      expect(bashOptions).not.toContain("--update-links");
      expect(bashOptions).not.toContain("--name");
      expect(bashOptions).not.toContain("--vault");
      expect(bashOptions).not.toContain("--directory");

      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", "--", "search", "-"]),
          temporaryRoot,
        ),
      ).toEqual([]);
      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", "--not-a-real-option", ""]),
          temporaryRoot,
        ),
      ).not.toContain("cwd-entry");

      const fishVault = runShell(
        "fish",
        fishPath,
        fishCompletionCommand('threadleaf --vault "/vault café/space" vault '),
        temporaryRoot,
      );
      expect(fishVault).toContain("info");
      expect(fishVault).not.toContain("/vault café/space");
      expect(fishVault).not.toContain("cwd-entry");

      const fishGlobVault = runShell(
        "fish",
        fishPath,
        fishCompletionCommand("threadleaf --vault * vault "),
        temporaryRoot,
      );
      expect(fishGlobVault).toContain("info");
      expect(fishGlobVault).not.toContain("cwd-entry");

      const fishEquals = runShell(
        "fish",
        fishPath,
        fishCompletionCommand('threadleaf --vault="/vault café/space" vault '),
        temporaryRoot,
      );
      expect(fishEquals).toContain("info");
      expect(fishEquals).not.toContain("cwd-entry");

      expect(
        runShell(
          "fish",
          fishPath,
          fishCompletionCommand('threadleaf --vault "/vault café/space"'),
          temporaryRoot,
        ),
      ).toEqual([]);
      expect(
        runShell("fish", fishPath, fishCompletionCommand("threadleaf --vault="), temporaryRoot),
      ).toEqual([]);
      expect(
        runShell(
          "fish",
          fishPath,
          fishCompletionCommand("threadleaf --not-a-real-option "),
          temporaryRoot,
        ),
      ).toEqual([]);
      const fishOptions = runShell(
        "fish",
        fishPath,
        fishCompletionCommand("threadleaf search --vault /v --directory d --json -"),
        temporaryRoot,
      );
      expect(fishOptions).toContain("--limit");
      expect(fishOptions).not.toContain("--json");
      expect(fishOptions).not.toContain("--content");
      expect(fishOptions).not.toContain("--to");
      expect(fishOptions).not.toContain("--inline");
      expect(fishOptions).not.toContain("--update-links");
      expect(fishOptions).not.toContain("--name");
      expect(fishOptions).not.toContain("--vault");
      expect(fishOptions).not.toContain("--directory");
      expect(
        runShell("fish", fishPath, fishCompletionCommand("threadleaf search --"), temporaryRoot),
      ).toEqual([]);
      expect(
        runShell(
          "fish",
          fishPath,
          fishCompletionCommand("threadleaf --not-a-real-option "),
          temporaryRoot,
        ),
      ).not.toContain("cwd-entry");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps Bash parsing case-exact under nocasematch without leaking shell state", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-nocasematch-"));
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      const result = runShell(
        "bash",
        bashPath,
        [
          "shopt -s nocasematch",
          bashCompletionCommand(["threadleaf", "SEARCH", ""]),
          "printf 'SEARCH:%s\\n' \"${COMPREPLY[*]}\"",
          bashCompletionCommand(["threadleaf", "--JSON", ""]),
          "printf 'JSON:%s\\n' \"${COMPREPLY[*]}\"",
          "shopt -q nocasematch; printf 'OPTION:%s\\n' \"$?\"",
        ].join("; "),
        temporaryRoot,
      );
      expect(result).toEqual(["SEARCH:", "JSON:", "OPTION:0"]);
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps generated argument continuations parser-valid across grammar states", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-grammar-"));
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    const fishPath = path.join(temporaryRoot, "threadleaf.fish");
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      await fs.writeFile(fishPath, generateCliCompletion("fish"), "utf8");
      const bashCases: Array<{ words: string[]; absent: string[] }> = [
        { words: ["threadleaf", "help", "search", ""], absent: ["completion", "search"] },
        { words: ["threadleaf", "--help", "search", ""], absent: ["completion", "search"] },
        {
          words: ["threadleaf", "completion", "bash", ""],
          absent: ["bash", "zsh", "fish", "powershell"],
        },
        {
          words: ["threadleaf", "--vault", "/v", "tasks", "done", ""],
          absent: ["done", "todo", "status="],
        },
        {
          words: ["threadleaf", "--vault", "/v", "tasks", "daily", ""],
          absent: ["daily", "path=", "file="],
        },
        {
          words: ["threadleaf", "--vault", "/v", "task", "done", ""],
          absent: ["done", "todo", "toggle", "status="],
        },
        { words: ["threadleaf", "--vault", "/v", "read", "Note", ""], absent: ["file=", "path="] },
        {
          words: ["threadleaf", "--vault", "/v", "create", "content=x", ""],
          absent: ["template=", "--content"],
        },
        {
          words: ["threadleaf", "--vault", "/v", "append", "Note", "content=x", ""],
          absent: ["content=", "--content"],
        },
        {
          words: ["threadleaf", "--vault", "/v", "move", "Note", "to=x", ""],
          absent: ["to=", "--to"],
        },
        {
          words: ["threadleaf", "--vault", "/v", "rename", "Note", "name=x", ""],
          absent: ["name=", "--name"],
        },
        {
          words: ["threadleaf", "--vault", "/v", "search", "path=x", ""],
          absent: ["--directory", "path="],
        },
        {
          words: ["threadleaf", "--vault", "/v", "search", "--directory", "d", ""],
          absent: ["--directory", "path="],
        },
        {
          words: ["threadleaf", "--vault", "/v", "--", "search", ""],
          absent: ["search", "--vault", "--help"],
        },
        { words: ["threadleaf", "SEARCH", ""], absent: ["search", "SEARCH"] },
        { words: ["threadleaf", "--JSON", ""], absent: ["--json", "--JSON"] },
      ];
      for (const testCase of bashCases) {
        const result = runShell(
          "bash",
          bashPath,
          bashCompletionCommand(testCase.words),
          temporaryRoot,
        );
        for (const candidate of testCase.absent) {
          expect(result, testCase.words.join(" ")).not.toContain(candidate);
        }
      }

      const fishCases: Array<{ line: string; absent: string[] }> = [
        { line: "threadleaf help search ", absent: ["completion", "search"] },
        { line: "threadleaf --help search ", absent: ["completion", "search"] },
        { line: "threadleaf completion bash ", absent: ["bash", "zsh", "fish", "powershell"] },
        { line: "threadleaf --vault /v tasks done ", absent: ["done", "todo", "status="] },
        { line: "threadleaf --vault /v tasks daily ", absent: ["daily", "path=", "file="] },
        { line: "threadleaf --vault /v task done ", absent: ["done", "todo", "toggle", "status="] },
        { line: "threadleaf --vault /v read Note ", absent: ["file=", "path="] },
        { line: "threadleaf --vault /v create content=x ", absent: ["template=", "--content"] },
        { line: "threadleaf --vault /v search path=x ", absent: ["--directory", "path="] },
        { line: "threadleaf --vault /v -- search ", absent: ["search", "--vault", "--help"] },
        { line: "threadleaf SEARCH ", absent: ["search", "SEARCH"] },
        { line: "threadleaf --JSON ", absent: ["--json", "--JSON"] },
      ];
      for (const testCase of fishCases) {
        const result = runShell(
          "fish",
          fishPath,
          fishCompletionCommand(testCase.line),
          temporaryRoot,
        );
        for (const candidate of testCase.absent) {
          expect(result, testCase.line).not.toContain(candidate);
        }
      }

      const selectedStaticCandidates: string[][] = [
        ["--help", "search"],
        ["help", "search"],
        ["completion", "bash"],
        ["--vault", "/v", "vault", "info"],
        ["--vault", "/v", "tasks", "done"],
        ["--vault", "/v", "tasks", "daily"],
        ["--vault", "/v", "task", "path=Note", "line=1", "done"],
        ["--vault", "/v", "search", "query=q", "format=text"],
        ["--vault", "/v", "create", "Note", "overwrite"],
        ["--vault", "/v", "append", "Note", "content=x"],
        ["--vault", "/v", "move", "Note", "to=Archive/Note"],
        ["--vault", "/v", "rename", "Note", "name=Renamed"],
      ];
      for (const args of selectedStaticCandidates) {
        expect(() => parseCliArguments(args), args.join(" ")).not.toThrow();
      }

      const generatedShells = [
        ["bash", generateCliCompletion("bash")],
        ["zsh", generateCliCompletion("zsh")],
        ["fish", generateCliCompletion("fish")],
        ["powershell", generateCliCompletion("powershell")],
      ] as const;
      for (const [shell, script] of generatedShells) {
        for (const spec of cliCommandSpecs) {
          for (const spelling of spec.names) {
            for (const word of completionStaticWordsForCommand(spelling)) {
              expect(script, `${shell} ${spelling} ${word}`).toContain(word);
            }
          }
        }
      }

      // This is the permanent corpus gate: every parser spelling and every
      // schema-emitted static candidate gets a concrete value and a parser
      // acceptance check. Every candidate is appended to a representative
      // prefix that satisfies the command's already-consumed required slots.
      for (const spec of cliCommandSpecs) {
        for (const spelling of spec.names) {
          const staticWords = completionStaticWordsForCommand(spelling);
          for (const word of staticWords) {
            const args = completionCandidateArgs(spec, spelling, word);
            expect(() => parseCliArguments(args), args.join(" ")).not.toThrow();
          }
        }
      }

      const collisionCases = [
        ["--vault", "/v", "tasks", "done", "todo"],
        ["--vault", "/v", "tasks", "done", "status=?"],
        ["--vault", "/v", "tasks", "path=Note.md", "daily"],
        ["--vault", "/v", "tasks", "daily", "file=Note.md"],
        ["--vault", "/v", "task", "ref=Note.md:1", "path=Note.md"],
        ["--vault", "/v", "task", "path=Note.md", "line=1", "done", "todo"],
        ["--vault", "/v", "create", "Note.md", "content=one", "template=Daily.md"],
        ["--vault", "/v", "create", "Note.md", "content=one", "--content=two"],
        ["--vault", "/v", "append", "Note.md", "content=one", "--content=two"],
        ["--vault", "/v", "daily:append", "content=one", "--content=two"],
        ["--vault", "/v", "move", "Note.md", "to=Archive/Note.md", "--to=Other.md"],
        ["--vault", "/v", "rename", "Note.md", "name=New.md", "--name=Other.md"],
        ["--vault", "/v", "search", "query=needle", "path=Notes", "--directory", "Notes"],
        ["--vault", "/v", "search", "query=needle", "limit=1", "--limit", "2"],
        ["--vault", "/v", "vault:info", "info"],
        ["--vault", "/v", "trash:list", "list"],
      ];
      for (const args of collisionCases) {
        expect(() => parseCliArguments(args), args.join(" ")).toThrow();
      }
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("suppresses every Bash and Fish candidate after a parser-invalid static/global conflict", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-cli-fish-conflicts-"),
    );
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    const fishPath = path.join(temporaryRoot, "threadleaf.fish");
    const conflictCases: Array<{ args: string[]; label: string }> = [
      {
        args: ["--vault", "/v", "create", "Note", "content=one", "template=Daily"],
        label: "create content/template",
      },
      {
        args: ["--vault", "/v", "create", "Note", "content=one", "--content=two"],
        label: "create content/--content",
      },
      {
        args: ["--vault", "/v", "create", "Note", "template=Daily", "--content=two"],
        label: "create template/--content",
      },
      {
        args: ["--vault", "/v", "daily:append", "content=one", "--content=two"],
        label: "daily:append content/--content",
      },
      {
        args: ["--vault", "/v", "daily:append", "inline", "--inline"],
        label: "daily:append inline/--inline",
      },
      {
        args: ["--vault", "/v", "daily:prepend", "content=one", "--content=two"],
        label: "daily:prepend content/--content",
      },
      {
        args: ["--vault", "/v", "daily:prepend", "inline", "--inline"],
        label: "daily:prepend inline/--inline",
      },
      {
        args: ["--vault", "/v", "append", "Note", "content=one", "--content=two"],
        label: "append content/--content",
      },
      {
        args: ["--vault", "/v", "append", "Note", "inline", "--inline"],
        label: "append inline/--inline",
      },
      {
        args: ["--vault", "/v", "prepend", "Note", "content=one", "--content=two"],
        label: "prepend content/--content",
      },
      {
        args: ["--vault", "/v", "prepend", "Note", "inline", "--inline"],
        label: "prepend inline/--inline",
      },
      {
        args: ["--vault", "/v", "files", "folder=Notes", "--directory", "Notes"],
        label: "files folder/--directory",
      },
      {
        args: ["--vault", "/v", "search", "query=needle", "path=Notes", "--directory", "Notes"],
        label: "search path/--directory",
      },
      {
        args: ["--vault", "/v", "search", "query=needle", "limit=1", "--limit", "2"],
        label: "search limit/--limit",
      },
      {
        args: ["--vault", "/v", "move", "Note", "to=Archive/Note", "--to=Other"],
        label: "move to/--to",
      },
      {
        args: ["--vault", "/v", "rename", "Note", "name=New", "--name=Other"],
        label: "rename name/--name",
      },
      {
        args: ["--vault", "/v", "tasks", "done", "todo"],
        label: "tasks done/todo",
      },
      {
        args: ["--vault", "/v", "tasks", "path=Note", "daily"],
        label: "tasks path/daily",
      },
      {
        args: ["--vault", "/v", "tasks", "daily", "file=Note"],
        label: "tasks daily/file",
      },
      {
        args: ["--vault", "/v", "task", "ref=Note.md:1", "path=Note.md"],
        label: "task ref/path",
      },
      {
        args: ["--vault", "/v", "task", "path=Note.md", "line=1", "done", "todo"],
        label: "task mutation/mutation",
      },
    ];
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      await fs.writeFile(fishPath, generateCliCompletion("fish"), "utf8");
      for (const shell of ["bash", "fish"] as const) {
        for (const { args, label } of conflictCases) {
          expect(() => parseCliArguments(args), label).toThrow();
          const result =
            shell === "bash"
              ? runShell(
                  "bash",
                  bashPath,
                  bashCompletionCommand(["threadleaf", ...args, ""]),
                  temporaryRoot,
                )
              : runShell(
                  "fish",
                  fishPath,
                  fishCompletionCommand(["threadleaf", ...args, ""].join(" ")),
                  temporaryRoot,
                );
          expect(result, `${shell} ${label}`).toEqual([]);
        }
      }
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("suppresses Bash and Fish candidates after parser-invalid finite histories", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-finite-oracle-"));
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    const fishPath = path.join(temporaryRoot, "threadleaf.fish");
    const invalidCases: Array<{ args: string[]; label: string }> = [
      { args: ["help", "nope"], label: "help unknown topic" },
      { args: ["help", "SEARCH"], label: "help exact case" },
      { args: ["help", "completion", "nope"], label: "help extra topic" },
      { args: ["--help", "search", "nope"], label: "--help extra topic" },
      { args: ["completion", "nope"], label: "completion unknown shell" },
      { args: ["completion", "BASH"], label: "completion exact case" },
      { args: ["completion", "bash", "nope"], label: "completion extra shell" },
      { args: ["--vault", "/v", "vault", "nope"], label: "vault unknown selector" },
      { args: ["--vault", "/v", "vault", "info", "nope"], label: "vault extra selector" },
      { args: ["--vault", "/v", "vault", "INFO"], label: "vault exact case" },
      { args: ["--vault", "/v", "vault:info", "nope"], label: "vault alias unknown selector" },
      { args: ["--vault", "/v", "trash", "nope"], label: "trash unknown selector" },
      { args: ["--vault", "/v", "trash:list", "list"], label: "trash alias extra selector" },
      { args: ["--vault", "/v", "trash", "LIST"], label: "trash exact case" },
      { args: ["--vault", "/v", "wordcount", "Note", "nope"], label: "wordcount extra flag" },
      { args: ["--vault", "/v", "folder", "path=Notes", "info=nope"], label: "folder enum" },
      { args: ["--vault", "/v", "files", "unknown=value"], label: "files unknown key" },
      { args: ["--vault", "/v", "files", "folder="], label: "files empty folder" },
      { args: ["--vault", "/v", "files", "ext=."], label: "files empty extension" },
      {
        args: ["--vault", "/v", "search", "query=needle", "format=nope"],
        label: "search format enum",
      },
      {
        args: ["--vault", "/v", "search", "query=needle", "limit=0"],
        label: "search static zero limit",
      },
      {
        args: ["--vault", "/v", "search", "query="],
        label: "search empty query",
      },
      {
        args: ["--vault", "/v", "search:context", "query=needle", "total"],
        label: "search context rejected total",
      },
      {
        args: ["--vault", "/v", "search:context", "query=needle", "format=nope"],
        label: "search context format enum",
      },
      { args: ["--vault", "/v", "links", "Note", "nope"], label: "links extra flag" },
      {
        args: ["--vault", "/v", "backlinks", "Note", "format=nope"],
        label: "backlinks format enum",
      },
      { args: ["--vault", "/v", "unresolved", "format=nope"], label: "unresolved format enum" },
      { args: ["--vault", "/v", "outline", "Note", "format=nope"], label: "outline format enum" },
      { args: ["--vault", "/v", "tasks", "format=nope"], label: "tasks format enum" },
      { args: ["--vault", "/v", "tasks", "active"], label: "tasks rejected flag" },
      { args: ["--vault", "/v", "task", "nope"], label: "task unknown flag" },
      {
        args: ["--vault", "/v", "task", "daily", "line=0"],
        label: "task zero line",
      },
      { args: ["--vault", "/v", "tags", "sort=nope"], label: "tags sort enum" },
      {
        args: [
          "--vault",
          "/v",
          "property:set",
          "path=Note",
          "name=key",
          "value=value",
          "type=nope",
        ],
        label: "property type enum",
      },
      { args: ["--vault", "/v", "plugins", "filter=core"], label: "plugins rejected filter" },
      { args: ["--vault", "/v", "plugins", "format=nope"], label: "plugins format enum" },
      { args: ["--vault", "/v", "plugin", "id=bad/id"], label: "plugin id syntax" },
      {
        args: ["--vault", "/v", "property:read", "path=Note", "name=bad.name"],
        label: "property name syntax",
      },
      { args: ["--vault", "/v", "tag", "name=#"], label: "empty normalized tag" },
      {
        args: ["--vault", "/v", "search", "query=needle", "--limit", "--json"],
        label: "missing spaced limit value",
      },
      {
        args: ["--vault", "/v", "search", "query=needle", "--limit=0"],
        label: "invalid inline limit value",
      },
      {
        args: ["--vault", "/v", "append", "Note", "--content", "--json"],
        label: "missing spaced content value",
      },
      {
        args: ["--vault", "/v", "move", "Note", "--to", "--json"],
        label: "missing spaced destination value",
      },
      {
        args: ["--vault", "/v", "rename", "Note", "--name", "--json"],
        label: "missing spaced name value",
      },
      { args: ["--vault", "/v", "snippets", "nope"], label: "snippets arguments" },
    ];
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      await fs.writeFile(fishPath, generateCliCompletion("fish"), "utf8");
      for (const { args, label } of invalidCases) {
        expect(() => parseCliArguments(args), label).toThrow();
        const bashWords = ["threadleaf", ...args, ""];
        expect(
          runShell("bash", bashPath, bashCompletionCommand(bashWords), temporaryRoot),
          label,
        ).toEqual([]);
        const fishLine = bashWords.join(" ");
        expect(
          runShell("fish", fishPath, fishCompletionCommand(fishLine), temporaryRoot),
          label,
        ).toEqual([]);
      }

      const positiveSearch = ["--vault", "/v", "search:context", "query=needle", "free", "TOTAL"];
      expect(() => parseCliArguments(positiveSearch)).not.toThrow();
      expect(
        runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", ...positiveSearch, ""]),
          temporaryRoot,
        ),
      ).toContain("case");

      const validEmptyStaticCases = [
        ["--vault", "/v", "create", "Note", "content="],
        ["--vault", "/v", "daily", "folder="],
        ["--vault", "/v", "property:set", "path=Note", "name=key", "value="],
      ];
      for (const args of validEmptyStaticCases) {
        expect(() => parseCliArguments(args), args.join(" ")).not.toThrow();
        expect(
          runShell(
            "bash",
            bashPath,
            bashCompletionCommand(["threadleaf", ...args, ""]),
            temporaryRoot,
          ).length,
          `bash ${args.join(" ")}`,
        ).toBeGreaterThan(0);
        expect(
          runShell(
            "fish",
            fishPath,
            fishCompletionCommand(["threadleaf", ...args, ""].join(" ")),
            temporaryRoot,
          ).length,
          `fish ${args.join(" ")}`,
        ).toBeGreaterThan(0);
      }
      expect(
        runShell(
          "fish",
          fishPath,
          fishCompletionCommand(["threadleaf", ...positiveSearch, ""].join(" ")),
          temporaryRoot,
        ),
      ).toContain("case");

      const powershell = generateCliCompletion("powershell");
      const argumentCase = (spelling: string): string => {
        const lines = powershell.split("\n");
        const start = lines.findIndex(
          (line, index) =>
            line === `    '${spelling}' {` &&
            lines[index + 1] === "      switch -Regex -CaseSensitive ($text) {",
        );
        expect(start, `PowerShell argument case for ${spelling}`).toBeGreaterThanOrEqual(0);
        const end = lines.findIndex((line, index) => index > start && line === "      break");
        expect(end, `PowerShell argument case end for ${spelling}`).toBeGreaterThan(start);
        return lines.slice(start, end + 1).join("\n");
      };
      for (const spelling of ["help", "completion", "vault", "trash", "trash:list"]) {
        expect(argumentCase(spelling), spelling).toContain(
          "default { $invalidArgument = $true; break }",
        );
      }
      expect(argumentCase("wordcount")).toContain("'^words$'");
      expect(argumentCase("wordcount")).toContain("'^characters$'");
      expect(argumentCase("search:context")).toContain("$text -ceq 'total'");
      expect(powershell).toContain("switch -Regex -CaseSensitive ($text)");
      expect(powershell).toContain("switch -CaseSensitive ($command)");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("sweeps every runtime candidate through the parser oracle", async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-oracle-"));
    const states = completionStates();
    const scripts = new Map(
      cliShells.map((shell) => [shell, generateCliCompletion(shell)] as const),
    );
    try {
      const scriptPaths = new Map<string, string>();
      for (const [shell, script] of scripts) {
        const scriptPath = path.join(temporaryRoot, `threadleaf.${shell}`);
        await fs.writeFile(scriptPath, script, "utf8");
        scriptPaths.set(shell, scriptPath);
      }

      for (const shell of ["bash", "fish"] as const) {
        const executableShell = executable(shell);
        if (!executableShell) continue;
        const output = await shellOutputByState(
          shell,
          scriptPaths.get(shell)!,
          states,
          temporaryRoot,
        );
        for (const [index, state] of states.entries()) {
          for (const current of ["empty", "-"]) {
            const candidates = output.get(`${current}:${index}`) ?? [];
            for (const candidate of candidates) {
              const args = completionCandidateArgsForState(state, candidate);
              if (completionCandidateIsParserPrefix(candidate)) {
                expect(args.at(-1), `${shell} ${state.label} ${candidate}`).toBe(candidate);
                expect(
                  () =>
                    parseCliArguments([
                      ...args.slice(0, -1),
                      ...completionOptionArgsForCheck(candidate),
                    ]),
                  `${shell} ${state.label} ${candidate}`,
                ).not.toThrow();
                continue;
              }
              expect(
                () => parseCliArguments(args),
                `${shell} ${state.label} ${candidate}`,
              ).not.toThrow();
            }
          }
        }
      }

      // zsh and PowerShell are unavailable on this host. Their generated
      // scripts still receive a deterministic static proof: every static
      // candidate has already passed the parser sweep above, and each
      // unavailable runtime retains its parser-case-exact dispatch markers.
      for (const shell of cliShells.filter((name) => !executable(name))) {
        const script = scripts.get(shell)!;
        expect(script).toContain("generated from the CLI schema");
        if (shell === "zsh") {
          expect(script).toContain("_describe 'threadleaf' candidates");
          expect(script).toContain('case "$command" in');
        } else if (shell === "powershell") {
          expect(script).toContain("switch -CaseSensitive ($command)");
          expect(script).toContain("switch -Regex -CaseSensitive ($text)");
        }
      }
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
    // This invokes every generated Bash and Fish candidate against the real
    // parser. Under the concurrent repository gate it has measured just under
    // five minutes, despite completing well inside this budget in isolation.
  }, 360_000);

  it("keeps root eligibility and literal parser-oracle candidates visible", async () => {
    const completionSpec = cliCommandSpecs.find((spec) => spec.id === "completion");
    const helpSpec = cliCommandSpecs.find((spec) => spec.id === "help");
    const searchSpec = cliCommandSpecs.find((spec) => spec.id === "search");
    if (!completionSpec || !helpSpec || !searchSpec) {
      throw new Error("CLI completion regression fixtures are missing their command specs");
    }
    expect(commandAllowsConsumedOptions(completionSpec, ["vault"])).toBe(false);
    expect(commandAllowsConsumedOptions(helpSpec, ["vault"])).toBe(true);
    expect(commandAllowsConsumedOptions(searchSpec, ["directory", "limit"])).toBe(true);
    expect(commandAllowsConsumedOptions(searchSpec, ["content"])).toBe(false);

    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-cli-root-eligibility-"),
    );
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    const fishPath = path.join(temporaryRoot, "threadleaf.fish");
    const rootCases: Array<{ args: string[]; present: string[]; absent: string[] }> = [
      {
        args: ["--vault", "/v"],
        present: ["help", "vault"],
        absent: ["completion"],
      },
      {
        args: ["--directory", "Notes"],
        present: ["help", "files", "search", "search:context"],
        absent: ["completion", "vault"],
      },
      {
        args: ["--limit", "5"],
        present: ["help", "search", "search:context"],
        absent: ["completion", "vault"],
      },
      {
        args: ["--content="],
        present: ["help", "create", "append", "prepend", "daily:append", "daily:prepend"],
        absent: ["completion", "search"],
      },
    ];
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      await fs.writeFile(fishPath, generateCliCompletion("fish"), "utf8");
      for (const { args, present, absent } of rootCases) {
        const bash = runShell(
          "bash",
          bashPath,
          bashCompletionCommand(["threadleaf", ...args, ""]),
          temporaryRoot,
        );
        const fish = runShell(
          "fish",
          fishPath,
          fishCompletionCommand(["threadleaf", ...args, ""].join(" ")),
          temporaryRoot,
        );
        for (const candidate of present) {
          expect(bash, `bash ${args.join(" ")}`).toContain(candidate);
          expect(fish, `fish ${args.join(" ")}`).toContain(candidate);
        }
        for (const candidate of absent) {
          expect(bash, `bash ${args.join(" ")}`).not.toContain(candidate);
          expect(fish, `fish ${args.join(" ")}`).not.toContain(candidate);
        }
      }

      const searchState: CompletionState = {
        args: ["--vault", "/v", "search", "query=needle"],
        label: "search query=needle",
      };
      expect(completionCandidateArgsForState(searchState, "format=json")).toEqual([
        ...searchState.args,
        "format=json",
      ]);
      expect(completionCandidateArgsForState(searchState, "format=")).toEqual([
        ...searchState.args,
        "format=",
      ]);
      expect(completionCandidateArgsForState(searchState, "--limit")).toEqual([
        ...searchState.args,
        "--limit",
      ]);

      const rootCompletion = completionCandidateArgsForState(
        { args: [], label: "root" },
        "completion",
      );
      expect(rootCompletion).toEqual(["completion", "bash"]);
      const rootSearch = completionCandidateArgsForState({ args: [], label: "root" }, "search");
      expect(rootSearch[0]).toBe("search");
      expect(parserAccepts(rootSearch)).toBe(true);

      for (const testCase of literalParserOracleCases) {
        expect(parserAccepts(testCase.args), testCase.label).toBe(testCase.accepted);
      }
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses literal parser histories as generated completion runtime oracles", async () => {
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "threadleaf-cli-literal-oracle-"),
    );
    const bashPath = path.join(temporaryRoot, "threadleaf.bash");
    const fishPath = path.join(temporaryRoot, "threadleaf.fish");
    try {
      await fs.writeFile(bashPath, generateCliCompletion("bash"), "utf8");
      await fs.writeFile(fishPath, generateCliCompletion("fish"), "utf8");

      for (const testCase of literalParserOracleCases) {
        expect(parserAccepts(testCase.args), testCase.label).toBe(testCase.accepted);
        for (const shell of ["bash", "fish"] as const) {
          const candidates =
            shell === "bash"
              ? runShell(
                  "bash",
                  bashPath,
                  bashCompletionCommand(["threadleaf", ...testCase.args, ""]),
                  temporaryRoot,
                )
              : runShell(
                  "fish",
                  fishPath,
                  fishCompletionCommand(["threadleaf", ...testCase.args, ""].join(" ")),
                  temporaryRoot,
                );
          if (!testCase.accepted) {
            expect(candidates, `${shell} ${testCase.label}`).toEqual([]);
            continue;
          }

          // Both directions are pinned: a terminal accepted state (help or
          // completion mode short-circuits the rest of the invocation) must
          // offer nothing, and every other accepted state must actually offer
          // candidates, or the per-candidate validity loop below is vacuous.
          if (testCase.terminal) {
            expect(candidates, `${shell} ${testCase.label} must stay empty`).toEqual([]);
            continue;
          }
          expect(
            candidates.length,
            `${shell} ${testCase.label} produced no candidates`,
          ).toBeGreaterThan(0);

          for (const candidate of candidates) {
            const candidateArgs = [...testCase.args, candidate];
            if (!completionCandidateIsParserPrefix(candidate)) {
              expect(parserAccepts(candidateArgs), `${shell} ${testCase.label} ${candidate}`).toBe(
                true,
              );
              continue;
            }

            // Prefixes are intentionally incomplete parser states. Preserve
            // that exact literal form, and require it to suppress a second
            // completion surface if the parser rejects it as incomplete.
            if (!parserAccepts(candidateArgs)) {
              const afterPrefix =
                shell === "bash"
                  ? runShell(
                      "bash",
                      bashPath,
                      bashCompletionCommand(["threadleaf", ...candidateArgs, ""]),
                      temporaryRoot,
                    )
                  : runShell(
                      "fish",
                      fishPath,
                      fishCompletionCommand(["threadleaf", ...candidateArgs, ""].join(" ")),
                      temporaryRoot,
                    );
              expect(afterPrefix, `${shell} ${testCase.label} ${candidate} pending`).toEqual([]);
            }
          }
        }
      }

      // Zsh and PowerShell are not installed on this host. Keep literal
      // parser fixtures above as the authority, and pin the generated
      // recognizers which must turn those invalid histories into no output.
      const zsh = generateCliCompletion("zsh");
      expect(zsh).toContain('case "$token" in');
      expect(zsh).toContain("if ! _threadleaf_completion_value_valid");
      expect(zsh).toContain("positive-integer)");
      expect(zsh).toContain("query)");
      expect(zsh).toContain("if (( pending_value || invalid_option || invalid_argument )); then");
      expect(zsh).toContain('case "$command" in');

      const powershell = generateCliCompletion("powershell");
      expect(powershell).toContain("switch -Regex -CaseSensitive ($text)");
      expect(powershell).toContain("switch -CaseSensitive ($command)");
      expect(powershell).toContain("'positive-integer'");
      expect(powershell).toContain("'query'");
      expect(powershell).toContain("'completion' {");
      expect(powershell).toContain(
        "if ($pendingValue -or $invalidOption -or $invalidArgument) { return }",
      );
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 45_000);

  it("uses TabExpansion2 when PowerShell exists and keeps a deterministic fallback otherwise", async () => {
    const powershell = executable("pwsh") ?? executable("powershell");
    const script = generateCliCompletion("powershell");
    expect(script).toContain("$optionTakesValue");
    expect(script).toContain("$pendingValue");
    expect(script).toContain("$afterTerminator");
    expect(script).toContain("if ($pendingValue) {");
    expect(script).toContain("$pendingOptionId = $null");
    expect(script).toContain("if ($text -eq '--') { $afterTerminator = $true; continue }");
    expect(script).toContain("'vault' {");
    expect(script).toContain("switch -CaseSensitive ($command)");
    expect(script).toContain("-cmatch");
    expect(script).toContain("-cnotmatch");
    expect(script).toContain("'search:context' {");
    expect(script).toContain("'vault:info' {");
    expect(script).toContain("'trash:list' {");
    expect(script).toContain("'^--json$'");
    expect(script).not.toContain("switch -Regex ($text)");
    expect(script).not.toContain("switch ($command)");
    if (!powershell) {
      return;
    }

    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-cli-pwsh-"));
    const completionPath = path.join(temporaryRoot, "threadleaf.ps1");
    try {
      await fs.writeFile(completionPath, script, "utf8");
      for (const line of ["threadleaf va", 'threadleaf --vault "/vault café/space" va']) {
        const probe = [
          `. ${shellQuote(completionPath)}`,
          `$line = ${shellQuote(line)}`,
          "$result = TabExpansion2 -inputScript $line -cursorColumn $line.Length",
          "$result.CompletionMatches | ForEach-Object { $_.CompletionText }",
        ].join("; ");
        const result = spawnSync(powershell, ["-NoProfile", "-Command", probe], {
          cwd: temporaryRoot,
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout.split("\n")).toContain("vault");
        expect(result.stdout).not.toContain("/vault café/space");
      }
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
