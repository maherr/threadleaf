export const workspaceOpenDiagnosticsSchemaVersion = 1;

export interface WorkspaceOpenDiagnosticAttributes {
  [key: string]: boolean | number | string;
}

export interface WorkspaceOpenDiagnosticMetric {
  name: string;
  count: number;
  durationMs: number;
  bytes: number;
  attributes?: WorkspaceOpenDiagnosticAttributes;
}

export interface WorkspaceOpenDiagnosticSpan {
  name: string;
  durationMs: number;
  attributes?: WorkspaceOpenDiagnosticAttributes;
}

export interface WorkspaceOpenDiagnosticsSnapshot {
  schemaVersion: typeof workspaceOpenDiagnosticsSchemaVersion;
  metrics: WorkspaceOpenDiagnosticMetric[];
  spans: WorkspaceOpenDiagnosticSpan[];
}

export interface SerializableValueShape {
  bytes: number;
  objects: number;
  arrays: number;
  scalars: number;
}

export interface WorkspaceOpenTransferReceipt {
  schemaVersion: typeof workspaceOpenDiagnosticsSchemaVersion;
  transferId: number;
  payloadBytes: number;
  payloadObjects: number;
}

export type WorkspaceOpenTransferAcknowledgement =
  | { phase: "received"; transferId: number }
  | {
      phase: "rendered";
      transferId: number;
      durationMs: number;
      objectCount: number;
    };

export class WorkspaceOpenDiagnostics {
  readonly #now: () => number;
  readonly #metrics = new Map<string, WorkspaceOpenDiagnosticMetric>();
  readonly #spans: WorkspaceOpenDiagnosticSpan[] = [];

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  now(): number {
    return this.#now();
  }

  addMetric(
    name: string,
    durationMs: number,
    options: {
      count?: number;
      bytes?: number;
      attributes?: WorkspaceOpenDiagnosticAttributes;
    } = {},
  ): void {
    const count = options.count ?? 1;
    const bytes = options.bytes ?? 0;
    const attributeKey = options.attributes ? JSON.stringify(options.attributes) : "";
    const key = `${name}\u0000${attributeKey}`;
    const current = this.#metrics.get(key);
    if (current) {
      current.count += count;
      current.durationMs += durationMs;
      current.bytes += bytes;
      return;
    }
    this.#metrics.set(key, {
      name,
      count,
      durationMs,
      bytes,
      ...(options.attributes ? { attributes: { ...options.attributes } } : {}),
    });
  }

  addSpan(name: string, startedAt: number, attributes?: WorkspaceOpenDiagnosticAttributes): void {
    this.#spans.push({
      name,
      durationMs: Math.max(0, this.now() - startedAt),
      ...(attributes ? { attributes: { ...attributes } } : {}),
    });
  }

  async measure<T>(
    name: string,
    operation: () => Promise<T>,
    options: {
      count?: number;
      bytes?: (value: T) => number;
      attributes?: WorkspaceOpenDiagnosticAttributes;
    } = {},
  ): Promise<T> {
    const startedAt = this.now();
    try {
      const value = await operation();
      this.addMetric(name, Math.max(0, this.now() - startedAt), {
        ...(options.count === undefined ? {} : { count: options.count }),
        ...(options.bytes ? { bytes: options.bytes(value) } : {}),
        ...(options.attributes ? { attributes: options.attributes } : {}),
      });
      return value;
    } catch (error) {
      this.addMetric(name, Math.max(0, this.now() - startedAt), {
        ...(options.count === undefined ? {} : { count: options.count }),
        attributes: { ...options.attributes, failed: true },
      });
      throw error;
    }
  }

  measureSync<T>(
    name: string,
    operation: () => T,
    options: {
      count?: number;
      bytes?: (value: T) => number;
      attributes?: WorkspaceOpenDiagnosticAttributes;
    } = {},
  ): T {
    const startedAt = this.now();
    try {
      const value = operation();
      this.addMetric(name, Math.max(0, this.now() - startedAt), {
        ...(options.count === undefined ? {} : { count: options.count }),
        ...(options.bytes ? { bytes: options.bytes(value) } : {}),
        ...(options.attributes ? { attributes: options.attributes } : {}),
      });
      return value;
    } catch (error) {
      this.addMetric(name, Math.max(0, this.now() - startedAt), {
        ...(options.count === undefined ? {} : { count: options.count }),
        attributes: { ...options.attributes, failed: true },
      });
      throw error;
    }
  }

  snapshot(): WorkspaceOpenDiagnosticsSnapshot {
    return {
      schemaVersion: workspaceOpenDiagnosticsSchemaVersion,
      metrics: [...this.#metrics.values()]
        .map((metric) => ({
          ...metric,
          ...(metric.attributes ? { attributes: { ...metric.attributes } } : {}),
        }))
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            JSON.stringify(left.attributes ?? {}).localeCompare(
              JSON.stringify(right.attributes ?? {}),
            ),
        ),
      spans: this.#spans.map((span) => ({
        ...span,
        ...(span.attributes ? { attributes: { ...span.attributes } } : {}),
      })),
    };
  }
}

