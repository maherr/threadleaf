import { isAbsolute, parse, resolve } from "node:path";
import {
  canonicalizePotentialPath,
  hasHiddenVaultSegment,
  isPathInside,
  normalizeVaultPath,
} from "../kernel/path-policy";
import {
  maximumPublishNoteHtmlBytes,
  type PublishNoteExportRequest,
  publishNoteExportVersion,
} from "../shared/publish-export";

const digestPattern = /^[a-f0-9]{64}$/u;
const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function readDevelopmentPublishExportPath(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (isPackaged) {
    return undefined;
  }
  const configuredPath = environment.THREADLEAF_PUBLISH_EXPORT_PATH?.trim();
  if (!configuredPath) {
    return undefined;
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error("The development published-note export path must be absolute.");
  }
  return ensureHtmlExtension(resolve(configuredPath));
}

export async function isPublishExportTargetOutsideVault(
  vaultPath: string,
  targetPath: string,
): Promise<boolean> {
  const [canonicalVaultPath, canonicalTargetPath] = await Promise.all([
    canonicalizePotentialPath(vaultPath),
    canonicalizePotentialPath(targetPath),
  ]);
  return !isPathInside(canonicalVaultPath, canonicalTargetPath);
}

export function ensureHtmlExtension(filePath: string): string {
  return filePath.toLocaleLowerCase("en-US").endsWith(".html") ? filePath : `${filePath}.html`;
}

export function suggestedPublishedNoteFilename(sourcePath: string): string {
  const sourceName = parse(sourcePath).name;
  let safeName = sourceName
    .replace(/[<>:"/\\|?*]/gu, "-")
    .replace(/\p{Cc}/gu, "-")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 120);
  if (!safeName) {
    safeName = "note";
  } else if (windowsReservedName.test(safeName)) {
    safeName = `note-${safeName}`;
  }
  return `${safeName}.html`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePublishNoteExportRequest(value: unknown): PublishNoteExportRequest {
  if (!isRecord(value) || value.version !== publishNoteExportVersion) {
    throw new Error("The published-note export request has an unsupported version.");
  }
  const { expectedVaultId, sourcePath, expectedRevision, html } = value;
  if (typeof expectedVaultId !== "string" || !digestPattern.test(expectedVaultId)) {
    throw new Error("The published-note export request has an invalid vault identity.");
  }
  if (typeof expectedRevision !== "string" || !digestPattern.test(expectedRevision)) {
    throw new Error("The published-note export request has an invalid note revision.");
  }
  if (typeof sourcePath !== "string" || sourcePath.length > 4096) {
    throw new Error("The published-note export request has an invalid note path.");
  }
  const normalizedPath = normalizeVaultPath(sourcePath);
  if (
    normalizedPath !== sourcePath ||
    hasHiddenVaultSegment(normalizedPath) ||
    !normalizedPath.toLocaleLowerCase("en-US").endsWith(".md")
  ) {
    throw new Error("Published-note exports require a visible normalized Markdown path.");
  }
  if (
    typeof html !== "string" ||
    html.length === 0 ||
    html.length > maximumPublishNoteHtmlBytes ||
    !html.startsWith("<!doctype html>") ||
    !html.includes('data-threadleaf-publish-version="1"')
  ) {
    throw new Error("The published-note export request has invalid standalone HTML.");
  }
  return {
    version: publishNoteExportVersion,
    expectedVaultId,
    sourcePath: normalizedPath,
    expectedRevision,
    html,
  };
}
