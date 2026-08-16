import path from "node:path";
import { printParseErrorCode, visit } from "jsonc-parser";
import { normalizedVaultPathIdentity } from "../kernel/path-policy";
import type { JsonCanvasDocument } from "../shared/json-canvas";
import { resolveCanvasAttachmentTarget } from "./canvas-attachment-service";

export interface JsonCanvasAttachmentRewrite {
  nodeIndex: number;
  field: "file" | "background";
  location: string;
  line: number;
  beforeTarget: string;
  afterTarget: string;
}

export type JsonCanvasAttachmentRewriteResult =
  | {
      status: "ready";
      content: string;
      rewrites: JsonCanvasAttachmentRewrite[];
    }
  | {
      status: "blocked";
      kind: "reference" | "unreadable" | "unsupported";
      location: string;
      line: number;
      target: string;
      message: string;
    };

interface JsonStringToken {
  nodeIndex: number;
  field: "file" | "background";
  location: string;
  line: number;
  offset: number;
  length: number;
  value: string;
}

interface Replacement {
  token: JsonStringToken;
  value: string;
}

function jsonLocation(pathSegments: readonly (string | number)[]): string {
  let location = "$";
  for (const segment of pathSegments) {
    if (typeof segment === "number") {
      location += `[${segment}]`;
    } else if (/^[A-Za-z_$][\w$]*$/u.test(segment)) {
      location += `.${segment}`;
    } else {
      location += `[${JSON.stringify(segment)}]`;
    }
  }
  return location;
}

function blocked(
  kind: Extract<JsonCanvasAttachmentRewriteResult, { status: "blocked" }>["kind"],
  location: string,
  line: number,
  target: string,
  message: string,
): JsonCanvasAttachmentRewriteResult {
  return { status: "blocked", kind, location, line, target, message };
}

function normalizedTextKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function targetMayReferenceSource(rawTarget: string, sourcePath: string): boolean {
  const trimmed = rawTarget.trim().replace(/^<|>$/gu, "");
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) || trimmed.startsWith("//")) {
    return false;
  }
  const pathPart = trimmed.split(/[?#]/u, 1)[0] ?? "";
  let comparablePath = pathPart.replaceAll("\\", "/");
  try {
    comparablePath = decodeURIComponent(pathPart).replaceAll("\\", "/");
  } catch {
    // Invalid URL encoding can still lexically name the source. Keep a
    // basename match fail-closed instead of treating parse failure as absence.
  }
  return (
    normalizedTextKey(path.posix.basename(comparablePath)) ===
    normalizedTextKey(path.posix.basename(sourcePath))
  );
}

function encodePathSegment(segment: string): string {
  if (segment === "." || segment === "..") return segment;
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodedPath(filePath: string): string {
  return filePath.split("/").map(encodePathSegment).join("/");
}

function replacementTarget(
  canvasPath: string,
  rawTarget: string,
  targetPath: string,
): string | null {
  if (rawTarget.trim() !== rawTarget || rawTarget.includes("\\")) return null;
  if (rawTarget.startsWith("<") || rawTarget.endsWith(">")) return null;

  const delimiterAt = [rawTarget.indexOf("?"), rawTarget.indexOf("#")]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), rawTarget.length);
  const encodedSourcePath = rawTarget.slice(0, delimiterAt);
  const suffix = rawTarget.slice(delimiterAt);
  let decodedSourcePath: string;
  try {
    decodedSourcePath = decodeURIComponent(encodedSourcePath);
  } catch {
    return null;
  }

  const explicitlyRooted = encodedSourcePath.startsWith("/");
  const explicitlyRelative =
    decodedSourcePath === "." ||
    decodedSourcePath === ".." ||
    decodedSourcePath.startsWith("./") ||
    decodedSourcePath.startsWith("../");
  if (explicitlyRooted) return `/${encodedPath(targetPath)}${suffix}`;
  if (!explicitlyRelative) return `${encodedPath(targetPath)}${suffix}`;

  const relative = path.posix.relative(path.posix.dirname(canvasPath), targetPath);
  const encodedRelative = encodedPath(relative);
  return `${encodedRelative.startsWith(".") ? encodedRelative : `./${encodedRelative}`}${suffix}`;
}

