import { describe, expect, it } from "vitest";
import type { JsonCanvasDocument } from "../shared/json-canvas";
import { parseJsonCanvas } from "./json-canvas";
import { rewriteJsonCanvasAttachmentReferences } from "./json-canvas-reference-rewrite";

function validatedDocument(source: string): JsonCanvasDocument {
  const parsed = parseJsonCanvas(Buffer.from(source, "utf8"));
  if (parsed.status !== "ready" || !parsed.document) {
    throw new Error(parsed.diagnostics[0]?.message ?? "Expected a valid Canvas fixture.");
  }
  return parsed.document;
}

function fileNode(file: string): string {
  return `{"id":"file","type":"file","file":${JSON.stringify(file)},"x":0,"y":0,"width":200,"height":120}`;
}

describe("byte-local JSON Canvas attachment reference rewriting", () => {
  it("preserves BOM, CRLF, unknown bytes, numeric spelling, and escaped source tokens", () => {
    const source =
      "\uFEFF{\r\n" +
      ' "future": {"astral": "🧭", "number": 1.00e+2, "path": "Assets/Report PDF.bin"},\r\n' +
      ' "nodes": [\r\n' +
      '  {"id":"file","type":"file","file":"Assets\\/Report PDF.bin?mode=fit#page=2","x":0,"y":0,"width":200,"height":120,"extra":[3, 2, 1]},\r\n' +
      '  {"id":"group","type":"group","background":"./Assets/Report%20PDF.bin","x":0,"y":140,"width":300,"height":220}\r\n' +
      " ],\r\n" +
      ' "edges": []\r\n' +
      "}\r\n";
    const expected = source
      .replace(
        '"Assets\\/Report PDF.bin?mode=fit#page=2"',
        '"Archive/New%20%23%3F.pdf?mode=fit#page=2"',
      )
      .replace('"./Assets/Report%20PDF.bin"', '"./Archive/New%20%23%3F.pdf"');

    const result = rewriteJsonCanvasAttachmentReferences(
      Buffer.from(source, "utf8"),
      validatedDocument(source),
      "Board.canvas",
      "Assets/Report PDF.bin",
      "Archive/New #?.pdf",
    );

    expect(result).toEqual({
      status: "ready",
      content: expected,
      rewrites: [
        {
          nodeIndex: 0,
          field: "file",
          location: "$.nodes[0].file",
          line: 4,
          beforeTarget: "Assets/Report PDF.bin?mode=fit#page=2",
          afterTarget: "Archive/New%20%23%3F.pdf?mode=fit#page=2",
        },
        {
          nodeIndex: 1,
          field: "background",
          location: "$.nodes[1].background",
          line: 5,
          beforeTarget: "./Assets/Report%20PDF.bin",
          afterTarget: "./Archive/New%20%23%3F.pdf",
        },
      ],
    });
  });

  it("preserves explicit relative and leading-slash path classes", () => {
    const source = `{"nodes":[${fileNode("../../Assets/Report PDF.bin")},{"id":"group","type":"group","background":"/Assets/Report PDF.bin","x":0,"y":140,"width":300,"height":220}],"edges":[]}\n`;
    const result = rewriteJsonCanvasAttachmentReferences(
      Buffer.from(source, "utf8"),
      validatedDocument(source),
      "Boards/Sub/Board.canvas",
      "Assets/Report PDF.bin",
      "Archive/Renamed Report.pdf",
    );
    expect(result).toMatchObject({
      status: "ready",
      rewrites: [
        {
          beforeTarget: "../../Assets/Report PDF.bin",
          afterTarget: "../../Archive/Renamed%20Report.pdf",
        },
        { beforeTarget: "/Assets/Report PDF.bin", afterTarget: "/Archive/Renamed%20Report.pdf" },
      ],
    });
  });

  it("leaves unrelated path-like strings and same basenames in another folder exact", () => {
    const source =
      '{"note":"Assets/Report PDF.bin","nodes":[' +
      fileNode("Assets/Other/Report PDF.bin") +
      ',{"id":"text","type":"text","text":"Assets/Report PDF.bin","x":0,"y":140,"width":200,"height":120}' +
      '],"edges":[]}\n';
    const result = rewriteJsonCanvasAttachmentReferences(
      Buffer.from(source, "utf8"),
      validatedDocument(source),
      "Board.canvas",
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
    );
    expect(result).toEqual({ status: "ready", content: source, rewrites: [] });
  });

  it.each([
    ["<Assets/Report PDF.bin>", "unsupported"],
    ["Assets\\Report PDF.bin", "unsupported"],
    [" Assets/Report PDF.bin", "unsupported"],
    ["Assets/report%ZZ.pdf", "reference"],
  ] as const)("blocks source-related target spelling %s as %s", (rawTarget, kind) => {
    const actualSource = rawTarget.includes("%ZZ")
      ? "Assets/report%ZZ.pdf"
      : "Assets/Report PDF.bin";
    const source = `{"nodes":[${fileNode(rawTarget)}],"edges":[]}\n`;
    const result = rewriteJsonCanvasAttachmentReferences(
      Buffer.from(source, "utf8"),
      validatedDocument(source),
      "Board.canvas",
      actualSource,
      "Archive/Renamed.pdf",
    );
    expect(result).toMatchObject({
      status: "blocked",
      kind,
      location: "$.nodes[0].file",
      target: rawTarget,
    });
  });

  it("blocks duplicate keys anywhere in the document", () => {
    const source = `{"future":1,"future":2,"nodes":[${fileNode("Assets/Report PDF.bin")}],"edges":[]}\n`;
    const document = JSON.parse(source) as JsonCanvasDocument;
    const result = rewriteJsonCanvasAttachmentReferences(
      Buffer.from(source, "utf8"),
      document,
      "Board.canvas",
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
    );
    expect(result).toMatchObject({
      status: "blocked",
      kind: "unreadable",
      location: "$.future",
      target: 'Duplicate JSON property "future"',
    });
  });

  it("blocks a lexical and validated-domain disagreement", () => {
    const source = `{"nodes":[${fileNode("Assets/Other.pdf")}],"edges":[]}\n`;
    const document = validatedDocument(source);
    const node = document.nodes?.[0];
    if (node?.type !== "file") throw new Error("Expected file node.");
    node.file = "Assets/Report PDF.bin";

    const result = rewriteJsonCanvasAttachmentReferences(
      Buffer.from(source, "utf8"),
      document,
      "Board.canvas",
      "Assets/Report PDF.bin",
      "Archive/Renamed.pdf",
    );
    expect(result).toMatchObject({
      status: "blocked",
      kind: "unreadable",
      location: "$.nodes[0].file",
    });
  });
});
