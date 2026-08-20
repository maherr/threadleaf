import { describe, expect, it } from "vitest";
import type { DocumentMetadataSnapshot } from "../kernel/metadata-index";
import { buildWorkspaceBaseSnapshot, isBasePath, titleForBasePath } from "./base-service";

const documents: DocumentMetadataSnapshot[] = [
  {
    path: "Books/Alpha.md",
    revision: "a",
    headings: [],
    tags: ["book", "reading"],
    tagCounts: {},
    properties: { author: "Amina", rating: "5", status: "reading" },
    links: [],
  },
  {
    path: "Books/Beta.md",
    revision: "b",
    headings: [],
    tags: ["book"],
    tagCounts: {},
    properties: { author: "Bora", rating: "3", status: "done" },
    links: [],
  },
  {
    path: "Notes/Gamma.md",
    revision: "c",
    headings: [],
    tags: ["note"],
    tagCounts: {},
    properties: { author: "Cato", rating: "4", status: "reading" },
    links: [],
  },
];

describe("Base document projection", () => {
  it("renders multiple bounded views with filters, sorting, grouping, labels, and note paths", () => {
    const source = `filters:
  and:
    - file.inFolder("Books")
    - file.hasTag("book")
properties:
  note.rating:
    displayName: Score
views:
  - type: table
    name: Reading
    filters:
      and:
        - status != "done"
    order:
      - file.name
      - note.author
      - note.rating
    sort:
      - property: note.rating
        direction: DESC
    groupBy:
      property: note.status
      direction: ASC
  - type: list
    name: All books
    limit: 1
    order:
      - file.name
`;
    const snapshot = buildWorkspaceBaseSnapshot("Library.base", source, "revision", documents);

    expect(snapshot).toMatchObject({
      path: "Library.base",
      title: "Library",
      revision: "revision",
      readOnly: true,
      diagnostics: [],
    });
    expect(snapshot.views).toHaveLength(2);
    expect(snapshot.views[0]).toMatchObject({
      name: "Reading",
      type: "table",
      totalRows: 1,
      truncated: false,
      columns: [
        { property: "file.name", label: "Name" },
        { property: "note.author", label: "author" },
        { property: "note.rating", label: "Score" },
      ],
      rows: [
        {
          path: "Books/Alpha.md",
          title: "Alpha",
          group: "reading",
          values: {
            "file.name": "Alpha",
            "note.author": "Amina",
            "note.rating": "5",
          },
        },
      ],
    });
    expect(snapshot.views[1]).toMatchObject({
      name: "All books",
      totalRows: 2,
      truncated: true,
      rows: [{ path: "Books/Alpha.md" }],
    });
  });

  it("fails unsupported filters visibly instead of returning a plausible partial table", () => {
    const snapshot = buildWorkspaceBaseSnapshot(
      "Unsupported.base",
      `views:\n  - type: table\n    name: Unsupported\n    filters:\n      and:\n        - file.hasLink("Missing")\n`,
      "revision",
      documents,
    );

    expect(snapshot.views[0]?.rows).toEqual([]);
    expect(snapshot.diagnostics).toContainEqual({
      code: "unsupported-filter",
      path: "views[0].filters",
      message:
        "This view uses filter syntax Threadleaf does not evaluate yet, so no possibly incorrect rows are shown.",
    });
  });

  it("reports invalid YAML and recognizes Base paths without accepting suffix lookalikes", () => {
    expect(
      buildWorkspaceBaseSnapshot("Broken.base", "views: [", "revision", documents),
    ).toMatchObject({
      views: [],
      diagnostics: [{ code: "invalid-yaml", path: "$" }],
    });
    expect(isBasePath("Boards/Library.BASE")).toBe(true);
    expect(isBasePath("Boards/Library.base.md")).toBe(false);
    expect(titleForBasePath("Boards/Library.base")).toBe("Library");
  });
});
