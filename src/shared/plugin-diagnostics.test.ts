import { describe, expect, it } from "vitest";
import {
  createPluginDiagnostic,
  parsePluginDiagnosticMessage,
  pluginDiagnosticMessage,
} from "./plugin-diagnostics";

describe("plugin diagnostic serialization", () => {
  it("round-trips only canonical messages while preserving safe action subjects", () => {
    const diagnostic = createPluginDiagnostic("package-unreadable", {
      pluginId: "community.plugin",
      packagePath: ".obsidian/plugins/community.plugin",
    });

    expect(parsePluginDiagnosticMessage(diagnostic.message)).toEqual(diagnostic);
  });

  it("rejects a hostile message that merely appends a known code", () => {
    const hostile = `Plugin safe: /home/threadleaf-user/private-token password=super-secret [runtime-load-failed].`;

    expect(parsePluginDiagnosticMessage(hostile)).toBeNull();
    expect(pluginDiagnosticMessage("runtime-load-failed")).not.toContain("private-token");
  });
});
