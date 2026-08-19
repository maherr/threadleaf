import { describe, expect, it } from "vitest";
import {
  optionalPayloadString,
  optionalPluginEditorContext,
  optionalPluginMutationWaitOptions,
  parsePluginEditorContext,
  parsePluginMutationWaitOptions,
  parsePluginRendererEnvironment,
  parsePluginRendererRequest,
  parsePluginRendererResponse,
  parsePluginVaultCreateBinaryRequest,
  parsePluginVaultCreateFolderRequest,
  parsePluginVaultCreateRequest,
  parsePluginVaultRenameRequest,
  parsePluginVaultTrashRequest,
  parsePluginVaultWriteBinaryRequest,
  parsePluginVaultWriteRequest,
  requirePayloadString,
  requirePayloadStringArray,
} from "./plugin-runtime-protocol";

describe("plugin renderer protocol", () => {
  const accessibility = {
    highContrast: false,
    accent: "blue" as const,
    uiFontScale: 1,
    textFontScale: 1,
    editorFontSize: 15,
    editorLineHeight: 1.6,
    reducedMotion: false,
    reducedTransparency: false,
  };

  it("parses a bounded full environment replacement and rejects malformed bounds", () => {
    const environment = parsePluginRendererEnvironment({
      vaultId: "a".repeat(64),
      vaultGeneration: 3,
      sequence: 7,
      theme: "dark",
      appearanceCss: ".appearance { --appearance: 1; }",
      pluginCss: ".plugin { --plugin: 1; }",
      accessibilityCss: ":root { --accessibility: 1; }",
      accessibility,
    });

    expect(environment).toEqual({
      vaultId: "a".repeat(64),
      vaultGeneration: 3,
      sequence: 7,
      theme: "dark",
      appearanceCss: ".appearance { --appearance: 1; }",
      pluginCss: ".plugin { --plugin: 1; }",
      accessibilityCss: ":root { --accessibility: 1; }",
      accessibility,
    });
    expect(() =>
      parsePluginRendererEnvironment({
        vaultId: "a".repeat(64),
        vaultGeneration: 0,
        sequence: 1,
        theme: "dark",
        appearanceCss: "",
        pluginCss: "",
        accessibilityCss: "",
        accessibility,
      }),
    ).toThrow("vaultGeneration");
    expect(() =>
      parsePluginRendererEnvironment({
        vaultId: "a".repeat(64),
        vaultGeneration: 1,
        sequence: 1,
        theme: "dark",
        appearanceCss: "",
        pluginCss: "",
        accessibilityCss: "",
        accessibility: { ...accessibility, uiFontScale: Number.NaN },
      }),
    ).toThrow("uiFontScale");
    expect(() =>
      parsePluginRendererEnvironment({
        vaultId: "a".repeat(64),
        vaultGeneration: 1,
        sequence: 1,
        theme: "dark",
        appearanceCss: "",
        pluginCss: "",
        accessibilityCss: "",
        accessibility,
        extra: true,
      }),
    ).toThrow("unknown fields");
  });

  it("accepts a bounded known operation and object payload", () => {
    const request = parsePluginRendererRequest({
      id: "request-1",
      operation: "load-plugin",
      payload: { pluginDirectory: "/vault/plugin" },
    });

    expect(requirePayloadString(request, "pluginDirectory")).toBe("/vault/plugin");
    expect(optionalPayloadString(request, "pluginId")).toBeUndefined();
  });

  it("accepts bounded vault path inventories and rejects malformed entries", () => {
    const request = parsePluginRendererRequest({
      id: "request-seed",
      operation: "seed-vault-markdown-paths",
      payload: { paths: ["Notes/One.md", "Notes/Two.md"] },
    });

    expect(requirePayloadStringArray(request, "paths")).toEqual(["Notes/One.md", "Notes/Two.md"]);
    expect(() =>
      requirePayloadStringArray(
        parsePluginRendererRequest({
          id: "request-invalid-seed",
          operation: "seed-vault-markdown-paths",
          payload: { paths: ["Notes/One.md", 2] },
        }),
        "paths",
      ),
    ).toThrow("valid paths strings");
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

  it("preserves ArrayBuffer payloads in binary create and revision-bound write requests", () => {
    const revision = "b".repeat(64);
    const bytes = Uint8Array.from([0, 0xff, 0x89, 0x50, 0x4e, 0x47]);
    const create = parsePluginVaultCreateBinaryRequest({
      vaultPath: "/vault",
      filePath: "Exports/Drawing.png",
      content: bytes.buffer,
    });
    const write = parsePluginVaultWriteBinaryRequest({
      vaultPath: "/vault",
      filePath: "Exports/Drawing.png",
      content: bytes.buffer,
      expectedRevision: revision,
    });

    expect(new Uint8Array(create.content)).toEqual(bytes);
    expect(new Uint8Array(write.content)).toEqual(bytes);
    expect(write.expectedRevision).toBe(revision);
    expect(() =>
      parsePluginVaultCreateBinaryRequest({
        vaultPath: "/vault",
        filePath: "Exports/Drawing.png",
        content: bytes,
      }),
    ).toThrow("ArrayBuffer content");
    expect(() =>
      parsePluginVaultWriteBinaryRequest({
        vaultPath: "/vault",
        filePath: "Exports/Drawing.png",
        content: "not binary",
        expectedRevision: revision,
      }),
    ).toThrow("ArrayBuffer content");
  });

  it("validates revision-bound plugin vault rename requests", () => {
    const revision = "c".repeat(64);
    expect(
      parsePluginVaultRenameRequest({
        vaultPath: "/vault",
        sourcePath: "Exports/Drawing.png",
        targetPath: "Assets/Drawing.png",
        expectedRevision: revision,
      }),
    ).toEqual({
      vaultPath: "/vault",
      sourcePath: "Exports/Drawing.png",
      targetPath: "Assets/Drawing.png",
      expectedRevision: revision,
    });
    expect(() =>
      parsePluginVaultRenameRequest({
        vaultPath: "/vault",
        sourcePath: "Exports/Drawing.png",
        targetPath: "",
        expectedRevision: revision,
      }),
    ).toThrow("vault, source, target");
  });

  it("validates revision-bound plugin trash requests", () => {
    const revision = "d".repeat(64);
    expect(
      parsePluginVaultTrashRequest({
        vaultPath: "/vault",
        filePath: "Assets/Drawing.png",
        expectedRevision: revision,
      }),
    ).toEqual({
      vaultPath: "/vault",
      filePath: "Assets/Drawing.png",
      expectedRevision: revision,
    });
    expect(() =>
      parsePluginVaultTrashRequest({
        vaultPath: "/vault",
        filePath: "Assets/Drawing.png",
        expectedRevision: "stale",
      }),
    ).toThrow("SHA-256 revision");
  });

  it("validates plugin file and folder create requests", () => {
    expect(
      parsePluginVaultCreateRequest({
        vaultPath: "/vault",
        filePath: "Excalidraw/Drawing.excalidraw.md",
        content: "drawing bytes",
      }),
    ).toEqual({
      vaultPath: "/vault",
      filePath: "Excalidraw/Drawing.excalidraw.md",
      content: "drawing bytes",
    });
    expect(
      parsePluginVaultCreateFolderRequest({
        vaultPath: "/vault",
        folderPath: "Excalidraw",
      }),
    ).toEqual({ vaultPath: "/vault", folderPath: "Excalidraw" });
    expect(() =>
      parsePluginVaultCreateRequest({ vaultPath: "/vault", filePath: "", content: "" }),
    ).toThrow("vault, file, and content");
    expect(() =>
      parsePluginVaultCreateFolderRequest({ vaultPath: "/vault", folderPath: "" }),
    ).toThrow("vault and folder");
  });

  it("validates bounded native editor contexts", () => {
    const revision = "c".repeat(64);
    const context = {
      path: "Welcome.md",
      content: "hello",
      revision,
      selection: { anchor: 2, head: 5 },
    };
    expect(parsePluginEditorContext(context)).toEqual(context);
    expect(
      optionalPluginEditorContext({
        id: "editor-context",
        operation: "run-command",
        payload: { commandId: "insert", editorContext: context },
      }),
    ).toEqual(context);
    expect(() =>
      parsePluginEditorContext({ ...context, selection: { anchor: 6, head: 6 } }),
    ).toThrow("fit within");
    expect(() => parsePluginEditorContext({ ...context, revision: "stale" })).toThrow(
      "SHA-256 revision",
    );
  });

  it("validates generic mutation barrier bounds", () => {
    const request = parsePluginRendererRequest({
      id: "wait",
      operation: "wait-for-mutations",
      payload: { quietMs: 0, timeoutMs: 250 },
    });
    expect(optionalPluginMutationWaitOptions(request)).toEqual({ quietMs: 0, timeoutMs: 250 });
    expect(parsePluginMutationWaitOptions({ timeoutMs: 10 })).toEqual({ timeoutMs: 10 });
    expect(() => parsePluginMutationWaitOptions({ quietMs: -1 })).toThrow("safe integer");
    expect(() => parsePluginMutationWaitOptions({ timeoutMs: 0 })).toThrow("safe integer");
    expect(() => parsePluginMutationWaitOptions([])).toThrow("object");
  });
});