function inspectStringTokens(
  body: string,
):
  | { status: "ready"; tokens: JsonStringToken[] }
  | Extract<JsonCanvasAttachmentRewriteResult, { status: "blocked" }> {
  const tokens: JsonStringToken[] = [];
  const propertiesByObject = new Map<string, Set<string>>();
  let failure: Extract<JsonCanvasAttachmentRewriteResult, { status: "blocked" }> | null = null;

  visit(
    body,
    {
      onObjectBegin: (_offset, _length, _line, _column, pathSupplier) => {
        propertiesByObject.set(JSON.stringify(pathSupplier()), new Set());
      },
      onObjectProperty: (property, _offset, _length, line, _column, pathSupplier) => {
        if (failure) return;
        const parentPath = pathSupplier();
        const key = JSON.stringify(parentPath);
        const properties = propertiesByObject.get(key) ?? new Set<string>();
        propertiesByObject.set(key, properties);
        if (properties.has(property)) {
          failure = {
            status: "blocked",
            kind: "unreadable",
            location: jsonLocation([...parentPath, property]),
            line: line + 1,
            target: `Duplicate JSON property ${JSON.stringify(property)}`,
            message: "Canvas contains duplicate object keys and cannot be rewritten safely.",
          };
          return;
        }
        properties.add(property);
      },
      onLiteralValue: (value, offset, length, line, _column, pathSupplier) => {
        if (failure || typeof value !== "string") return;
        const valuePath = pathSupplier();
        if (
          valuePath.length !== 3 ||
          valuePath[0] !== "nodes" ||
          typeof valuePath[1] !== "number" ||
          (valuePath[2] !== "file" && valuePath[2] !== "background")
        ) {
          return;
        }
        const rawToken = body.slice(offset, offset + length);
        try {
          if (JSON.parse(rawToken) !== value) throw new Error("literal mismatch");
        } catch {
          failure = {
            status: "blocked",
            kind: "unreadable",
            location: jsonLocation(valuePath),
            line: line + 1,
            target: "Canvas string token could not be verified",
            message: "Canvas token offsets did not reproduce the parsed string value.",
          };
          return;
        }
        tokens.push({
          nodeIndex: valuePath[1],
          field: valuePath[2],
          location: jsonLocation(valuePath),
          line: line + 1,
          offset,
          length,
          value,
        });
      },
      onError: (error, _offset, _length, line) => {
        if (failure) return;
        failure = {
          status: "blocked",
          kind: "unreadable",
          location: "$",
          line: line + 1,
          target: printParseErrorCode(error),
          message: "Canvas is not strict JSON and cannot be rewritten safely.",
        };
      },
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false },
  );

  return failure ?? { status: "ready", tokens };
}

/**
 * Replace only proven JSON Canvas attachment string tokens.
 *
 * The supplied document must come from Threadleaf's strict domain parser. The
 * lexical visitor is independently checked against that semantic tree before
 * any offset is accepted.
 */
export function rewriteJsonCanvasAttachmentReferences(
  input: Uint8Array,
  document: JsonCanvasDocument,
  canvasPath: string,
  sourcePath: string,
  targetPath: string,
): JsonCanvasAttachmentRewriteResult {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    return blocked(
      "unreadable",
      "$",
      1,
      "Canvas is not valid UTF-8",
      "Canvas cannot be rewritten.",
    );
  }
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom ? source.slice(1) : source;
  const inspection = inspectStringTokens(body);
  if (inspection.status === "blocked") return inspection;

  const tokensByField = new Map<string, JsonStringToken[]>();
  for (const token of inspection.tokens) {
    const key = `${token.nodeIndex}:${token.field}`;
    const matches = tokensByField.get(key) ?? [];
    matches.push(token);
    tokensByField.set(key, matches);
  }

  const replacements: Replacement[] = [];
  const rewrites: JsonCanvasAttachmentRewrite[] = [];
  for (const [nodeIndex, node] of (document.nodes ?? []).entries()) {
    const field =
      node.type === "file" && typeof node.file === "string"
        ? ({ name: "file", value: node.file } as const)
        : node.type === "group" && typeof node.background === "string"
          ? ({ name: "background", value: node.background } as const)
          : null;
    if (!field) continue;
    const location = `$.nodes[${nodeIndex}].${field.name}`;
    const matchingTokens = tokensByField.get(`${nodeIndex}:${field.name}`) ?? [];
    if (matchingTokens.length !== 1 || matchingTokens[0]?.value !== field.value) {
      return blocked(
        "unreadable",
        location,
        matchingTokens[0]?.line ?? 1,
        field.value,
        "Canvas lexical tokens do not match its validated document model.",
      );
    }
    const token = matchingTokens[0];
    const resolution = resolveCanvasAttachmentTarget(canvasPath, field.value);
    const referencesSource =
      resolution.status === "resolved"
        ? normalizedVaultPathIdentity(resolution.path) === normalizedVaultPathIdentity(sourcePath)
        : targetMayReferenceSource(field.value, sourcePath);
    if (!referencesSource) continue;
    if (resolution.status !== "resolved") {
      return blocked(
        "reference",
        token.location,
        token.line,
        field.value,
        "Canvas contains a local-looking attachment reference that cannot be resolved safely.",
      );
    }
    const afterTarget = replacementTarget(canvasPath, field.value, targetPath);
    if (afterTarget === null) {
      return blocked(
        "unsupported",
        token.location,
        token.line,
        field.value,
        "Canvas attachment path spelling is not supported for lossless rewriting.",
      );
    }
    replacements.push({ token, value: afterTarget });
    rewrites.push({
      nodeIndex,
      field: field.name,
      location: token.location,
      line: token.line,
      beforeTarget: field.value,
      afterTarget,
    });
  }

  let rewrittenBody = body;
  for (const replacement of replacements.sort(
    (left, right) => right.token.offset - left.token.offset,
  )) {
    const { offset, length } = replacement.token;
    rewrittenBody = `${rewrittenBody.slice(0, offset)}${JSON.stringify(replacement.value)}${rewrittenBody.slice(offset + length)}`;
  }
  return { status: "ready", content: `${bom}${rewrittenBody}`, rewrites };
}
