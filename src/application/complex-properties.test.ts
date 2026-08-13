import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import {
  applyComplexMarkdownPropertyMutation,
  inspectComplexMarkdownProperties,
  mutateMarkdownNoteProperty,
  parseComplexPropertyPath,
  previewComplexMarkdownPropertyMutation,
} from "./complex-properties";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-complex-properties-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("complex property parsing and loss-preserving patches", () => {
  it("parses dotted and indexed paths", () => {
    expect(parseComplexPropertyPath("project.owner.name")).toEqual(["project", "owner", "name"]);
    expect(parseComplexPropertyPath("items[1].label")).toEqual(["items", 1, "label"]);
    expect(parseComplexPropertyPath('["project.name"].value')).toEqual(["project.name", "value"]);
  });

  it("patches a nested scalar while retaining comments, ordering, quotes, CRLF, and body bytes", () => {
    const original =
      '\ufeff---\r\n# Keep this comment\r\nproject:\r\n  owner: "Ada" # preserve this comment\r\n  priority: 2\r\nitems:\r\n  - first\r\n  - second\r\nunknown: [one, two]\r\n---\r\n# Body\r\n';
    const result = applyComplexMarkdownPropertyMutation(original, {
      kind: "set",
      path: "project.owner",
      value: "Grace",
    });
    expect(result.content).toBe(
      '\ufeff---\r\n# Keep this comment\r\nproject:\r\n  owner: "Grace" # preserve this comment\r\n  priority: 2\r\nitems:\r\n  - first\r\n  - second\r\nunknown: [one, two]\r\n---\r\n# Body\r\n',
    );
  });

  it("patches a list item and removes a nested leaf without reserializing the mapping", () => {
    const original = "---\ntags:\n  - one\n  - two\nmeta:\n  keep: yes\n  remove: no\n---\nBody";
    expect(
      applyComplexMarkdownPropertyMutation(original, { kind: "set", path: "tags[1]", value: "TWO" })
        .content,
    ).toContain("  - TWO");
    expect(
      applyComplexMarkdownPropertyMutation(original, { kind: "remove", path: "meta.remove" })
        .content,
    ).toBe("---\ntags:\n  - one\n  - two\nmeta:\n  keep: yes\n---\nBody");
  });

  it("patches a scalar inside a list-of-mappings without reordering sibling fields", () => {
    const original = [
      "---",
      "items:",
      "  - label: first # keep",
      "    owner: Ada",
      "  - label: second",
      "    owner: Lin",
      "---",
      "Body",
    ].join("\n");
    expect(
      applyComplexMarkdownPropertyMutation(original, {
        kind: "set",
        path: "items[1].label",
        value: "updated",
      }).content,
    ).toBe(
      [
        "---",
        "items:",
        "  - label: first # keep",
        "    owner: Ada",
        "  - label: updated",
        "    owner: Lin",
        "---",
        "Body",
      ].join("\n"),
    );
  });

  it("adds a nested scalar under an existing map and creates a nested envelope for a plain note", () => {
    const existing = "---\nmeta:\n  keep: yes\n---\nBody";
    expect(
      applyComplexMarkdownPropertyMutation(existing, {
        kind: "set",
        path: "meta.added",
        value: "value",
      }).content,
    ).toBe("---\nmeta:\n  keep: yes\n  added: value\n---\nBody");
    expect(
      applyComplexMarkdownPropertyMutation("Body", {
        kind: "set",
        path: "meta.owner",
        value: "Ada",
      }).content,
    ).toBe("---\nmeta:\n  owner: Ada\n---\nBody");
  });

  it("classifies unsupported constructs and permits an unrelated safe scalar edit", () => {
    const original = "---\nsafe: old\nanchor: &base\n  value: one\nmultiline: |\n  keep\n---\nBody";
    const inspection = inspectComplexMarkdownProperties(original);
    expect(inspection.status).toBe("unsupported");
    expect(inspection.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(["anchor", "multiline"]),
    );
    expect(
      applyComplexMarkdownPropertyMutation(original, { kind: "set", path: "safe", value: "new" })
        .content,
    ).toContain("safe: new");
    const refused = previewComplexMarkdownPropertyMutation(original, {
      kind: "set",
      path: "anchor.value",
      value: "changed",
    });
    expect(refused.status).toBe("unsupported");
    expect(refused.after).toBeNull();
  });

  it("refuses duplicate keys and syntax errors before any bytes are proposed", () => {
    const duplicate = previewComplexMarkdownPropertyMutation("---\na: one\na: two\n---\nBody", {
      kind: "set",
      path: "a",
      value: "three",
    });
    expect(duplicate.status).not.toBe("ready");
    expect(duplicate.message).toMatch(/duplicate|syntax/i);
    const broken = previewComplexMarkdownPropertyMutation("---\na: [one\n---\nBody", {
      kind: "set",
      path: "a",
      value: "three",
    });
    expect(broken.status).toBe("syntax-error");
    expect(broken.after).toBeNull();
  });
});

describe("revision-bound complex property mutations", () => {
  it("uses the recovery-backed writer and preserves a stale external winner", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Note.md"),
      "---\nmeta:\n  owner: old\n---\nBody",
      "utf8",
    );
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const initial = await kernel.readText("Note.md");
    const committed = await mutateMarkdownNoteProperty(
      kernel,
      "Note.md",
      { kind: "set", path: "meta.owner", value: "new" },
      initial.revision,
    );
    expect(committed).toMatchObject({
      status: "committed",
      propertyPath: "meta.owner",
      changed: true,
    });
    const current = await kernel.readText("Note.md");
    const stale = await mutateMarkdownNoteProperty(
      kernel,
      "Note.md",
      { kind: "set", path: "meta.owner", value: "stale" },
      initial.revision,
    );
    expect(stale).toMatchObject({ status: "stale", currentRevision: current.revision });
    await expect(fs.readFile(path.join(vaultPath, "Note.md"), "utf8")).resolves.toContain(
      "owner: new",
    );
  });
});
