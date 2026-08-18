import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(new URL("./renderer.ts", import.meta.url), "utf8");

describe("trusted editor extension boundary", () => {
  it("owns one compatibility compartment per real workspace pane", () => {
    expect(rendererSource).not.toContain("const editorCompatibility = new Compartment();");
    expect(rendererSource).toMatch(
      /const editorCompatibilityByPane[\s\S]*primary[\s\S]*new Compartment\(\)[\s\S]*secondary[\s\S]*new Compartment\(\)/u,
    );
    expect(rendererSource).toContain("editorCompatibilityForPane(paneId).of");
    expect(rendererSource).toContain("editorCompatibilityForPane(paneId).reconfigure");
  });
});
