import { parse as parseYaml } from "yaml";
import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultWriteResult } from "../kernel/ports";
import {
  type NotePropertyType,
  type NotePropertyValue,
  notePropertyTypes,
  type WorkspacePropertyEditorSnapshot,
  type WorkspacePropertySummary,
} from "../shared/contracts";

export type { NotePropertyType, NotePropertyValue };
export { notePropertyTypes };

export type NotePropertySetOutcome = VaultWriteResult & {
  name: string;
  type: NotePropertyType;
  value: NotePropertyValue;
};

export type NotePropertyRemoveOutcome =
  | { status: "missing"; path: string; revision: string; name: string }
  | (VaultWriteResult & { name: string });

interface FrontmatterLine {
  full: string;
  text: string;
}

interface PropertyBlock {
  name: string;
  start: number;
  end: number;
}

interface FrontmatterLayout {
  bom: string;
  opening: string;
  lines: FrontmatterLine[];
  closing: string;
  body: string;
  lineEnding: "\n" | "\r\n";
}

interface SerializedProperty {
  value: NotePropertyValue;
  lines: string[];
}

export interface NotePropertyInspection {
  properties: WorkspacePropertySummary[];
  editor: WorkspacePropertyEditorSnapshot;
}

function lineEndingFor(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(value: string): FrontmatterLine[] {
  const matches = value.match(/[^\r\n]*(?:\r\n|\n|$)/g) ?? [];
  return matches
    .filter((line, index) => line.length > 0 || index < matches.length - 1)
    .map((full) => ({ full, text: full.replace(/\r?\n$/, "") }));
}

function frontmatterLayout(content: string): FrontmatterLayout | null {
  const opening = /^\ufeff?---[\t ]*(?:\r\n|\n)/.exec(content);
  if (!opening) {
    return null;
  }
  const remaining = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r\n|\n|$)/m.exec(remaining);
  if (!closing) {
    throw new Error(
      "Cannot edit properties because the opening frontmatter marker has no closing marker.",
    );
  }
  const frontmatter = remaining.slice(0, closing.index);
  return {
    bom: content.startsWith("\ufeff") ? "\ufeff" : "",
    opening: opening[0],
    lines: splitLines(frontmatter),
    closing: closing[0],
    body: remaining.slice(closing.index + closing[0].length),
    lineEnding: lineEndingFor(content),
  };
}

function validatePropertyName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      "Property names currently accept only letters, numbers, underscores, and hyphens.",
    );
  }
}

function propertyBlocks(lines: readonly FrontmatterLine[]): Map<string, PropertyBlock> {
  const blocks = new Map<string, PropertyBlock>();
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (!text.trim() || /^\s*#/.test(text)) {
      continue;
    }
    const property = /^([A-Za-z0-9_-]+):[\t ]*(.*)$/.exec(text);
    if (!property?.[1] || property[2] === undefined) {
      throw new Error(
        "Threadleaf will not mutate JSON or complex YAML frontmatter until it can preserve it losslessly.",
      );
    }
    const name = property[1];
    if (blocks.has(name)) {
      throw new Error(`Cannot edit frontmatter with a duplicate property: ${name}`);
    }

    let end = index + 1;
    const inlineValue = property[2].trim();
    while (end < lines.length && /^[\t ]+/.test(lines[end]?.text ?? "")) {
      const continuation = lines[end]?.text ?? "";
      if (!inlineValue && /^[\t ]+-[\t ]+.+$/.test(continuation)) {
        end += 1;
        continue;
      }
      throw new Error(
        `Cannot edit property ${name} because nested or block YAML cannot be patched losslessly.`,
      );
    }
    if (/^[>|][+-]?[0-9]*$/.test(inlineValue)) {
      throw new Error(
        `Cannot edit property ${name} because nested or block YAML cannot be patched losslessly.`,
      );
    }
    blocks.set(name, { name, start: index, end });
    index = end - 1;
  }
  return blocks;
}

