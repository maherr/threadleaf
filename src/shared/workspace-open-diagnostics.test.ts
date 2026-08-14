import { describe, expect, it } from "vitest";
import {
  measureSerializableValue,
  WorkspaceOpenDiagnostics,
  WorkspaceOpenTransferTracker,
} from "./workspace-open-diagnostics";

describe("workspace-open diagnostics", () => {
  it("uses an injected monotonic clock for deterministic spans and metrics", async () => {
    let now = 10;
    const diagnostics = new WorkspaceOpenDiagnostics(() => now);

    const startedAt = diagnostics.now();
    now = 14;
    diagnostics.addSpan("bootstrap.filesystem", startedAt, { documents: 2 });
    await diagnostics.measure(
      "bootstrap.read",
      async () => {
        now = 19;
        return new Uint8Array(7);
      },
      { bytes: (bytes) => bytes.length },
    );
    diagnostics.measureSync("bootstrap.hash", () => {
      now = 23;
      return "revision";
    });

    expect(diagnostics.snapshot()).toEqual({
      schemaVersion: 1,
      metrics: [
        { name: "bootstrap.hash", count: 1, durationMs: 4, bytes: 0 },
        { name: "bootstrap.read", count: 1, durationMs: 5, bytes: 7 },
      ],
      spans: [
        {
          name: "bootstrap.filesystem",
          durationMs: 4,
          attributes: { documents: 2 },
        },
      ],
    });
  });

  it("measures serialized bytes and object allocation shape separately", () => {
    expect(measureSerializableValue({ files: [{ path: "A.md" }, { path: "B.md" }] })).toEqual({
      bytes: 43,
      objects: 3,
      arrays: 1,
      scalars: 2,
    });
  });

  it("measures a giant payload without spreading it onto the call stack", () => {
    const files = Array.from({ length: 200_000 }, (_, index) => ({ path: `${index}.md` }));

    expect(measureSerializableValue({ files })).toMatchObject({
      objects: 200_001,
      arrays: 1,
      scalars: 200_000,
    });
  });

  it("records IPC receipt and renderer allocation without wall-clock waits", () => {
    let now = 100;
    const diagnostics = new WorkspaceOpenDiagnostics(() => now);
    const tracker = new WorkspaceOpenTransferTracker(diagnostics);
    const prepared = tracker.prepare({ workspace: { files: [{ path: "A.md" }] } });

    now = 107;
    expect(
      tracker.acknowledge({
        phase: "received",
        transferId: prepared.workspaceOpenDiagnostics.transferId,
      }),
    ).toBe(true);
    expect(
      tracker.acknowledge({
        phase: "rendered",
        transferId: prepared.workspaceOpenDiagnostics.transferId,
        durationMs: 11,
        objectCount: 4,
      }),
    ).toBe(true);

    expect(diagnostics.snapshot().metrics).toEqual([
      {
        name: "ipc.payload",
        count: 1,
        durationMs: 0,
        bytes: 41,
        attributes: { arrays: 1, objects: 3, scalars: 1 },
      },
      { name: "ipc.transfer", count: 1, durationMs: 7, bytes: 0 },
      {
        name: "renderer.allocation-render",
        count: 1,
        durationMs: 11,
        bytes: 0,
        attributes: { objects: 4 },
      },
    ]);
  });
});
