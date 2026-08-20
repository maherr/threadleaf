import path from "node:path";
import { parseDocument } from "yaml";
import type { DocumentMetadataSnapshot } from "../kernel/metadata-index";
import type {
  WorkspaceBaseColumn,
  WorkspaceBaseDiagnostic,
  WorkspaceBaseRow,
  WorkspaceBaseSnapshot,
  WorkspaceBaseViewSnapshot,
} from "../shared/contracts";

export const maximumBaseBytes = 1024 * 1024;
const maximumBaseColumns = 32;
const maximumBaseRows = 500;

type BaseRecord = Record<string, unknown>;
type BaseFilter = string | { and?: BaseFilter[]; or?: BaseFilter[]; not?: BaseFilter[] };

function record(value: unknown): BaseRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as BaseRecord)
    : null;
}

function titleForPath(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.base$/iu, "") || filePath;
}

function noteTitle(filePath: string): string {
  return path.posix.basename(filePath).replace(/\.md$/iu, "") || filePath;
}

function propertyName(property: string): string {
  if (property.startsWith("note.")) return property.slice(5);
  const bracket = /^note\[(?:"([^"]+)"|'([^']+)')\]$/u.exec(property);
  return bracket?.[1] ?? bracket?.[2] ?? property;
}

function propertyValue(document: DocumentMetadataSnapshot, property: string): unknown {
  switch (property) {
    case "file.name":
      return noteTitle(document.path);
    case "file.path":
      return document.path;
    case "file.ext":
    case "file.extension":
      return path.posix.extname(document.path).slice(1);
    case "file.folder": {
      const folder = path.posix.dirname(document.path);
      return folder === "." ? "" : folder;
    }
    case "file.tags":
      return document.tags;
    default:
      return document.properties[propertyName(property)] ?? null;
  }
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(", ");
  return String(value);
}

function scalarLiteral(source: string): unknown {
  const value = source.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  const leftValues = Array.isArray(left) ? left : [left];
  if (operator === "==") return leftValues.some((value) => String(value) === String(right));
  if (operator === "!=") return leftValues.every((value) => String(value) !== String(right));
  const leftNumber = Number(leftValues[0]);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    if (operator === ">") return leftNumber > rightNumber;
    if (operator === ">=") return leftNumber >= rightNumber;
    if (operator === "<") return leftNumber < rightNumber;
    if (operator === "<=") return leftNumber <= rightNumber;
  }
  const order = String(leftValues[0] ?? "").localeCompare(String(right), "en-US");
  if (operator === ">") return order > 0;
  if (operator === ">=") return order >= 0;
  if (operator === "<") return order < 0;
  return operator === "<=" && order <= 0;
}

