import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ExtensionPortingError,
  inspectUnpackedPlugin,
  scaffoldPortingTemplate,
} from "./porting-toolkit";

const fixtureRoot = path.resolve("fixtures/extension-porting");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `threadleaf-porting-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * A small, dependency-free JSON Schema 2020-12 subset validator matching the one in
 * scripts/check-extension-porting-report.mjs. That script must run under plain `node` without a
 * build step, so it cannot import this TypeScript module; this is a deliberate, small, test-only
 * duplication rather than a new Ajv dependency added only to validate one fixture.
 */
type JsonSchema = Record<string, unknown>;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSchemaRef(root: JsonSchema, ref: string): JsonSchema {
  const segments = ref.replace(/^#\//u, "").split("/");
  let node: unknown = root;
  for (const segment of segments) {
    node = isJsonRecord(node) ? node[segment] : undefined;
  }
  if (!isJsonRecord(node)) {
    throw new Error(`schema $ref ${ref} does not resolve`);
  }
  return node;
}

function schemaTypeMatches(schema: JsonSchema, value: unknown): boolean {
  const declared = schema.type;
  const types = Array.isArray(declared) ? declared : [declared];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return types.some((type) => {
    if (type === "integer") {
      return typeof value === "number" && Number.isInteger(value);
    }
    return type === actual;
  });
}

function validateAgainstSchema(
  root: JsonSchema,
  schema: JsonSchema,
  value: unknown,
  location: string,
  errors: string[],
): void {
  if (typeof schema.$ref === "string") {
    validateAgainstSchema(root, resolveSchemaRef(root, schema.$ref), value, location, errors);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.some((candidate) => {
      const candidateErrors: string[] = [];
      validateAgainstSchema(root, candidate as JsonSchema, value, location, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matches) {
      errors.push(`${location}: matched none of the schema's anyOf alternatives`);
    }
    return;
  }
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      errors.push(`${location}: expected const ${JSON.stringify(schema.const)}`);
    }
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${location}: value is not in the schema's enum`);
    }
    return;
  }
  if (schema.type !== undefined && !schemaTypeMatches(schema, value)) {
    errors.push(`${location}: expected type ${JSON.stringify(schema.type)}`);
    return;
  }
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${location}: does not match pattern ${schema.pattern}`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${location}: shorter than minLength`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${location}: longer than maxLength`);
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${location}: below minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${location}: above maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${location}: fewer than minItems`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${location}: more than maxItems`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push(`${location}: duplicate item under uniqueItems`);
          break;
        }
        seen.add(key);
      }
    }
    if (isJsonRecord(schema.items)) {
      value.forEach((item, index) => {
        validateAgainstSchema(
          root,
          schema.items as JsonSchema,
          item,
          `${location}[${index}]`,
          errors,
        );
      });
    }
    return;
  }
  if (isJsonRecord(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key as string)) {
        errors.push(`${location}: missing required property ${String(key)}`);
      }
    }
    const properties = isJsonRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(properties));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${location}: unexpected property ${key}`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateAgainstSchema(
          root,
          propertySchema as JsonSchema,
          value[key],
          `${location}.${key}`,
          errors,
        );
      }
    }
  }
}

function validateReport(schema: JsonSchema, report: unknown): string[] {
  const errors: string[] = [];
  validateAgainstSchema(schema, schema, report, "$", errors);
  return errors;
}

