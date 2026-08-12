import path from "node:path";
import moment, { type Moment } from "moment";
import { displayTitleFromVaultPath, normalizeMarkdownNotePath } from "../kernel/note-path";
import { normalizeNoteWorkflowFile, normalizeNoteWorkflowFolder } from "../shared/note-workflows";

export const DEFAULT_TEMPLATE_MAX_BYTES = 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const templateVariablePattern = /{{(title|date|time)(?::([^}\r\n]+))?}}/g;

export interface TemplateBinarySnapshot {
  path: string;
  bytes: Uint8Array;
  revision: string;
  size: number;
}

export type TemplateBinaryReadResult =
  | { status: "ready"; snapshot: TemplateBinarySnapshot }
  | { status: "too-large"; path: string; size: number };

export interface NoteTemplateReader {
  listMarkdownPaths(relativeDirectory?: string): Promise<string[]>;
  readBinary(relativePath: string, maxBytes: number): Promise<TemplateBinaryReadResult>;
}

export interface NoteTemplateContext {
  title: string;
  now: Moment;
  dateFormat: string;
  timeFormat: string;
}

export interface LoadedNoteTemplate {
  path: string;
  content: string;
  revision: string;
  size: number;
}

export interface RenderedNoteTemplate {
  content: string;
  sourcePath: string;
  sourceRevision: string;
  size: number;
}

export function noteTemplateTitle(targetPath: string): string {
  return displayTitleFromVaultPath(normalizeMarkdownNotePath(targetPath));
}

export function expandNoteTemplate(content: string, context: NoteTemplateContext): string {
  return content.replace(
    templateVariablePattern,
    (match, variable: string, customFormat?: string) => {
      if (variable === "title") {
        return customFormat === undefined ? context.title : match;
      }
      const format =
        customFormat?.trim() || (variable === "date" ? context.dateFormat : context.timeFormat);
      return context.now.format(format);
    },
  );
}

export async function loadNoteTemplate(
  reader: NoteTemplateReader,
  templatePath: string,
  maxBytes = DEFAULT_TEMPLATE_MAX_BYTES,
): Promise<LoadedNoteTemplate> {
  const normalizedPath = normalizeNoteWorkflowFile(templatePath, "Template path");
  const result = await reader.readBinary(normalizedPath, maxBytes);
  if (result.status === "too-large") {
    throw new Error(
      `Template ${normalizedPath} is ${result.size} bytes; the limit is ${maxBytes}.`,
    );
  }
  let content: string;
  try {
    content = textDecoder.decode(result.snapshot.bytes);
  } catch {
    throw new Error(`Template ${normalizedPath} is not valid UTF-8 text.`);
  }
  return {
    path: normalizedPath,
    content,
    revision: result.snapshot.revision,
    size: result.snapshot.size,
  };
}

export async function listNoteTemplates(
  reader: NoteTemplateReader,
  templateFolder: string,
): Promise<string[]> {
  const normalizedFolder = normalizeNoteWorkflowFolder(templateFolder, "Template folder");
  const paths = await reader.listMarkdownPaths(normalizedFolder);
  return paths
    .filter((filePath) => {
      const folded = filePath.toLocaleLowerCase("en-US");
      return (
        folded.endsWith(".md") &&
        (normalizedFolder === "" || filePath.startsWith(`${normalizedFolder}/`))
      );
    })
    .sort((left, right) => left.localeCompare(right, "en-US"));
}

export async function renderNoteTemplate(
  reader: NoteTemplateReader,
  templatePath: string,
  context: NoteTemplateContext,
): Promise<RenderedNoteTemplate> {
  const template = await loadNoteTemplate(reader, templatePath);
  return {
    content: expandNoteTemplate(template.content, context),
    sourcePath: template.path,
    sourceRevision: template.revision,
    size: template.size,
  };
}

export function dailyNotePath(
  dailyNoteFolder: string,
  dailyNoteDateFormat: string,
  now: Moment = moment(),
): string {
  const folder = normalizeNoteWorkflowFolder(dailyNoteFolder, "Daily note folder");
  const formatted = now.format(dailyNoteDateFormat).replaceAll("\\", "/");
  const datedPath = normalizeNoteWorkflowFile(formatted, "Daily note date format output");
  return normalizeMarkdownNotePath(folder ? path.posix.join(folder, datedPath) : datedPath);
}
