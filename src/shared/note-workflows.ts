export interface VaultNoteWorkflowSettings {
  templateFolder: string;
  templateDateFormat: string;
  templateTimeFormat: string;
  dailyNoteFolder: string;
  dailyNoteDateFormat: string;
  dailyNoteTemplate: string | null;
}

export const defaultVaultNoteWorkflowSettings: Readonly<VaultNoteWorkflowSettings> = {
  templateFolder: "Templates",
  templateDateFormat: "YYYY-MM-DD",
  templateTimeFormat: "HH:mm",
  dailyNoteFolder: "",
  dailyNoteDateFormat: "YYYY-MM-DD",
  dailyNoteTemplate: null,
};

const maxPathLength = 4_096;
const maxFormatLength = 256;
const privateSegments = new Set([".obsidian", ".git", ".trash"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedVisibleSegments(value: string, label: string): string[] {
  if (value.includes("\0") || value.length > maxPathLength) {
    throw new Error(`${label} must contain at most ${maxPathLength} characters and no null bytes.`);
  }
  const portable = value.trim().replaceAll("\\", "/");
  if (/^(?:\/|[a-z]:\/)/i.test(portable)) {
    throw new Error(`${label} must be relative to the vault.`);
  }
  const segments: string[] = [];
  for (const segment of portable.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error(`${label} cannot leave the vault.`);
    }
    const folded = segment.toLocaleLowerCase("en-US");
    if (
      segment.startsWith(".") ||
      privateSegments.has(folded) ||
      folded.startsWith(".threadleaf-")
    ) {
      throw new Error(`${label} cannot use hidden or private vault paths.`);
    }
    segments.push(segment);
  }
  return segments;
}

export function normalizeNoteWorkflowFolder(value: string, label = "Workflow folder"): string {
  return normalizedVisibleSegments(value, label).join("/");
}

export function normalizeNoteWorkflowFile(value: string, label = "Workflow note"): string {
  const segments = normalizedVisibleSegments(value, label);
  if (segments.length === 0) {
    throw new Error(`${label} must name a Markdown file.`);
  }
  const fileName = segments.at(-1) ?? "";
  if (!fileName.toLocaleLowerCase("en-US").endsWith(".md")) {
    segments[segments.length - 1] = `${fileName}.md`;
  }
  const normalized = segments.join("/");
  if (normalized.length > maxPathLength) {
    throw new Error(`${label} must contain at most ${maxPathLength} characters.`);
  }
  return normalized;
}

function parseFormat(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxFormatLength ||
    normalized.includes("\0") ||
    /[\r\n]/.test(normalized)
  ) {
    throw new Error(
      `${label} must contain between 1 and ${maxFormatLength} characters on one line.`,
    );
  }
  return normalized;
}

function parseFolder(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return normalizeNoteWorkflowFolder(value, label);
}

export function createDefaultVaultNoteWorkflowSettings(): VaultNoteWorkflowSettings {
  return { ...defaultVaultNoteWorkflowSettings };
}

export function parseVaultNoteWorkflowSettings(value: unknown): VaultNoteWorkflowSettings {
  if (!isRecord(value)) {
    throw new Error("Note workflow settings must be an object.");
  }
  const templateFolder = parseFolder(value.templateFolder, "Template folder");
  const dailyNoteFolder = parseFolder(value.dailyNoteFolder, "Daily note folder");
  if (value.dailyNoteTemplate !== null && typeof value.dailyNoteTemplate !== "string") {
    throw new Error("Daily note template must be a Markdown path or null.");
  }
  return {
    templateFolder,
    templateDateFormat: parseFormat(value.templateDateFormat, "Template date format"),
    templateTimeFormat: parseFormat(value.templateTimeFormat, "Template time format"),
    dailyNoteFolder,
    dailyNoteDateFormat: parseFormat(value.dailyNoteDateFormat, "Daily note date format"),
    dailyNoteTemplate:
      value.dailyNoteTemplate === null
        ? null
        : normalizeNoteWorkflowFile(value.dailyNoteTemplate, "Daily note template"),
  };
}

export function isNoteWorkflowTemplatePath(
  filePath: string,
  settings: Pick<VaultNoteWorkflowSettings, "templateFolder">,
): boolean {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeNoteWorkflowFile(filePath, "Template path");
  } catch {
    return false;
  }
  return settings.templateFolder === "" || normalizedPath.startsWith(`${settings.templateFolder}/`);
}
