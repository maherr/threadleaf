import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultTextSnapshot, VaultWriteResult } from "../kernel/ports";

/**
 * The complex-property editor intentionally has a much smaller write surface than YAML itself.
 * A value can be changed when the source range is an ordinary scalar or sequence item.  Mappings,
 * aliases, tags, block scalars, flow collections, and malformed input remain inspectable, but are
 * not rewritten by guessing at a serializer's output.
 */
export type ComplexPropertyNodeKind =
  | "mapping"
  | "sequence"
  | "scalar"
  | "opaque"
  | "duplicate"
  | "anchor"
  | "tag"
  | "multiline"
  | "syntax-error";

export type ComplexPropertyPathSegment = string | number;

export interface ComplexPropertyIssue {
  kind: Exclude<ComplexPropertyNodeKind, "mapping" | "sequence" | "scalar">;
  path: string;
  message: string;
}

export interface ComplexPropertyEntry {
  path: string;
  kind: ComplexPropertyNodeKind;
  value: unknown;
  rawValue: string;
  editable: boolean;
  reason: string | null;
  line: number;
}

export interface ComplexPropertyInspection {
  status: "editable" | "unsupported" | "syntax-error";
  entries: ComplexPropertyEntry[];
  value: unknown;
  issues: ComplexPropertyIssue[];
  message: string | null;
}

export interface ComplexPropertySetOperation {
  kind: "set";
  path: readonly ComplexPropertyPathSegment[] | string;
  value: unknown;
}

export interface ComplexPropertyRemoveOperation {
  kind: "remove";
  path: readonly ComplexPropertyPathSegment[] | string;
}

export type ComplexPropertyOperation = ComplexPropertySetOperation | ComplexPropertyRemoveOperation;

export interface ComplexPropertyPreview {
  status: "ready" | "unsupported" | "syntax-error";
  path: string;
  propertyPath: string;
  baseRevision: string | null;
  before: string;
  after: string | null;
  changed: boolean;
  beforeHash: string;
  afterHash: string | null;
  issues: ComplexPropertyIssue[];
  message: string | null;
}

export type ComplexPropertyMutationOutcome =
  | (VaultWriteResult & {
      propertyPath: string;
      changed: boolean;
    })
  | {
      status: "stale";
      path: string;
      propertyPath: string;
      currentRevision: string;
    }
  | {
      status: "unsupported" | "syntax-error";
      path: string;
      propertyPath: string;
      message: string;
      issues: ComplexPropertyIssue[];
    };

interface SourceLine {
  full: string;
  text: string;
  start: number;
  end: number;
  line: number;
  indent: number;
}

interface FrontmatterSource {
  bom: string;
  opening: SourceLine;
  lines: SourceLine[];
  closing: SourceLine;
  bodyStart: number;
  body: string;
  lineEnding: "\n" | "\r\n";
}

interface StructuralNode {
  path: string;
  kind: "mapping" | "sequence" | "scalar" | "opaque";
  line: SourceLine;
  key: string | null;
  rawValue: string;
  value: unknown;
  valueStart: number;
  valueEnd: number;
  parentPath: string | null;
  children: StructuralNode[];
  issue: ComplexPropertyIssue | null;
}

interface StructuralDocument {
  content: string;
  source: FrontmatterSource | null;
  root: StructuralNode;
  nodes: StructuralNode[];
  issues: ComplexPropertyIssue[];
  syntaxError: string | null;
  value: unknown;
}