function assertSingleLine(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${label} must fit on one line.`);
  }
}

function parseListValue(rawValue: string): string[] {
  assertSingleLine(rawValue, "List value");
  const trimmed = rawValue.trim();
  if (trimmed === "") {
    return [];
  }
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error("List value must be a JSON array or a comma-separated list.", {
        cause: error,
      });
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
      throw new Error("List JSON must contain only strings.");
    }
    return parsed;
  }
  const values = rawValue.split(",").map((value) => value.trim());
  if (values.some((value) => value.length === 0)) {
    throw new Error("Comma-separated list values may not contain empty items.");
  }
  return values;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (monthLengths[month - 1] ?? 0);
}

function isDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match?.[1]) {
    return false;
  }
  return (
    isCalendarDate(match[1]) &&
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    Number(match[4]) <= 59
  );
}

function unsupportedPropertyValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function propertySummary(name: string, value: unknown): WorkspacePropertySummary {
  if (typeof value === "boolean") {
    return { name, type: "checkbox", value, rawValue: String(value) };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return { name, type: "number", value, rawValue: String(value) };
  }
  if (typeof value === "string") {
    const type = isCalendarDate(value) ? "date" : isDateTime(value) ? "datetime" : "text";
    return { name, type, value, rawValue: value };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { name, type: "list", value, rawValue: JSON.stringify(value) };
  }
  const visible = unsupportedPropertyValue(value);
  return { name, type: "unsupported", value: visible, rawValue: visible };
}

function fallbackPropertySummaries(
  fallback: Readonly<Record<string, string | string[]>>,
): WorkspacePropertySummary[] {
  return Object.entries(fallback).map(([name, value]) => ({
    name,
    type: "unsupported",
    value,
    rawValue: Array.isArray(value) ? JSON.stringify(value) : value,
  }));
}

function inspectionFailure(
  message: string,
  fallback: Readonly<Record<string, string | string[]>>,
): NotePropertyInspection {
  return {
    properties: fallbackPropertySummaries(fallback),
    editor: { editable: false, message },
  };
}

export function inspectMarkdownNoteProperties(
  content: string,
  fallback: Readonly<Record<string, string | string[]>> = {},
): NotePropertyInspection {
  let layout: FrontmatterLayout | null;
  try {
    layout = frontmatterLayout(content);
  } catch (error) {
    return inspectionFailure(error instanceof Error ? error.message : String(error), fallback);
  }
  if (!layout) {
    return { properties: [], editor: { editable: true, message: null } };
  }

  const frontmatterSource = layout.lines.map((line) => line.full).join("");
  if (!frontmatterSource.trim()) {
    return { properties: [], editor: { editable: true, message: null } };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterSource, { uniqueKeys: true });
  } catch (error) {
    return inspectionFailure(
      `Properties are visible through the index, but this frontmatter cannot be edited safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
      fallback,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return inspectionFailure(
      "Threadleaf can edit only a top-level YAML property map. This frontmatter remains read-only.",
      fallback,
    );
  }

  const properties = Object.entries(parsed).map(([name, value]) => propertySummary(name, value));
  try {
    propertyBlocks(layout.lines);
  } catch (error) {
    return {
      properties,
      editor: {
        editable: false,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (properties.some((property) => property.type === "unsupported")) {
    return {
      properties,
      editor: {
        editable: false,
        message:
          "This note contains complex property values. Threadleaf shows them but will not rewrite this frontmatter yet.",
      },
    };
  }
  return { properties, editor: { editable: true, message: null } };
}

function serializeProperty(
  name: string,
  rawValue: string,
  type: NotePropertyType,
): SerializedProperty {
  validatePropertyName(name);
  if (type === "text") {
    assertSingleLine(rawValue, "Text property value");
    return { value: rawValue, lines: [`${name}: ${JSON.stringify(rawValue)}`] };
  }
  if (type === "list") {
    const value = parseListValue(rawValue);
    return {
      value,
      lines:
        value.length === 0
          ? [`${name}: []`]
          : [`${name}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`)],
    };
  }
  if (type === "number") {
    const trimmed = rawValue.trim();
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
      throw new Error("Number property value must be a literal integer or decimal.");
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      throw new Error("Number property value must be finite.");
    }
    return { value, lines: [`${name}: ${String(value)}`] };
  }
  if (type === "checkbox") {
    const normalized = rawValue.trim().toLocaleLowerCase("en-US");
    if (normalized !== "true" && normalized !== "false") {
      throw new Error("Checkbox property value must be true or false.");
    }
    const value = normalized === "true";
    return { value, lines: [`${name}: ${String(value)}`] };
  }
  const trimmed = rawValue.trim();
  if (type === "date") {
    if (!isCalendarDate(trimmed)) {
      throw new Error("Date property value must be a real calendar date in YYYY-MM-DD form.");
    }
    return { value: trimmed, lines: [`${name}: ${trimmed}`] };
  }
  if (!isDateTime(trimmed)) {
    throw new Error(
      "Datetime property value must use YYYY-MM-DDTHH:mm:ss with a valid date and time.",
    );
  }
  return { value: trimmed, lines: [`${name}: ${trimmed}`] };
}

