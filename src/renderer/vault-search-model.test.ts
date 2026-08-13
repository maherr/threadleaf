import { describe, expect, it } from "vitest";
import { vaultSearchDisplayContext } from "./vault-search-model";

describe("vault search renderer model", () => {
  it("keeps exact source context and line navigation metadata", () => {
    const text = "before Cafe\u0301 after 😀";
    expect(
      vaultSearchDisplayContext({
        contexts: [{ kind: "content", line: 7, text }],
      }),
    ).toEqual({ label: "Line 7", line: 7, text });
  });

  it("labels metadata contexts without changing their source text", () => {
    expect(
      vaultSearchDisplayContext({ contexts: [{ kind: "property", text: "status: déjà-vu" }] }),
    ).toEqual({ label: "Property", line: undefined, text: "status: déjà-vu" });
  });
});