const pathSegmentPattern = /^(?:[^.[\]]+|\[(?:\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\])/g;
function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lineEndingFor(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function sourceLines(content: string, startOffset = 0): SourceLine[] {
  const lines: SourceLine[] = [];
  let offset = startOffset;
  const matches = content.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  for (let index = 0; index < matches.length; index += 1) {
    const full = matches[index] ?? "";
    if (!full && index === matches.length - 1) {
      break;
    }
    const text = full.replace(/\r?\n$/, "");
    const indentMatch = /^[ \t]*/.exec(text)?.[0] ?? "";
    lines.push({
      full,
      text,
      start: offset,
      end: offset + full.length,
      line: lines.length + 1,
      indent: indentMatch.includes("\t") ? -1 : indentMatch.length,
    });
    offset += full.length;
  }
  return lines;
}

function readFrontmatter(content: string): FrontmatterSource | null {
  const withoutBom = content.startsWith("\ufeff") ? content.slice(1) : content;
  const openingMatch = /^(?:---)[ \t]*(?:\r\n|\n|$)/.exec(withoutBom);
  if (!openingMatch) {
    return null;
  }
  const openingLength = openingMatch[0].length;
  const remaining = withoutBom.slice(openingLength);
  const closingMatch = /^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|$)/m.exec(remaining);
  if (!closingMatch) {
    return {
      bom: content.startsWith("\ufeff") ? "\ufeff" : "",
      opening: sourceLines(openingMatch[0], content.startsWith("\ufeff") ? 1 : 0)[0] ?? {
        full: openingMatch[0],
        text: "---",
        start: content.startsWith("\ufeff") ? 1 : 0,
        end: openingLength + (content.startsWith("\ufeff") ? 1 : 0),
        line: 1,
        indent: 0,
      },
      lines: sourceLines(remaining, openingLength + (content.startsWith("\ufeff") ? 1 : 0)),
      closing: {
        full: "",
        text: "",
        start: content.length,
        end: content.length,
        line: 0,
        indent: 0,
      },
      bodyStart: content.length,
      body: "",
      lineEnding: lineEndingFor(content),
    };
  }

  const frontmatter = remaining.slice(0, closingMatch.index);
  const bodyStartWithoutBom = openingLength + closingMatch.index + closingMatch[0].length;
  const offset = content.startsWith("\ufeff") ? 1 : 0;
  const lines = sourceLines(frontmatter, offset + openingLength);
  const closingLines = sourceLines(closingMatch[0], offset + openingLength + closingMatch.index);
  const openingLines = sourceLines(openingMatch[0], offset);
  const opening = openingLines[0] ?? {
    full: openingMatch[0],
    text: "---",
    start: offset,
    end: offset + openingMatch[0].length,
    line: 1,
    indent: 0,
  };
  const closing = closingLines[0] ?? {
    full: closingMatch[0],
    text: closingMatch[0].replace(/\r?\n$/, ""),
    start: offset + openingLength + closingMatch.index,
    end: offset + bodyStartWithoutBom,
    line: lines.length + 2,
    indent: 0,
  };
  return {
    bom: content.startsWith("\ufeff") ? "\ufeff" : "",
    opening,
    lines,
    closing,
    bodyStart: offset + bodyStartWithoutBom,
    body: content.slice(offset + bodyStartWithoutBom),
    lineEnding: lineEndingFor(content),
  };
}

function pathToString(segments: readonly ComplexPropertyPathSegment[]): string {
  return segments
    .map((segment, index) => {
      if (typeof segment === "number") {
        return `[${segment}]`;
      }
      const safe = /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(segment);
      return index === 0
        ? safe
          ? segment
          : JSON.stringify(segment)
        : safe
          ? `.${segment}`
          : `[${JSON.stringify(segment)}]`;
    })
    .join("");
}

function parsePropertyPath(
  input: readonly ComplexPropertyPathSegment[] | string,
): ComplexPropertyPathSegment[] {
  if (typeof input !== "string") {
    if (input.length === 0) {
      throw new Error("A complex property path must contain at least one segment.");
    }
    return input.map((segment) => {
      if (typeof segment === "number") {
        if (!Number.isInteger(segment) || segment < 0) {
          throw new Error("List property path indexes must be non-negative integers.");
        }
        return segment;
      }
      if (!segment || segment.includes("\0")) {
        throw new Error("Complex property path keys must be non-empty and contain no null bytes.");
      }
      return segment;
    });
  }
  if (!input.trim() || input.length > 512 || input.includes("\0")) {
    throw new Error("Complex property paths must be non-empty and at most 512 characters.");
  }
  const segments: ComplexPropertyPathSegment[] = [];
  let cursor = 0;
  const source = input.trim();
  while (cursor < source.length) {
    if (source[cursor] === ".") {
      cursor += 1;
      if (cursor >= source.length) {
        throw new Error(`Invalid complex property path: ${input}`);
      }
    }
    const rest = source.slice(cursor);
    const match = pathSegmentPattern.exec(rest);
    pathSegmentPattern.lastIndex = 0;
    if (!match?.[0]) {
      throw new Error(`Invalid complex property path: ${input}`);
    }
    const token = match[0];
    if (token.startsWith("[")) {
      const inner = token.slice(1, -1);
      if (/^\d+$/u.test(inner)) {
        segments.push(Number(inner));
      } else {
        try {
          const parsed = inner.startsWith("'")
            ? inner.slice(1, -1).replaceAll("\\'", "'")
            : JSON.parse(inner);
          if (typeof parsed !== "string" || !parsed) {
            throw new Error("not a key");
          }
          segments.push(parsed);
        } catch {
          throw new Error(`Invalid complex property path: ${input}`);
        }
      }
    } else {
      segments.push(token);
    }
    cursor += token.length;
  }
  if (segments.length === 0) {
    throw new Error(`Invalid complex property path: ${input}`);
  }
  return segments;
}

function hasInlineUnsafeMarker(
  value: string,
): { kind: ComplexPropertyIssue["kind"]; message: string } | null {
  const trimmed = value.trim();
  if (/^(?:[|>])[+-]?[0-9]*$/u.test(trimmed)) {
    return {
      kind: "multiline",
      message: "Block scalar values are visible but cannot be patched losslessly.",
    };
  }
  if (
    /^(?:[!&*]|["'].*["']\s*:\s*$)/u.test(trimmed) ||
    /(?:^|\s)[&*][A-Za-z0-9_-]+/u.test(trimmed)
  ) {
    return {
      kind: trimmed.startsWith("!") ? "tag" : "anchor",
      message: "Anchors, aliases, and YAML tags are read-only in this editor.",
    };
  }
  if (/^(?:[!][^ ]+|[&*][^ ]+)/u.test(trimmed)) {
    return {
      kind: trimmed.startsWith("!") ? "tag" : "anchor",
      message: "Anchors, aliases, and YAML tags are read-only in this editor.",
    };
  }
  if (/^[[{]/u.test(trimmed)) {
    return {
      kind: "opaque",
      message: "Flow collections are preserved but not normalized by this editor.",
    };
  }
  return null;
}

function stripInlineComment(value: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function yamlScalarValue(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = parseDocument(`value: ${value}`, { uniqueKeys: true });
    if (parsed.errors.length > 0) {
      return value;
    }
    const json = parsed.toJSON() as Record<string, unknown>;
    return json.value;
  } catch {
    return value;
  }
}

function issueForNode(
  nodePath: string,
  line: SourceLine,
  rawValue: string,
): ComplexPropertyIssue | null {
  if (line.indent < 0) {
    return {
      kind: "opaque",
      path: nodePath,
      message: "Tab-indented YAML cannot be edited without changing its structure.",
    };
  }
  const marker = hasInlineUnsafeMarker(rawValue);
  if (!marker) {
    return null;
  }
  return { kind: marker.kind, path: nodePath, message: marker.message };
}

function parseStructuralDocument(content: string): StructuralDocument {
  const source = readFrontmatter(content);
  if (!source) {
    const root: StructuralNode = {
      path: "",
      kind: "mapping",
      line: { full: "", text: "", start: 0, end: 0, line: 1, indent: 0 },
      key: null,
      rawValue: "",
      value: {},
      valueStart: 0,
      valueEnd: 0,
      parentPath: null,
      children: [],
      issue: null,
    };
    return { content, source: null, root, nodes: [], issues: [], syntaxError: null, value: {} };
  }
  if (!source.closing.full) {
    const issue: ComplexPropertyIssue = {
      kind: "syntax-error",
      path: "",
      message: "The opening frontmatter marker has no closing marker.",
    };
    const root: StructuralNode = {
      path: "",
      kind: "syntax-error" as never,
      line: source.opening,
      key: null,
      rawValue: "",
      value: null,
      valueStart: 0,
      valueEnd: 0,
      parentPath: null,
      children: [],
      issue: issue,
    };
    return {
      content,
      source,
      root,
      nodes: [],
      issues: [issue],
      syntaxError: issue.message,
      value: null,
    };
  }

  const frontmatterText = source.lines.map((line) => line.full).join("");
  let parsedValue: unknown = {};
  let syntaxError: string | null = null;
  const issues: ComplexPropertyIssue[] = [];
  try {
    // Parse once without the duplicate-key policy so a duplicate is reported as an
    // addressability issue rather than being conflated with malformed YAML.  The
    // structural pass below still records the exact duplicate source lines.
    const parsed = parseDocument(frontmatterText, { uniqueKeys: false });
    if (parsed.errors.length > 0) {
      syntaxError = parsed.errors.map((error) => error.message).join(" ");
    } else {
      parsedValue = parsed.toJSON();
    }
  } catch (error) {
    syntaxError = error instanceof Error ? error.message : String(error);
  }
  if (syntaxError) {
    issues.push({
      kind: "syntax-error",
      path: "",
      message: `Frontmatter syntax is invalid: ${syntaxError}`,
    });
  }

  const root: StructuralNode = {
    path: "",
    kind: "mapping",
    line: source.opening,
    key: null,
    rawValue: "",
    value: parsedValue,
    valueStart: source.opening.end,
    valueEnd: source.closing.start,
    parentPath: null,
    children: [],
    issue: null,
  };
  const nodes: StructuralNode[] = [];
  const stack: Array<{
    indent: number;
    path: string;
    node: StructuralNode;
    kind: "mapping" | "sequence";
  }> = [{ indent: -1, path: "", node: root, kind: "mapping" }];
  const duplicateKeys = new Set<string>();
  const nodeByPath = new Map<string, StructuralNode>([["", root]]);
  const sequenceCounts = new Map<string, number>();

  for (const line of source.lines) {
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    while (stack.length > 1 && line.indent <= (stack.at(-1)?.indent ?? -1)) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (!parent || line.indent < 0 || line.indent <= parent.indent) {
      const issue: ComplexPropertyIssue = {
        kind: "opaque",
        path: "",
        message: `Could not determine YAML indentation at line ${line.line}.`,
      };
      issues.push(issue);
      continue;
    }
    const contentStart = line.indent;
    const contentText = line.text.slice(contentStart);
    const sequence = /^-[ \t]*(.*)$/u.exec(contentText);
    const map = /^([^:]+):[ \t]*(.*)$/u.exec(contentText);
    let nodePath: string;
    let key: string | null = null;
    let rawValue: string;
    let nodeKind: StructuralNode["kind"] = "scalar";
    let sequenceItemPath: string | null = null;
    if (sequence) {
      const index = sequenceCounts.get(parent.path) ?? 0;
      sequenceCounts.set(parent.path, index + 1);
      nodePath = `${parent.path}[${index}]`;
      rawValue = sequence[1] ?? "";
      if (!rawValue.trim()) {
        nodeKind = "mapping";
      } else {
        const sequenceMap = /^(.*?)(?::(?:[ \t]*(.*))?)$/u.exec(rawValue);
        if (sequenceMap?.[1] && sequenceMap[2] !== undefined) {
          key = sequenceMap[1].trim();
          sequenceItemPath = nodePath;
          nodePath = `${nodePath}.${key}`;
          rawValue = sequenceMap[2];
        }
      }
      if (parent.node.kind === "mapping") {
        parent.node.kind = "sequence";
      }
    } else if (map?.[1]) {
      key = map[1].trim();
      rawValue = map[2] ?? "";
      if (!key || key.startsWith("[") || key.startsWith("{")) {
        const issue: ComplexPropertyIssue = {
          kind: "opaque",
          path: parent.path,
          message: `Unsupported YAML key syntax at line ${line.line}.`,
        };
        issues.push(issue);
        continue;
      }
      if (
        (key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'"))
      ) {
        const issue: ComplexPropertyIssue = {
          kind: "opaque",
          path: parent.path,
          message: `Quoted YAML keys are preserved but cannot be addressed safely at line ${line.line}.`,
        };
        issues.push(issue);
      }
      nodePath = parent.path ? `${parent.path}.${key}` : key;
      if (parent.kind === "mapping") {
        const duplicateKey = `${parent.path}\0${key}`;
        if (nodeByPath.has(nodePath) || duplicateKeys.has(duplicateKey)) {
          duplicateKeys.add(duplicateKey);
          const issue: ComplexPropertyIssue = {
            kind: "duplicate",
            path: nodePath,
            message: `Duplicate YAML key ${key} cannot be edited without choosing a winner.`,
          };
          issues.push(issue);
        }
      }
    } else {
      const issue: ComplexPropertyIssue = {
        kind: "opaque",
        path: parent.path,
        message: `Unsupported YAML construct at line ${line.line}.`,
      };
      issues.push(issue);
      continue;
    }

    const issue = issueForNode(nodePath, line, rawValue);
    if (issue) {
      issues.push(issue);
    }
    if (rawValue.trim() === "") {
      nodeKind = "mapping";
    }
    if (issue?.kind === "multiline" || issue?.kind === "anchor" || issue?.kind === "tag") {
      nodeKind = "opaque";
    } else if (issue?.kind === "opaque") {
      nodeKind = "opaque";
    }
    const valueStart = line.start + line.text.indexOf(rawValue, contentStart);
    const valueEnd = valueStart + rawValue.length;
    let itemNode: StructuralNode | null = null;
    if (sequenceItemPath) {
      itemNode = {
        path: sequenceItemPath,
        kind: "mapping",
        line,
        key: null,
        rawValue: "",
        value: null,
        valueStart: line.start,
        valueEnd: line.end,
        parentPath: parent.path || null,
        children: [],
        issue: null,
      };
      parent.node.children.push(itemNode);
      nodes.push(itemNode);
      nodeByPath.set(sequenceItemPath, itemNode);
    }
    const effectiveParentPath = sequenceItemPath ?? parent.path;
    const node: StructuralNode = {
      path: nodePath,
      kind: nodeKind,
      line,
      key,
      rawValue,
      value: yamlScalarValue(rawValue),
      valueStart,
      valueEnd,
      parentPath: effectiveParentPath || null,
      children: [],
      issue,
    };
    (itemNode?.children ?? parent.node.children).push(node);
    nodes.push(node);
    if (!nodeByPath.has(nodePath)) {
      nodeByPath.set(nodePath, node);
    }
    const nextLine = source.lines[source.lines.indexOf(line) + 1];
    const markerOnly = /^(?:[&*!][^\s]+|[!][^\s]+)$/u.test(rawValue.trim());
    if (sequenceItemPath && itemNode) {
      stack.push({ indent: line.indent, path: sequenceItemPath, node: itemNode, kind: "mapping" });
    } else if (
      rawValue.trim() === "" ||
      (markerOnly && nextLine !== undefined && nextLine.indent > line.indent)
    ) {
      stack.push({ indent: line.indent, path: nodePath, node, kind: "mapping" });
    }
  }

  for (const issue of issues) {
    if (issue.kind === "duplicate") {
      root.issue = issue;
    }
  }
  return { content, source, root, nodes, issues, syntaxError, value: parsedValue };
}

function entryForNode(
  node: StructuralNode,
  issues: readonly ComplexPropertyIssue[],
): ComplexPropertyEntry {
  const issue = issues.find((candidate) => candidate.path === node.path || candidate.path === "");
  return {
    path: node.path,
    kind: issue?.kind ?? node.kind,
    value: node.value,
    rawValue: node.rawValue,
    editable: !issue && node.kind === "scalar",
    reason:
      issue?.message ??
      (node.kind === "scalar" ? null : "Only scalar leaves can be patched safely."),
    line: node.line.line,
  };
}

function hasIssueOnPath(
  document: StructuralDocument,
  segments: readonly ComplexPropertyPathSegment[],
): ComplexPropertyIssue | null {
  const target = pathToString(segments);
  const ancestors = [target];
  let cursor = target;
  while (cursor.includes(".") || cursor.includes("[")) {
    const dot = cursor.lastIndexOf(".");
    const bracket = cursor.lastIndexOf("[");
    const cut = Math.max(dot, bracket);
    cursor = cut > 0 ? cursor.slice(0, cut) : "";
    if (cursor) ancestors.push(cursor);
  }
  return (
    document.issues.find(
      (issue) =>
        issue.kind !== "duplicate" &&
        issue.kind !== "syntax-error" &&
        ancestors.includes(issue.path),
    ) ?? null
  );
}

function nodeAtPath(
  document: StructuralDocument,
  segments: readonly ComplexPropertyPathSegment[],
): StructuralNode | null {
  const wanted = pathToString(segments);
  return document.nodes.find((node) => node.path === wanted) ?? null;
}

function lastPathSegment(
  segments: readonly ComplexPropertyPathSegment[],
): ComplexPropertyPathSegment {
  const segment = segments.at(-1);
  if (segment === undefined) {
    throw new Error("A complex property path must contain at least one segment.");
  }
  return segment;
}

function lineWithReplacement(line: SourceLine, rawValue: string, nextValue: string): string {
  const relativeStart = Math.max(0, line.text.indexOf(rawValue, line.indent));
  const before = line.text.slice(0, relativeStart);
  const commentAt = rawValue.indexOf("#");
  const comment = commentAt >= 0 ? rawValue.slice(commentAt) : "";
  const nextRaw = comment ? `${nextValue}${nextValue ? " " : ""}${comment}` : nextValue;
  return `${before}${nextRaw}${line.full.slice(line.text.length)}`;
}

function serializedScalar(value: unknown, existingRaw = ""): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") {
    throw new Error("Only scalar string, number, boolean, or null values can be patched safely.");
  }
  const trimmed = stripInlineComment(existingRaw).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.stringify(value);
  }
  if (/^[A-Za-z0-9_./:@+~-]+$/u.test(value) && !/^(?:true|false|null|~|[-+]?\d)/iu.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function insertIndent(parent: StructuralNode | null): number {
  return parent ? Math.max(0, parent.line.indent) + 2 : 0;
}

function subtreeEndLine(document: StructuralDocument, node: StructuralNode): number {
  let end = node.line.line;
  for (const candidate of document.nodes) {
    if (
      candidate.path === node.path ||
      candidate.path.startsWith(`${node.path}.`) ||
      candidate.path.startsWith(`${node.path}[`)
    ) {
      end = Math.max(end, candidate.line.line);
    }
  }
  return end;
}

function lineIndexFor(document: StructuralDocument, lineNumber: number): number {
  const index = document.source?.lines.findIndex((line) => line.line === lineNumber) ?? -1;
  return index >= 0 ? index : 0;
}

function applyLines(document: StructuralDocument, operation: ComplexPropertyOperation): string {
  const source = document.source;
  if (!source?.closing.full) {
    const pathSegments = parsePropertyPath(operation.path);
    if (operation.kind === "remove") {
      throw new Error("Cannot remove a complex property from a note without frontmatter.");
    }
    const value = serializedScalar(operation.value);
    const lineEnding = lineEndingFor(document.content);
    const lines: string[] = [];
    for (let index = 0; index < pathSegments.length; index += 1) {
      const segment = pathSegments[index];
      if (typeof segment !== "string") {
        throw new Error("New complex properties may only create mapping keys.");
      }
      const indent = "  ".repeat(index);
      lines.push(`${indent}${segment}:${index === pathSegments.length - 1 ? ` ${value}` : ""}`);
    }
    const bom = document.content.startsWith("\ufeff") ? "\ufeff" : "";
    const body = document.content.startsWith("\ufeff")
      ? document.content.slice(1)
      : document.content;
    return `${bom}---${lineEnding}${lines.join(lineEnding)}${lineEnding}---${lineEnding}${body}`;
  }

  const segments = parsePropertyPath(operation.path);
  const target = nodeAtPath(document, segments);
  const globalSyntax = document.issues.find((issue) => issue.kind === "syntax-error");
  if (globalSyntax) {
    throw new Error(globalSyntax.message);
  }
  const duplicate = document.issues.find((issue) => issue.kind === "duplicate");
  if (duplicate) {
    throw new Error(duplicate.message);
  }
  const targetIssue = hasIssueOnPath(document, segments);
  if (targetIssue) {
    throw new Error(targetIssue.message);
  }
  if (operation.kind === "remove" && !target) {
    return (
      source.bom +
      source.opening.full +
      source.lines.map((line) => line.full).join("") +
      source.closing.full +
      source.body
    );
  }
  if (operation.kind === "set" && target) {
    if (target.kind !== "scalar") {
      throw new Error(
        "Only scalar leaves can be patched safely; the selected mapping or list is opaque.",
      );
    }
    const replacement = serializedScalar(operation.value, target.rawValue);
    const lineIndex = lineIndexFor(document, target.line.line);
    const lines = [...source.lines];
    const current = lines[lineIndex];
    if (!current) throw new Error("The selected YAML source line disappeared.");
    lines[lineIndex] = {
      ...current,
      full: lineWithReplacement(current, target.rawValue, replacement),
      text: lineWithReplacement(current, target.rawValue, replacement).replace(/\r?\n$/, ""),
    };
    return (
      source.bom +
      source.opening.full +
      lines.map((line) => line.full).join("") +
      source.closing.full +
      source.body
    );
  }
  if (operation.kind === "remove") {
    if (!target) {
      return (
        source.bom +
        source.opening.full +
        source.lines.map((line) => line.full).join("") +
        source.closing.full +
        source.body
      );
    }
    if (target.kind !== "scalar") {
      throw new Error(
        "Removing a mapping or sequence would require destructive YAML normalization.",
      );
    }
    const lineIndex = lineIndexFor(document, target.line.line);
    const lines = source.lines.filter((_line, index) => index !== lineIndex);
    return (
      source.bom +
      source.opening.full +
      lines.map((line) => line.full).join("") +
      source.closing.full +
      source.body
    );
  }

  const parentSegments = segments.slice(0, -1);
  const parent = parentSegments.length > 0 ? nodeAtPath(document, parentSegments) : document.root;
  const leaf = lastPathSegment(segments);
  if (typeof leaf === "number") {
    if (parent?.kind !== "sequence") {
      throw new Error("A numeric complex property path must address an existing YAML list.");
    }
    throw new Error(
      "Appending or replacing an absent list index would change list semantics; edit an existing item.",
    );
  }
  if (parent && parent.kind !== "mapping") {
    throw new Error("New keys can only be added to an existing YAML mapping.");
  }
  if (document.nodes.some((node) => node.path === pathToString(segments))) {
    throw new Error("The selected complex property path is not writable.");
  }
  const value = serializedScalar(operation.value);
  const indent = insertIndent(parent);
  const line = `${" ".repeat(indent)}${leaf}: ${value}${source.lineEnding}`;
  const index = parent?.path
    ? Math.min(source.lines.length, lineIndexFor(document, subtreeEndLine(document, parent)) + 1)
    : source.lines.length;
  const lines = [...source.lines];
  lines.splice(index, 0, {
    full: line,
    text: line.replace(/\r?\n$/, ""),
    start: 0,
    end: 0,
    line: 0,
    indent,
  });
  return (
    source.bom +
    source.opening.full +
    lines.map((candidate) => candidate.full).join("") +
    source.closing.full +
    source.body
  );
}

export function inspectComplexMarkdownProperties(content: string): ComplexPropertyInspection {
  const document = parseStructuralDocument(content);
  const entries = document.nodes.map((node) => entryForNode(node, document.issues));
  const hasSyntax = document.issues.some((issue) => issue.kind === "syntax-error");
  const hasUnsupported = document.issues.some((issue) => issue.kind !== "syntax-error");
  return {
    status: hasSyntax ? "syntax-error" : hasUnsupported ? "unsupported" : "editable",
    entries,
    value: document.value,
    issues: document.issues,
    message: hasSyntax
      ? (document.issues.find((issue) => issue.kind === "syntax-error")?.message ??
        "Frontmatter syntax is invalid.")
      : hasUnsupported
        ? "Some YAML constructs are preserved as read-only because rewriting them would normalize unknown bytes."
        : null,
  };
}

export function previewComplexMarkdownPropertyMutation(
  currentContent: string,
  operation: ComplexPropertyOperation,
  currentPath = "note.md",
  baseRevision: string | null = null,
): ComplexPropertyPreview {
  const segments = parsePropertyPath(operation.path);
  const propertyPath = pathToString(segments);
  const beforeHash = hashText(currentContent);
  const document = parseStructuralDocument(currentContent);
  const syntax = document.issues.find((issue) => issue.kind === "syntax-error");
  if (syntax) {
    return {
      status: "syntax-error",
      path: currentPath,
      propertyPath,
      baseRevision,
      before: currentContent,
      after: null,
      changed: false,
      beforeHash,
      afterHash: null,
      issues: document.issues,
      message: syntax.message,
    };
  }
  try {
    const after = applyLines(document, operation);
    return {
      status: "ready",
      path: currentPath,
      propertyPath,
      baseRevision,
      before: currentContent,
      after,
      changed: after !== currentContent,
      beforeHash,
      afterHash: hashText(after),
      issues: document.issues,
      message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unsupported",
      path: currentPath,
      propertyPath,
      baseRevision,
      before: currentContent,
      after: null,
      changed: false,
      beforeHash,
      afterHash: null,
      issues: document.issues,
      message,
    };
  }
}

export function applyComplexMarkdownPropertyMutation(
  currentContent: string,
  operation: ComplexPropertyOperation,
): { content: string; changed: boolean; propertyPath: string } {
  const preview = previewComplexMarkdownPropertyMutation(currentContent, operation);
  if (preview.status !== "ready" || preview.after === null) {
    throw new Error(preview.message ?? "This YAML property cannot be edited losslessly.");
  }
  return { content: preview.after, changed: preview.changed, propertyPath: preview.propertyPath };
}

export async function previewMarkdownNotePropertyMutation(
  vault: Pick<VaultMutationPort, "readText">,
  requestedPath: string,
  operation: ComplexPropertyOperation,
): Promise<ComplexPropertyPreview> {
  const normalizedPath = normalizeMarkdownNotePath(requestedPath);
  const snapshot = await vault.readText(normalizedPath);
  return previewComplexMarkdownPropertyMutation(
    snapshot.content,
    operation,
    normalizedPath,
    snapshot.revision,
  );
}

export async function mutateMarkdownNoteProperty(
  vault: VaultMutationPort,
  requestedPath: string,
  operation: ComplexPropertyOperation,
  expectedRevision?: string,
): Promise<ComplexPropertyMutationOutcome> {
  const normalizedPath = normalizeMarkdownNotePath(requestedPath);
  const snapshot: VaultTextSnapshot = await vault.readText(normalizedPath);
  const propertyPath = pathToString(parsePropertyPath(operation.path));
  if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) {
    return {
      status: "stale",
      path: normalizedPath,
      propertyPath,
      currentRevision: snapshot.revision,
    };
  }
  const preview = previewComplexMarkdownPropertyMutation(
    snapshot.content,
    operation,
    normalizedPath,
    snapshot.revision,
  );
  if (preview.status !== "ready" || preview.after === null) {
    return {
      status: preview.status === "syntax-error" ? "syntax-error" : "unsupported",
      path: normalizedPath,
      propertyPath,
      message: preview.message ?? "This YAML property cannot be edited losslessly.",
      issues: preview.issues,
    };
  }
  if (!preview.changed) {
    return {
      status: "committed",
      path: normalizedPath,
      revision: snapshot.revision,
      transactionId: "no-op",
      propertyPath,
      changed: false,
    };
  }
  const outcome = await vault.writeText(normalizedPath, preview.after, snapshot.revision);
  return { ...outcome, propertyPath, changed: true };
}

export function setComplexProperty(
  currentContent: string,
  propertyPath: readonly ComplexPropertyPathSegment[] | string,
  value: unknown,
): { content: string; changed: boolean; propertyPath: string } {
  return applyComplexMarkdownPropertyMutation(currentContent, {
    kind: "set",
    path: propertyPath,
    value,
  });
}

export function removeComplexProperty(
  currentContent: string,
  propertyPath: readonly ComplexPropertyPathSegment[] | string,
): { content: string; changed: boolean; propertyPath: string } {
  return applyComplexMarkdownPropertyMutation(currentContent, {
    kind: "remove",
    path: propertyPath,
  });
}

export const parseComplexPropertyPath = parsePropertyPath;
export const formatComplexPropertyPath = pathToString;
export const inspectMarkdownComplexProperties = inspectComplexMarkdownProperties;
export const previewMarkdownComplexPropertyMutation = previewComplexMarkdownPropertyMutation;
export const applyMarkdownComplexPropertyMutation = applyComplexMarkdownPropertyMutation;
