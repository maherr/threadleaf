import { describe, expect, it } from "vitest";
import {
  optionalPayloadString,
  parsePluginRendererRequest,
  parsePluginRendererResponse,
  parsePluginVaultWriteRequest,
  requirePayloadString,
} from "./plugin-runtime-protocol";

describe("plugin renderer protocol", () => {
  it("accepts a bounded known operation and object payload", () => {
    const request = parsePluginRendererRequest({
      id: "request-1",
      operation: "load-plugin",
      payload: { pluginDirectory: "/vault/plugin" },
    });

    expect(requirePayloadString(request, "pluginDirectory")).toBe("/vault/plugin");
    expect(optionalPayloadString(request, "pluginId")).toBeUndefined();
  });

  it("validates success and failure response envelopes", () => {
    expect(parsePluginRendererResponse({ id: "one", ok: true, value: null })).toEqual({
      id: "one",
      ok: true,
      value: null,
    });
    expect(parsePluginRendererResponse({ id: "two", ok: false, error: "failed" })).toEqual({
      id: "two",
      ok: false,
      error: "failed",
    });
    expect(() => parsePluginRendererResponse({ id: "one", ok: true, value: "wrong" })).toThrow(
      "invalid value",
    );
    expect(() => parsePluginRendererResponse({ id: "two", ok: false })).toThrow("no error message");
  });

  it("rejects unknown operations, arrays, empty identifiers, and malformed payload values", () => {
    expect(() => parsePluginRendererRequest({ id: "x", operation: "erase-vault" })).toThrow(
      "invalid id, operation, or payload",
    );
    expect(() =>
      parsePluginRendererRequest({ id: "x", operation: "get-snapshot", payload: [] }),
    ).toThrow("invalid id, operation, or payload");
    expect(() => parsePluginRendererRequest({ id: "", operation: "get-snapshot" })).toThrow(
      "invalid id, operation, or payload",
    );
    const request = parsePluginRendererRequest({
      id: "x",
      operation: "run-command",
      payload: { commandId: 4 },
    });
    expect(() => requirePayloadString(request, "commandId")).toThrow(
      "run-command requires a non-empty commandId string",
    );
  });

  it("validates revision-bound plugin vault write requests", () => {
    const revision = "a".repeat(64);
    expect(
      parsePluginVaultWriteRequest({
        vaultPath: "/vault",
        filePath: "Drawing.excalidraw.md",
        content: "drawing bytes",
        expectedRevision: revision,
      }),
    ).toEqual({
      vaultPath: "/vault",
      filePath: "Drawing.excalidraw.md",
      content: "drawing bytes",
      expectedRevision: revision,
    });
    expect(() =>
      parsePluginVaultWriteRequest({
        vaultPath: "/vault",
        filePath: "Drawing.excalidraw.md",
        content: "drawing bytes",
        expectedRevision: "stale",
      }),
    ).toThrow("SHA-256 revision");
  });
});