export function measureSerializableValue(value: unknown): SerializableValueShape {
  const encoded = JSON.stringify(value);
  const shape: SerializableValueShape = {
    bytes: new TextEncoder().encode(encoded ?? "").byteLength,
    objects: 0,
    arrays: 0,
    scalars: 0,
  };
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      shape.arrays += 1;
      for (const value of current) pending.push(value);
    } else if (typeof current === "object" && current !== null) {
      shape.objects += 1;
      for (const value of Object.values(current)) pending.push(value);
    } else {
      shape.scalars += 1;
    }
  }
  return shape;
}

export class WorkspaceOpenTransferTracker {
  readonly #diagnostics: WorkspaceOpenDiagnostics;
  readonly #pending = new Map<number, { startedAt: number; receivedAt: number | null }>();
  #sequence = 0;

  constructor(diagnostics: WorkspaceOpenDiagnostics) {
    this.#diagnostics = diagnostics;
  }

  prepare<T extends object>(
    value: T,
  ): T & {
    workspaceOpenDiagnostics: WorkspaceOpenTransferReceipt;
  } {
    const shape = measureSerializableValue(value);
    const transferId = ++this.#sequence;
    this.#diagnostics.addMetric("ipc.payload", 0, {
      bytes: shape.bytes,
      attributes: { arrays: shape.arrays, objects: shape.objects, scalars: shape.scalars },
    });
    this.#pending.set(transferId, {
      startedAt: this.#diagnostics.now(),
      receivedAt: null,
    });
    if (this.#pending.size > 64) {
      const oldest = this.#pending.keys().next().value;
      if (typeof oldest === "number") this.#pending.delete(oldest);
    }
    return {
      ...value,
      workspaceOpenDiagnostics: {
        schemaVersion: workspaceOpenDiagnosticsSchemaVersion,
        transferId,
        payloadBytes: shape.bytes,
        payloadObjects: shape.objects,
      },
    };
  }

  acknowledge(acknowledgement: WorkspaceOpenTransferAcknowledgement): boolean {
    const pending = this.#pending.get(acknowledgement.transferId);
    if (!pending) return false;
    if (acknowledgement.phase === "received") {
      const receivedAt = this.#diagnostics.now();
      pending.receivedAt = receivedAt;
      this.#diagnostics.addMetric("ipc.transfer", Math.max(0, receivedAt - pending.startedAt));
      return true;
    }
    this.#diagnostics.addMetric("renderer.allocation-render", acknowledgement.durationMs, {
      attributes: { objects: acknowledgement.objectCount },
    });
    this.#pending.delete(acknowledgement.transferId);
    return true;
  }
}
