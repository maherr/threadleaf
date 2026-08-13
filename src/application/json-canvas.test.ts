import { describe, expect, it } from "vitest";
import { MutableJsonCanvas, parseJsonCanvas, serializeJsonCanvas } from "./json-canvas";

const CANVAS = {
  metadata: { producer: "fixture", unknown: { keep: true } },
  nodes: [
    {
      id: "text-1",
      type: "text",
      x: 10,
      y: 20,
      width: 240,
      height: 100,
      text: "Hello",
      futureField: ["untouched"],
    },
    {
      id: "file-1",
      type: "file",
      x: 300,
      y: 20,
      width: 240,
      height: 100,
      file: "Notes/Welcome.md",
      subpath: "#intro",
    },
  ],
  edges: [
    {
      id: "edge-1",
      fromNode: "text-1",
      fromSide: "right",
      fromEnd: "arrow",
      toNode: "file-1",
      toSide: "left",
      label: "opens",
    },
  ],
};

describe("JSON Canvas parser", () => {
  it("round-trips valid fields and unknown fields semantically", () => {
    const source = `${JSON.stringify(CANVAS, null, 2)}\n`;
    const parsed = parseJsonCanvas(source);
    expect(parsed.status).toBe("ready");
    expect(parsed.document).toEqual(CANVAS);
    expect(parsed.originalText).toBe(source);
    expect(parsed.originalBytes).toEqual(new TextEncoder().encode(source));

    if (!parsed.document) throw new Error("Expected a valid canvas document.");
    const model = new MutableJsonCanvas(parsed.document);
    model.editText("text-1", "Changed");
    model.moveNode("text-1", 30, 40);
    model.resizeNode("text-1", 260, 120);
    const output = JSON.parse(serializeJsonCanvas(model.snapshot())) as typeof CANVAS;
    expect(output.metadata).toEqual(CANVAS.metadata);
    expect(output.nodes[0]?.futureField).toEqual(["untouched"]);
    expect(output.nodes[0]?.text).toBe("Changed");
    expect(output.nodes[0]?.x).toBe(30);
  });

  it("reports exact validation paths while retaining a read-only tree", () => {
    const parsed = parseJsonCanvas(
      JSON.stringify({
        nodes: [
          { id: "same", type: "text", x: 0, y: 0, width: 1, height: 1 },
          { id: "same", type: "future", x: 0, y: 0, width: 1, height: 1 },
        ],
        edges: [
          {
            id: "edge",
            fromNode: "same",
            fromSide: "top",
            toNode: "missing",
            toSide: "bottom",
          },
        ],
      }),
    );
    expect(parsed.status).toBe("malformed");
    expect(parsed.document).not.toBeNull();
    expect(parsed.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "invalid-node", path: "$.nodes[0].text" },
      { code: "unsupported-node", path: "$.nodes[1].type" },
      { code: "duplicate-id", path: "$.nodes[1].id" },
      { code: "missing-reference", path: "$.edges[0].toNode" },
    ]);
  });

  it("rejects malformed JSON and enforces bounded collections", () => {
    expect(parseJsonCanvas("{oops")).toMatchObject({
      status: "malformed",
      document: null,
      diagnostics: [{ code: "invalid-json", path: "$" }],
    });
    const nodes = Array.from({ length: 2_049 }, (_, index) => ({
      id: `n-${index}`,
      type: "text",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      text: "",
    }));
    expect(parseJsonCanvas(JSON.stringify({ nodes })).diagnostics).toContainEqual(
      expect.objectContaining({ code: "limit-exceeded", path: "$.nodes" }),
    );
  });

  it("follows optional top-level arrays and optional edge sides", () => {
    const parsed = parseJsonCanvas(
      JSON.stringify({
        nodes: [
          { id: "text", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
          {
            id: "link",
            type: "link",
            x: 2,
            y: 0,
            width: 1,
            height: 1,
            url: "https://example.test",
          },
        ],
        edges: [{ id: "edge", fromNode: "text", toNode: "link" }],
      }),
    );
    expect(parsed.status).toBe("ready");
    expect(parsed.document?.edges).toEqual([{ id: "edge", fromNode: "text", toNode: "link" }]);

    const arraysOmitted = parseJsonCanvas(JSON.stringify({ metadata: { keep: true } }));
    expect(arraysOmitted.status).toBe("ready");
    expect(arraysOmitted.document).toMatchObject({
      nodes: [],
      edges: [],
      metadata: { keep: true },
    });

    const malformedArray = parseJsonCanvas(JSON.stringify({ nodes: {}, edges: [] }));
    expect(malformedArray.status).toBe("malformed");
    expect(malformedArray.document).toMatchObject({ nodes: [], edges: [] });
  });

  it("keeps a BOM and rejects invalid UTF-8 without rewriting bytes", () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("{}")]);
    const withBom = parseJsonCanvas(bom);
    expect(withBom.status).toBe("ready");
    expect(withBom.originalBytes).toEqual(bom);
    expect(withBom.originalText.startsWith("\uFEFF")).toBe(true);

    const invalid = parseJsonCanvas(Uint8Array.from([0x7b, 0xff, 0x7d]));
    expect(invalid).toMatchObject({
      status: "malformed",
      document: null,
      diagnostics: [{ code: "invalid-utf8", path: "$" }],
    });
    expect(invalid.originalBytes).toEqual(Uint8Array.from([0x7b, 0xff, 0x7d]));
  });
});

describe("JSON Canvas mutations", () => {
  it("creates and removes nodes and edges without dangling references", () => {
    const model = new MutableJsonCanvas({ nodes: [], edges: [], metadata: "keep" });
    const first = model.addText("A", { x: 0, y: 0, width: 100, height: 80 });
    const second = model.addGroup("B", { x: 100, y: 0, width: 100, height: 80 });
    const file = model.addFile("Welcome.md", { x: 200, y: 0, width: 100, height: 80 });
    const link = model.addLink("https://example.test", { x: 300, y: 0, width: 100, height: 80 });
    model.editFile(file, "Linked Note.md", "#heading");
    model.editLink(link, "https://example.test/changed");
    const edge = model.connect(first, second, "right", "left");
    expect(model.snapshot().edges).toHaveLength(1);
    model.editEdgeLabel(edge, "connects");
    const [createdEdge] = model.snapshot().edges ?? [];
    expect(createdEdge).toBeDefined();
    expect(createdEdge?.label).toBe("connects");
    model.removeNode(first);
    expect(model.snapshot().edges).toEqual([]);
    model.removeEdge(edge);
    expect(model.snapshot().metadata).toBe("keep");
  });
});