function evaluateStatement(document: DocumentMetadataSnapshot, statement: string): boolean | null {
  const tag = /^file\.hasTag\((?:"([^"]+)"|'([^']+)')\)$/u.exec(statement.trim());
  if (tag) {
    const requested = (tag[1] ?? tag[2] ?? "").replace(/^#/u, "").toLocaleLowerCase("en-US");
    return document.tags.some(
      (candidate) => candidate.replace(/^#/u, "").toLocaleLowerCase("en-US") === requested,
    );
  }
  const folder = /^file\.inFolder\((?:"([^"]*)"|'([^']*)')\)$/u.exec(statement.trim());
  if (folder) {
    const requested = (folder[1] ?? folder[2] ?? "").replace(/^\/+|\/+$/gu, "");
    const current = path.posix.dirname(document.path);
    return current === requested || current.startsWith(`${requested}/`);
  }
  const comparison = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/u.exec(statement.trim());
  if (!comparison) return null;
  const property = comparison[1]?.trim() ?? "";
  if (
    !/^(?:file\.(?:name|path|ext|extension|folder|tags)|note\.[A-Za-z0-9_-]+|note\[(?:"[^"]+"|'[^']+')\]|[A-Za-z0-9_-]+)$/u.test(
      property,
    )
  ) {
    return null;
  }
  return compare(
    propertyValue(document, property),
    comparison[2] ?? "",
    scalarLiteral(comparison[3] ?? ""),
  );
}

function evaluateFilter(document: DocumentMetadataSnapshot, filter: BaseFilter): boolean | null {
  if (typeof filter === "string") return evaluateStatement(document, filter);
  const shape = record(filter);
  if (!shape) return null;
  const keys = Object.keys(shape);
  if (keys.length !== 1) return null;
  const key = keys[0];
  const children = key ? shape[key] : null;
  if (!Array.isArray(children)) return null;
  const values = children.map((child) => evaluateFilter(document, child as BaseFilter));
  if (values.some((value) => value === null)) return null;
  if (key === "and") return values.every(Boolean);
  if (key === "or") return values.some(Boolean);
  if (key === "not") return !values.some(Boolean);
  return null;
}

function collectColumns(
  view: BaseRecord,
  root: BaseRecord,
  documents: readonly DocumentMetadataSnapshot[],
  diagnostics: WorkspaceBaseDiagnostic[],
  diagnosticPath: string,
): WorkspaceBaseColumn[] {
  const configured = Array.isArray(view.order)
    ? view.order.filter((value): value is string => typeof value === "string")
    : [];
  const discovered = [...new Set(documents.flatMap((document) => Object.keys(document.properties)))]
    .sort((left, right) => left.localeCompare(right, "en-US"))
    .map((name) => `note.${name}`);
  const properties = record(root.properties) ?? {};
  const order = (
    configured.length > 0 ? configured : ["file.name", ...discovered.slice(0, 7)]
  ).slice(0, maximumBaseColumns);
  return order.map((property) => {
    if (property.startsWith("formula.")) {
      diagnostics.push({
        code: "unsupported-formula",
        path: `${diagnosticPath}.order`,
        message: `Formula column ${property} is preserved but not evaluated yet.`,
      });
    }
    const configuredProperty = record(properties[property]);
    const label =
      typeof configuredProperty?.displayName === "string"
        ? configuredProperty.displayName
        : property === "file.name"
          ? "Name"
          : propertyName(property);
    return { property, label };
  });
}

function compareDocuments(
  left: DocumentMetadataSnapshot,
  right: DocumentMetadataSnapshot,
  sort: readonly BaseRecord[],
): number {
  for (const item of sort) {
    if (typeof item.property !== "string") continue;
    const direction = item.direction === "DESC" ? -1 : 1;
    const order = displayValue(propertyValue(left, item.property)).localeCompare(
      displayValue(propertyValue(right, item.property)),
      "en-US",
      { numeric: true, sensitivity: "base" },
    );
    if (order !== 0) return order * direction;
  }
  return left.path.localeCompare(right.path, "en-US");
}

function buildView(
  viewValue: unknown,
  viewIndex: number,
  root: BaseRecord,
  documents: readonly DocumentMetadataSnapshot[],
  diagnostics: WorkspaceBaseDiagnostic[],
): WorkspaceBaseViewSnapshot {
  const view = record(viewValue) ?? {};
  const diagnosticPath = `views[${viewIndex}]`;
  const name =
    typeof view.name === "string" && view.name.trim() ? view.name.trim() : `View ${viewIndex + 1}`;
  const type = typeof view.type === "string" ? view.type : "table";
  const columns = collectColumns(view, root, documents, diagnostics, diagnosticPath);
  const filters = [root.filters, view.filters].filter(
    (value): value is BaseFilter => typeof value === "string" || record(value) !== null,
  );
  let unsupportedFilter = false;
  const filtered = documents.filter((document) => {
    for (const filter of filters) {
      const value = evaluateFilter(document, filter);
      if (value === null) {
        unsupportedFilter = true;
        return false;
      }
      if (!value) return false;
    }
    return true;
  });
  if (unsupportedFilter) {
    diagnostics.push({
      code: "unsupported-filter",
      path: `${diagnosticPath}.filters`,
      message:
        "This view uses filter syntax Threadleaf does not evaluate yet, so no possibly incorrect rows are shown.",
    });
  }
  const sort = Array.isArray(view.sort)
    ? view.sort.map(record).filter((value): value is BaseRecord => value !== null)
    : [];
  const groupBy = record(view.groupBy);
  const groupProperty = typeof groupBy?.property === "string" ? groupBy.property : null;
  const groupDirection = groupBy?.direction === "DESC" ? -1 : 1;
  filtered.sort((left, right) => {
    if (groupProperty) {
      const groupOrder = displayValue(propertyValue(left, groupProperty)).localeCompare(
        displayValue(propertyValue(right, groupProperty)),
        "en-US",
        { numeric: true, sensitivity: "base" },
      );
      if (groupOrder !== 0) return groupOrder * groupDirection;
    }
    return compareDocuments(left, right, sort);
  });
  const configuredLimit =
    typeof view.limit === "number" && Number.isSafeInteger(view.limit) && view.limit > 0
      ? view.limit
      : maximumBaseRows;
  const limit = Math.min(configuredLimit, maximumBaseRows);
  const rows: WorkspaceBaseRow[] = filtered.slice(0, limit).map((document) => ({
    path: document.path,
    title: noteTitle(document.path),
    group: groupProperty ? displayValue(propertyValue(document, groupProperty)) || "Empty" : null,
    values: Object.fromEntries(
      columns.map(({ property }) => [property, displayValue(propertyValue(document, property))]),
    ),
  }));
  return {
    name,
    type,
    columns,
    rows,
    totalRows: filtered.length,
    truncated: filtered.length > rows.length,
  };
}

export function isBasePath(filePath: string): boolean {
  return filePath.toLocaleLowerCase("en-US").endsWith(".base");
}

export function titleForBasePath(filePath: string): string {
  return titleForPath(filePath);
}

export function buildWorkspaceBaseSnapshot(
  filePath: string,
  content: string,
  revision: string,
  documents: readonly DocumentMetadataSnapshot[],
): WorkspaceBaseSnapshot {
  const diagnostics: WorkspaceBaseDiagnostic[] = [];
  if (Buffer.byteLength(content, "utf8") > maximumBaseBytes) {
    return {
      path: filePath,
      title: titleForPath(filePath),
      revision,
      views: [],
      diagnostics: [
        {
          code: "invalid-shape",
          path: "$",
          message: `Base exceeds the ${maximumBaseBytes} byte safety limit.`,
        },
      ],
      readOnly: true,
    };
  }
  const parsed = parseDocument(content, { uniqueKeys: true });
  if (parsed.errors.length > 0) {
    return {
      path: filePath,
      title: titleForPath(filePath),
      revision,
      views: [],
      diagnostics: parsed.errors.map((error) => ({
        code: "invalid-yaml" as const,
        path: "$",
        message: error.message,
      })),
      readOnly: true,
    };
  }
  const root = record(parsed.toJS({ maxAliasCount: 0 }));
  if (!root || !Array.isArray(root.views) || root.views.length === 0) {
    diagnostics.push({
      code: "invalid-shape",
      path: "views",
      message: "A Base must define at least one view.",
    });
  }
  const formulas = record(root?.formulas);
  if (formulas && Object.keys(formulas).length > 0) {
    diagnostics.push({
      code: "unsupported-formula",
      path: "formulas",
      message: "Formula definitions are preserved but not evaluated yet.",
    });
  }
  const views = (Array.isArray(root?.views) ? root.views : []).map((view, index) =>
    buildView(view, index, root ?? {}, documents, diagnostics),
  );
  return {
    path: filePath,
    title: titleForPath(filePath),
    revision,
    views,
    diagnostics,
    readOnly: true,
  };
}