export function applyNotePropertySet(
  currentContent: string,
  name: string,
  rawValue: string,
  type: NotePropertyType,
): { content: string; value: NotePropertyValue } {
  const serialized = serializeProperty(name, rawValue, type);
  const layout = frontmatterLayout(currentContent);
  if (!layout) {
    const lineEnding = lineEndingFor(currentContent);
    const bom = currentContent.startsWith("\ufeff") ? "\ufeff" : "";
    const body = bom ? currentContent.slice(1) : currentContent;
    return {
      value: serialized.value,
      content: `${bom}---${lineEnding}${serialized.lines.join(lineEnding)}${lineEnding}---${lineEnding}${body}`,
    };
  }

  const blocks = propertyBlocks(layout.lines);
  const existing = blocks.get(name);
  const replacement = serialized.lines.map((line) => `${line}${layout.lineEnding}`);
  const lines = [...layout.lines];
  if (existing) {
    lines.splice(
      existing.start,
      existing.end - existing.start,
      ...replacement.map((full) => ({
        full,
        text: full.replace(/\r?\n$/, ""),
      })),
    );
  } else {
    lines.push(...replacement.map((full) => ({ full, text: full.replace(/\r?\n$/, "") })));
  }
  return {
    value: serialized.value,
    content: `${layout.opening}${lines.map((line) => line.full).join("")}${layout.closing}${layout.body}`,
  };
}

export function applyNotePropertyRemove(
  currentContent: string,
  name: string,
): { content: string; removed: boolean } {
  validatePropertyName(name);
  const layout = frontmatterLayout(currentContent);
  if (!layout) {
    return { content: currentContent, removed: false };
  }
  const blocks = propertyBlocks(layout.lines);
  const existing = blocks.get(name);
  if (!existing) {
    return { content: currentContent, removed: false };
  }
  const lines = [...layout.lines];
  lines.splice(existing.start, existing.end - existing.start);
  const frontmatter = lines.map((line) => line.full).join("");
  if (!frontmatter.trim()) {
    return { content: `${layout.bom}${layout.body}`, removed: true };
  }
  return {
    content: `${layout.opening}${frontmatter}${layout.closing}${layout.body}`,
    removed: true,
  };
}

export async function setMarkdownNoteProperty(
  vault: VaultMutationPort,
  requestedPath: string,
  name: string,
  rawValue: string,
  type: NotePropertyType,
): Promise<NotePropertySetOutcome> {
  const normalizedPath = normalizeMarkdownNotePath(requestedPath);
  const existing = await vault.readText(normalizedPath);
  const proposal = applyNotePropertySet(existing.content, name, rawValue, type);
  const outcome = await vault.writeText(normalizedPath, proposal.content, existing.revision);
  return { ...outcome, name, type, value: proposal.value };
}

export async function removeMarkdownNoteProperty(
  vault: VaultMutationPort,
  requestedPath: string,
  name: string,
): Promise<NotePropertyRemoveOutcome> {
  const normalizedPath = normalizeMarkdownNotePath(requestedPath);
  const existing = await vault.readText(normalizedPath);
  const proposal = applyNotePropertyRemove(existing.content, name);
  if (!proposal.removed) {
    return { status: "missing", path: normalizedPath, revision: existing.revision, name };
  }
  const outcome = await vault.writeText(normalizedPath, proposal.content, existing.revision);
  return { ...outcome, name };
}
