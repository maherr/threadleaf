import { describe, expect, it } from "vitest";
import {
  trustedWorkspaceProbeArgument,
  trustedWorkspaceProbeEnabled,
} from "./trusted-workspace-probe";

describe("trusted workspace test probe launch capability", () => {
  it("requires the explicit development gate", () => {
    expect(trustedWorkspaceProbeEnabled(false, { THREADLEAF_TRUSTED_WORKSPACE_TEST: "1" })).toBe(
      true,
    );
    expect(trustedWorkspaceProbeEnabled(false, {})).toBe(false);
    expect(trustedWorkspaceProbeEnabled(false, { THREADLEAF_TRUSTED_WORKSPACE_TEST: "0" })).toBe(
      false,
    );
  });

  it("denies the environment gate in packaged builds", () => {
    expect(trustedWorkspaceProbeEnabled(true, { THREADLEAF_TRUSTED_WORKSPACE_TEST: "1" })).toBe(
      false,
    );
  });

  it("uses a renderer-only capability argument", () => {
    expect(trustedWorkspaceProbeArgument).toBe("--threadleaf-trusted-workspace-probe");
  });
});