describe("extension porting toolkit", () => {
  it("reports measured API references and exact static authority without executing input code", async () => {
    const report = await inspectUnpackedPlugin(path.join(fixtureRoot, "measured"));

    expect(report.input.manifest).toMatchObject({
      id: "threadleaf-porting-fixture",
      version: "0.1.0",
    });
    expect(report.compatibility.status).toBe("unverified");
    expect(
      report.api.observed
        .filter((entry) => entry.status === "measured")
        .map((entry) => entry.member),
    ).toEqual([
      "MarkdownPostProcessorContext",
      "MarkdownRenderChild",
      "Notice",
      "Plugin",
      "Plugin.addCommand",
      "Plugin.registerMarkdownPostProcessor",
    ]);
    expect(report.api.differences).toEqual([]);
    expect(report.authority.observed).toEqual([
      expect.objectContaining({
        sourceCapability: "workspace-ui",
        nativeCapability: "workspace-ui",
        availability: "portable",
      }),
    ]);
    expect(report.diagnostics).toEqual([]);
    expect(report.ci.commands).toContain('pnpm cli port inspect "$PLUGIN_DIR" --json');
    expect(JSON.stringify(report)).not.toContain("fixtures/extension-porting");
    expect(JSON.stringify(report)).not.toContain("module.exports");
  });

  it("never activates the exact package during static inspection", async () => {
    const report = await inspectUnpackedPlugin(path.join(fixtureRoot, "measured"));

    expect(report.packageInspection.stages.find((stage) => stage.id === "activation")?.status).toBe(
      "blocked",
    );
    expect(
      report.packageInspection.stages.find((stage) => stage.id === "registration-snapshot")?.status,
    ).toBe("blocked");
    expect(report.packageInspection.staticAuthority).toMatchObject({ staticOnly: true });
    expect(report.packageInspection.limitations).toContain(
      "Port inspection selects static-only canonical inspection; activation and workflow execution are not run.",
    );
  });

  it("matches the checked-in deterministic report golden", async () => {
    const report = await inspectUnpackedPlugin(path.join(fixtureRoot, "measured"));
    const golden = JSON.parse(
      await fs.readFile(path.join(fixtureRoot, "golden", "measured-report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect({
      schemaVersion: report.schemaVersion,
      tool: report.tool,
      input: report.input,
      packageInspection: report.packageInspection,
      authorityReceipt: report.authorityReceipt,
      compatibility: report.compatibility,
      api: report.api,
      authority: report.authority,
      ci: report.ci,
      diagnostics: report.diagnostics,
      limitations: report.limitations,
    }).toEqual(golden);
  });

  it("produces byte-identical reports across repeated runs against the same fixture", async () => {
    const first = await inspectUnpackedPlugin(path.join(fixtureRoot, "measured"));
    const second = await inspectUnpackedPlugin(path.join(fixtureRoot, "measured"));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("emits deterministic API and authority differences for an unmeasured fixture", async () => {
    const report = await inspectUnpackedPlugin(path.join(fixtureRoot, "unmeasured"));

    expect(report.api.differences).toEqual([
      expect.objectContaining({
        code: "unmeasured-api",
        member: "app.vault.cachedReadPath",
        evidencePath: "main.js:9",
      }),
    ]);
    expect(report.authority.differences).toEqual([
      expect.objectContaining({
        code: "unmapped-authority",
        sourceCapability: "filesystem",
      }),
    ]);
    expect(report.authority.suggestedCapabilities).toEqual(["workspace-ui"]);
    expect(report.authority.suggestedNativeRuntime).toBe("portable");
    expect(report.diagnostics.map((item) => item.code)).toEqual([
      "undeclared-host-dependency",
      "unmapped-authority",
      "node-filesystem",
      "unmeasured-api",
    ]);
  });

  it("never reads a non-required escaping symlink's target and flags it as an unexpected entry", async () => {
    const root = await temporaryDirectory("symlink");
    const plugin = path.join(root, "plugin");
    const outside = path.join(root, "outside.js");
    await fs.mkdir(plugin);
    await fs.writeFile(outside, "SECRET-OUTSIDE-CONTENT-must-never-be-read");
    await fs.symlink(outside, path.join(plugin, "outside.js"));
    await fs.writeFile(
      path.join(plugin, "manifest.json"),
      JSON.stringify({ id: "escape", name: "Escape", version: "0.1.0" }),
    );
    await fs.writeFile(path.join(plugin, "main.js"), "module.exports = {};\n");

    // exactInputFromDirectory only ever reads bytes for the three recognized filenames
    // (manifest.json, main.js, styles.css); every other directory entry, including a symlink
    // that escapes the package root, is recorded by kind only and its target is never opened.
    // Package-shape validation then rejects the unexpected symlink entry as a diagnostic.
    const report = await inspectUnpackedPlugin(plugin);
    expect(report.packageInspection.overall).toBe("fail");
    expect(
      report.packageInspection.stages.find((stage) => stage.id === "package-shape"),
    ).toMatchObject({
      status: "fail",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "non-file-package-entry" }),
        expect.objectContaining({ code: "unexpected-package-entry" }),
      ]),
    });
    expect(report.packageInspection.unexpectedEntries).toContain("outside.js");
    expect(JSON.stringify(report)).not.toContain("SECRET-OUTSIDE-CONTENT");
  });

  it("fails closed when a required asset filename is itself a symlink", async () => {
    const root = await temporaryDirectory("symlink-required");
    const plugin = path.join(root, "plugin");
    const outside = path.join(root, "outside-main.js");
    await fs.mkdir(plugin);
    await fs.writeFile(outside, "SECRET-OUTSIDE-MAIN-must-never-be-read");
    await fs.symlink(outside, path.join(plugin, "main.js"));
    await fs.writeFile(
      path.join(plugin, "manifest.json"),
      JSON.stringify({ id: "escape", name: "Escape", version: "0.1.0" }),
    );

    const error: ExtensionPortingError = await inspectUnpackedPlugin(plugin).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({
      name: "ExtensionPortingError",
    } satisfies Partial<ExtensionPortingError>);
    expect(["input", "containment"]).toContain(error.code);
    expect(error.message).not.toContain("SECRET-OUTSIDE-MAIN");
  });

  it("fails closed when a receipt-bound manifest, stylesheet, or package entry changes", async () => {
    const root = await temporaryDirectory("receipt");
    const plugin = path.join(root, "plugin");
    await fs.cp(path.join(fixtureRoot, "measured"), plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, "styles.css"), ".porting { color: blue; }\n", "utf8");
    const receiptReport = await inspectUnpackedPlugin(plugin);
    expect(receiptReport.authorityReceipt).not.toBeNull();
    const receiptPath = path.join(root, "inspection.json");
    await fs.writeFile(receiptPath, `${JSON.stringify(receiptReport.authorityReceipt)}\n`, "utf8");

    await fs.writeFile(
      path.join(plugin, "manifest.json"),
      JSON.stringify({
        id: "threadleaf-porting-fixture",
        name: "Threadleaf Porting Fixture",
        version: "9.9.9",
      }),
      "utf8",
    );
    const manifestTamper = await inspectUnpackedPlugin(plugin, { receiptPath });
    expect(manifestTamper.diagnostics.map((item) => item.code)).toContain(
      "manifest-version-mismatch",
    );
    expect(manifestTamper.diagnostics.map((item) => item.code)).toContain(
      "inspection-receipt-invalid",
    );

    await fs.cp(path.join(fixtureRoot, "measured"), plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, "styles.css"), ".porting { color: red; }\n", "utf8");
    const stylesheetTamper = await inspectUnpackedPlugin(plugin, { receiptPath });
    expect(stylesheetTamper.diagnostics.map((item) => item.code)).toContain(
      "inspection-receipt-invalid",
    );

    await fs.cp(path.join(fixtureRoot, "measured"), plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, "extra.txt"), "unexpected\n", "utf8");
    const extraTamper = await inspectUnpackedPlugin(plugin, { receiptPath });
    expect(extraTamper.diagnostics.map((item) => item.code)).toContain("unexpected-package-entry");
    expect(extraTamper.diagnostics.map((item) => item.code)).toContain(
      "inspection-receipt-invalid",
    );
    expect(extraTamper.packageInspection.receipt.status).toBe("invalid");
  });

  it("does not trust a blocked caller receipt or echo its untrusted material", async () => {
    const source = path.join(fixtureRoot, "measured");
    const receiptReport = await inspectUnpackedPlugin(source);
    expect(receiptReport.authorityReceipt?.overall).toBe("blocked");
    const supplied = structuredClone(receiptReport.authorityReceipt);
    expect(supplied).not.toBeNull();
    if (!supplied) {
      throw new Error("The fixture must produce a canonical blocked receipt.");
    }
    supplied.limitations = ["UNTRUSTED-RECEIPT-MARKER", ...supplied.limitations];
    supplied.exactPackage.provenance = {
      ...supplied.exactPackage.provenance,
      sourceUrl: "file:///etc/passwd",
      releaseUrl: "data:text/html,<script>alert(1)</script>",
      indexUrl: "javascript:alert(1)",
      pluginId: "/absolute/untrusted/plugin",
      releaseTag: "<script>untrusted</script>",
    };
    const report = await inspectUnpackedPlugin(source, { receipt: supplied });

    expect(report.compatibility).toMatchObject({ status: "unverified", level: 0 });
    expect(report.packageInspection).toMatchObject({
      overall: "blocked",
      receipt: {
        status: "invalid",
        source: "provided",
        exactPackage: null,
      },
    });
    expect(report.authorityReceipt).toBeNull();
    expect(report.diagnostics.map((item) => item.code)).toContain("inspection-receipt-invalid");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("UNTRUSTED-RECEIPT-MARKER");
    expect(serialized).not.toContain("file:///etc/passwd");
    expect(serialized).not.toContain("data:text/html");
    expect(serialized).not.toContain("javascript:alert");
    expect(serialized).not.toContain("/absolute/untrusted/plugin");
    expect(serialized).not.toContain("<script>untrusted</script>");
  });

  it("validates generated and adversarial reports against the versioned JSON schema", async () => {
    const schema = JSON.parse(
      await fs.readFile(
        path.resolve("docs/compatibility/extension-porting-report.v1.schema.json"),
        "utf8",
      ),
    ) as JsonSchema;
    const report = await inspectUnpackedPlugin(path.join(fixtureRoot, "measured"));
    expect(validateReport(schema, report)).toEqual([]);

    const oversized = structuredClone(report);
    oversized.limitations = Array.from({ length: 65 }, (_, index) => `adversarial-${index}`);
    expect(validateReport(schema, oversized)).not.toEqual([]);

    const unknownField = structuredClone(report) as PortingReportWithUnknownField;
    unknownField.untrustedRawReceipt = "javascript:alert(1)";
    expect(validateReport(schema, unknownField)).not.toEqual([]);
  });

  it("bounds object receipt findings and limitations before verification", async () => {
    const source = path.join(fixtureRoot, "measured");
    const receiptReport = await inspectUnpackedPlugin(source);
    const supplied = structuredClone(receiptReport.authorityReceipt);
    expect(supplied).not.toBeNull();
    if (!supplied) {
      throw new Error("The fixture must produce a canonical receipt.");
    }
    supplied.limitations = Array.from(
      { length: 128 },
      (_, index) => `limitation-${index % 2}-${"x".repeat(2_000)}`,
    );
    supplied.staticAuthority.findings = [
      {
        capability: "workspace-ui",
        evidence: Array.from(
          { length: 128 },
          (_, index) => `evidence-${index % 2}-${"y".repeat(2_000)}`,
        ),
      },
    ];

    const report = await inspectUnpackedPlugin(source, { receipt: supplied });
    const serialized = JSON.stringify(report);
    expect(serialized.length).toBeLessThan(100_000);
    expect(report.packageInspection.receipt).toMatchObject({
      status: "invalid",
      source: "provided",
      exactPackage: null,
    });
    expect(serialized).not.toContain("limitation-0-");
    expect(serialized).not.toContain("evidence-0-");
  });

  it("bounds source-derived observations and scaffold output for a large input", async () => {
    const root = await temporaryDirectory("bounded");
    const plugin = path.join(root, "plugin");
    await fs.mkdir(plugin);
    await fs.writeFile(
      path.join(plugin, "manifest.json"),
      JSON.stringify({ id: "bounded", name: "Bounded", version: "0.1.0" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(plugin, "main.js"),
      `app.vault.${"x".repeat(1024 * 1024)}\n`,
      "utf8",
    );
    const report = await inspectUnpackedPlugin(plugin);
    expect(JSON.stringify(report).length).toBeLessThan(100_000);
    const output = path.join(root, "scaffold");
    await scaffoldPortingTemplate(report, "compatibility", output, plugin);
    const plan = await fs.readFile(path.join(output, "PORTING_PLAN.json"), "utf8");
    expect(plan.length).toBeLessThan(100_000);
    expect(plan).not.toContain("x".repeat(10_000));
  });

  it("scaffolds independently authored templates into an empty non-overlapping directory", async () => {
    const source = path.join(fixtureRoot, "measured");
    const report = await inspectUnpackedPlugin(source);
    const outputParent = await temporaryDirectory("scaffold");
    const output = path.join(outputParent, "native");
    const result = await scaffoldPortingTemplate(report, "native", output, source);
    expect(result.kind).toBe("native");
    expect(result.files).toEqual([
      "manifest.json",
      "PORTING_PLAN.json",
      "README.md",
      "src/index.ts",
      "tests/conformance.test.ts",
    ]);
    const generated = await fs.readFile(path.join(output, "src/index.ts"), "utf8");
    expect(generated).not.toContain("registerMarkdownPostProcessor");
    expect(generated).not.toContain("module.exports");
    expect(await fs.readFile(path.join(output, "PORTING_PLAN.json"), "utf8")).toContain(
      '"schemaVersion": 1',
    );
    await expect(scaffoldPortingTemplate(report, "native", output, source)).rejects.toMatchObject({
      code: "output",
    });
    await expect(
      scaffoldPortingTemplate(report, "native", path.join(source, "generated"), source),
    ).rejects.toMatchObject({ code: "containment" });
  });

  it("publishes scaffolds transactionally after a forced mid-write failure", async () => {
    const source = path.join(fixtureRoot, "measured");
    const report = await inspectUnpackedPlugin(source);
    const outputParent = await temporaryDirectory("transaction");
    const output = path.join(outputParent, "native");

    await expect(
      scaffoldPortingTemplate(report, "native", output, source, { failureAfterFile: 1 }),
    ).rejects.toMatchObject({ code: "output" });
    await expect(fs.lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(outputParent)).filter((entry) => entry.includes("threadleaf-staging")),
    ).toEqual([]);

    const result = await scaffoldPortingTemplate(report, "native", output, source);
    expect(result.kind).toBe("native");
    expect(await fs.readFile(path.join(output, "manifest.json"), "utf8")).toContain(
      '"manifestVersion": 1',
    );
  });
});

type PortingReportWithUnknownField = Awaited<ReturnType<typeof inspectUnpackedPlugin>> & {
  untrustedRawReceipt?: string;
};
