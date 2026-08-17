import type { App, TFile } from "./obsidian-compat";
import { Component } from "./obsidian-components";
import {
  BooleanValue,
  DateValue,
  NullValue,
  NumberValue,
  StringValue,
  Value,
} from "./obsidian-values";

export type BasesPropertyType = "file" | "formula" | "note";
export type BasesPropertyId = `${BasesPropertyType}.${string}`;
export type BasesSortConfig = {
  property: BasesPropertyId;
  direction: "ASC" | "DESC";
};

type BasesValueInput = Value | null | undefined;
type BasesValueStore = ReadonlyMap<string, BasesValueInput> | Record<string, BasesValueInput>;

function valueFromPrimitive(value: unknown): Value | null {
  if (value instanceof Value) {
    return value;
  }
  if (typeof value === "string") {
    return new StringValue(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new NumberValue(value);
  }
  if (typeof value === "boolean") {
    return new BooleanValue(value);
  }
  return null;
}

function storeValue(store: BasesValueStore, key: string): Value | null | undefined {
  if (store instanceof Map) {
    return store.get(key);
  }
  const record = store as Record<string, BasesValueInput>;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function propertyParts(propertyId: string): { name: string; type: BasesPropertyType } {
  const separator = propertyId.indexOf(".");
  if (separator < 0) {
    return { name: "", type: propertyId as BasesPropertyType };
  }
  return {
    name: propertyId.slice(separator + 1),
    type: propertyId.slice(0, separator) as BasesPropertyType,
  };
}

export class BasesEntry {
  readonly file: TFile;
  private readonly values: BasesValueStore;

  constructor(file: TFile, values: BasesValueStore = {}) {
    this.file = file;
    this.values = values;
  }

  getValue(propertyId: BasesPropertyId): Value | null {
    const configured = storeValue(this.values, propertyId);
    if (configured !== undefined) {
      return configured ?? NullValue.value;
    }

    const { name, type } = propertyParts(propertyId);
    const named = storeValue(this.values, name);
    if (named !== undefined) {
      return named === null ? NullValue.value : valueFromPrimitive(named);
    }
    if (type !== "file") {
      return null;
    }

    switch (name) {
      case "file":
      case "path":
      case "fullname":
        return new StringValue(this.file.path);
      case "name":
        return new StringValue(this.file.name);
      case "basename":
        return new StringValue(this.file.basename);
      case "extension":
        return new StringValue(this.file.extension);
      case "size":
        return new NumberValue(this.file.stat.size);
      case "ctime":
        return new DateValue(new Date(this.file.stat.ctime));
      case "mtime":
        return new DateValue(new Date(this.file.stat.mtime));
      default:
        return null;
    }
  }
}

export class BasesEntryGroup {
  key?: Value;
  entries: BasesEntry[];

  constructor(entries: BasesEntry[] = [], key?: Value) {
    this.entries = entries;
    if (key !== undefined) {
      this.key = key;
    }
  }

  hasKey(): boolean {
    return this.key !== undefined && !Value.equals(this.key, NullValue.value);
  }
}

function compareValues(left: Value, right: Value): number {
  if (left instanceof NullValue && right instanceof NullValue) return 0;
  if (left instanceof NullValue) return 1;
  if (right instanceof NullValue) return -1;
  if (left instanceof NumberValue && right instanceof NumberValue) {
    return Number(left.toString()) - Number(right.toString());
  }
  if (left instanceof DateValue && right instanceof DateValue) {
    return left.date.getTime() - right.date.getTime();
  }
  return left.toString().localeCompare(right.toString());
}

export class BasesViewConfig {
  name: string;
  groupBy?: BasesSortConfig;

  private readonly values = new Map<string, unknown>();
  private readonly displayNames = new Map<BasesPropertyId, string>();
  private order: BasesPropertyId[] = [];
  private sort: BasesSortConfig[] = [];

  constructor(name = "", values: Record<string, unknown> = {}) {
    this.name = name;
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
    const order = values.order;
    if (Array.isArray(order)) {
      this.order = order.filter((value): value is BasesPropertyId => typeof value === "string");
    }
    const sort = values.sort;
    if (Array.isArray(sort)) {
      this.sort = sort.filter(isSortConfig);
    }
    const groupBy = values.groupBy;
    if (isSortConfig(groupBy)) {
      this.groupBy = groupBy;
    }
  }

  get(key: string): unknown {
    return this.values.get(key);
  }

  getAsPropertyId(key: string): BasesPropertyId | null {
    const value = this.get(key);
    if (typeof value !== "string") return null;
    const parsed = propertyParts(value);
    return parsed.name && ["file", "formula", "note"].includes(parsed.type)
      ? (value as BasesPropertyId)
      : null;
  }

  getEvaluatedFormula(_view: BasesView, key: string): Value {
    return valueFromPrimitive(this.get(key)) ?? NullValue.value;
  }

  set(key: string, value: unknown | null): void {
    if (value === null) {
      this.values.delete(key);
      return;
    }
    this.values.set(key, value);
  }

  getOrder(): BasesPropertyId[] {
    return [...this.order];
  }

  getSort(): BasesSortConfig[] {
    return this.sort.filter(isSortConfig).map((value) => ({ ...value }));
  }

  getDisplayName(propertyId: BasesPropertyId): string {
    const configured = this.displayNames.get(propertyId);
    if (configured) return configured;
    return propertyParts(propertyId).name;
  }
}

function isSortConfig(value: unknown): value is BasesSortConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "property" in value &&
    typeof value.property === "string" &&
    "direction" in value &&
    (value.direction === "ASC" || value.direction === "DESC")
  );
}

