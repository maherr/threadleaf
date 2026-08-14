import { describe, expect, it } from "vitest";
import {
  themeContractSchemes,
  themeContractStateCues,
  themeContractTokens,
  themeContractUri,
  themeContractVersion,
} from "./theme-contract";

describe("public theme contract", () => {
  it("is versioned, names semantic tokens, and carries every supported scheme", () => {
    expect(themeContractVersion).toBe(1);
    expect(themeContractUri).toBe("urn:threadleaf:theme:v1");
    expect(themeContractSchemes).toEqual([
      "light",
      "dark",
      "high-contrast-light",
      "high-contrast-dark",
    ]);
    const tokenNames = themeContractTokens.map(([name]) => name);
    expect(new Set(tokenNames).size).toBe(tokenNames.length);
    expect(tokenNames).toEqual(expect.arrayContaining(["--surface", "--accent", "--signal"]));
  });

  it("requires a non-color cue for state semantics", () => {
    expect(themeContractStateCues.map(([state]) => state)).toEqual([
      "selected",
      "warning",
      "error",
      "loading",
    ]);
    for (const [, cue] of themeContractStateCues) {
      expect(cue.toLocaleLowerCase("en-US")).toMatch(
        /label|aria|border|shape|symbol|text|progress/u,
      );
    }
  });
});