export class QueryController extends Component {
  readonly app: App;
  readonly config: BasesViewConfig;
  readonly allProperties: BasesPropertyId[];
  readonly data: BasesEntry[];
  private notifyView: (() => void) | null = null;
  private readonly createFileCallback:
    | ((
        baseFileName?: string,
        frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void,
      ) => Promise<void>)
    | null;

  constructor(
    app: App,
    config = new BasesViewConfig(),
    allProperties: BasesPropertyId[] = [],
    data: BasesEntry[] = [],
    createFileCallback:
      | ((
          baseFileName?: string,
          frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void,
        ) => Promise<void>)
      | null = null,
  ) {
    super();
    this.app = app;
    this.config = config;
    this.allProperties = [...allProperties];
    this.data = [...data];
    this.createFileCallback = createFileCallback;
  }

  requestNotifyView(): void {
    this.notifyView?.();
  }

  setNotifyView(callback: (() => void) | null): void {
    this.notifyView = callback;
  }

  async createFileForView(
    baseFileName?: string,
    frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    if (!this.createFileCallback) {
      throw new Error("Bases file creation is unavailable without an active workspace controller.");
    }
    await this.createFileCallback(baseFileName, frontmatterProcessor);
  }
}

export class BasesQueryResult {
  data: BasesEntry[];
  private readonly config: BasesViewConfig;
  private readonly allProperties: BasesPropertyId[];
  private groupedDataCache: BasesEntryGroup[] | null = null;

  constructor(
    _app: App,
    config: BasesViewConfig,
    allProperties: BasesPropertyId[] = [],
    data: BasesEntry[] = [],
  ) {
    this.config = config;
    this.allProperties = [...allProperties];
    this.data = [...data];
  }

  get groupedData(): BasesEntryGroup[] {
    if (this.groupedDataCache) return this.groupedDataCache;
    const groupBy = this.config.groupBy;
    if (!groupBy) {
      this.groupedDataCache = [new BasesEntryGroup([...this.data])];
      return this.groupedDataCache;
    }
    const groups: BasesEntryGroup[] = [];
    for (const entry of this.data) {
      const value = entry.getValue(groupBy.property) ?? NullValue.value;
      const existing = groups.find(
        (group) => group.key !== undefined && Value.looseEquals(group.key, value),
      );
      if (existing) {
        existing.entries.push(entry);
      } else {
        groups.push(new BasesEntryGroup([entry], value));
      }
    }
    const direction = groupBy.direction === "ASC" ? 1 : -1;
    groups.sort((left, right) => {
      const leftKey = left.key ?? NullValue.value;
      const rightKey = right.key ?? NullValue.value;
      if (!left.hasKey() || !right.hasKey()) return left.hasKey() ? -1 : right.hasKey() ? 1 : 0;
      return compareValues(leftKey, rightKey) * direction;
    });
    this.groupedDataCache = groups;
    return groups;
  }

  get properties(): BasesPropertyId[] {
    const available = new Set(this.allProperties);
    const configured = this.config.getOrder();
    return (configured.length > 0 ? configured : this.allProperties).filter((property) =>
      available.has(property),
    );
  }

  getSummaryValue(
    _queryController: QueryController,
    entries: BasesEntry[],
    property: BasesPropertyId,
    summaryKey: string,
  ): Value {
    const values = entries
      .map((entry) => entry.getValue(property))
      .filter((value): value is Value => value !== null && !Value.equals(value, NullValue.value));
    if (summaryKey === "count") return new NumberValue(values.length);
    if (values.length === 0) return NullValue.value;
    if (["sum", "average", "min", "max"].includes(summaryKey)) {
      const numbers = values
        .map((value) => Number(value.toString()))
        .filter((value) => Number.isFinite(value));
      if (numbers.length === 0) return NullValue.value;
      if (summaryKey === "sum")
        return new NumberValue(numbers.reduce((sum, value) => sum + value, 0));
      if (summaryKey === "average") {
        return new NumberValue(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
      }
      return new NumberValue(summaryKey === "min" ? Math.min(...numbers) : Math.max(...numbers));
    }
    return NullValue.value;
  }
}

export abstract class BasesView extends Component {
  abstract type: string;
  readonly app: App;
  config: BasesViewConfig;
  allProperties: BasesPropertyId[];
  data: BasesQueryResult;
  protected readonly queryController: QueryController;

  protected constructor(controller: QueryController) {
    super();
    this.queryController = controller;
    this.app = controller.app;
    this.config = controller.config;
    this.allProperties = [...controller.allProperties];
    this.data = new BasesQueryResult(this.app, this.config, this.allProperties, controller.data);
  }

  abstract onDataUpdated(): void;

  createFileForView(
    baseFileName?: string,
    frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void,
  ): Promise<void> {
    return this.queryController.createFileForView(baseFileName, frontmatterProcessor);
  }
}
