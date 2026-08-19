import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowObject = Record<string, unknown>;

const workflowDirectory = path.resolve(".github", "workflows");
const immutableActions = new Set([
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "ilammy/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756",
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
]);

async function workflow(filename: string): Promise<WorkflowObject> {
  const parsed = parse(await readFile(path.join(workflowDirectory, filename), "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filename} is not a workflow object.`);
  }
  return parsed as WorkflowObject;
}

function object(value: unknown, label: string): WorkflowObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  return value as WorkflowObject;
}

function collectUses(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) {
      collectUses(child, found);
    }
    return found;
  }
  if (!value || typeof value !== "object") {
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "uses" && typeof child === "string") {
      found.push(child);
    } else {
      collectUses(child, found);
    }
  }
  return found;
}

function allJobs(document: WorkflowObject): WorkflowObject[] {
  return Object.values(object(document.jobs, "jobs")).map((job) => object(job, "job"));
}

function steps(job: WorkflowObject, label: string): WorkflowObject[] {
  const value = job.steps;
  if (!Array.isArray(value)) {
    throw new Error(`${label} has no steps.`);
  }
  return value.map((step) => object(step, `${label} step`));
}

function exactRun(job: WorkflowObject, command: string, label: string): WorkflowObject {
  const step = steps(job, label).find((candidate) => candidate.run === command);
  if (!step) {
    throw new Error(`${label} is missing ${command}.`);
  }
  return step;
}

describe("release workflows", () => {
  it("gates the Linux release on the packaged attachment workflow", async () => {
    const packageDocument = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageDocument.scripts ?? {};
    expect(scripts["release:linux"]).toBe(
      "pnpm run release:linux:prepare && pnpm run release:linux:verify",
    );
    expect(scripts["release:linux:prepare"]).toContain("pnpm run pack:dir");
    const verify = scripts["release:linux:verify"] ?? "";
    expect(verify.indexOf("pnpm run test:packaged-attachments:built")).toBeLessThan(
      verify.indexOf("pnpm run pack:linux"),
    );
  });

  it("pins every third-party action to an approved immutable commit", async () => {
    const uses = [
      ...collectUses(await workflow("ci.yml")),
      ...collectUses(await workflow("release.yml")),
    ];
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/u);
      expect(immutableActions.has(action), `Unreviewed action pin: ${action}`).toBe(true);
    }
  });

  it("runs native package CI with read-only repository authority", async () => {
    const document = await workflow("ci.yml");
    expect(Object.keys(object(document.on, "CI triggers")).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(document.permissions).toEqual({ contents: "read" });
    const jobs = object(document.jobs, "CI jobs");
    expect(Object.keys(jobs).sort()).toEqual(["integrity", "linux", "macos", "windows"]);
    for (const job of allJobs(document)) {
      expect(job["timeout-minutes"]).toEqual(expect.any(Number));
    }
    const encoded = JSON.stringify(document);
    expect(encoded).not.toContain("pull_request_target");
    expect(encoded).toContain("pnpm run release:linux");
    expect(encoded).toContain(`pack:mac:\${{ matrix.arch }}`);
    expect(encoded).toContain("pnpm run test:macos-package");
    expect(encoded).toContain("pnpm run test:windows-package");
    expect(encoded).toContain("pnpm run test:installer-lifecycle");
    expect(encoded).toContain("lifecycle-artifacts/windows-x64");
    expect(encoded).toContain("lifecycle-artifacts/macos-x64");
    expect(encoded).toContain("pnpm run test:installer-lifecycle-config");
    expect(encoded).toContain("macos-15-intel");
    expect(encoded).toContain("windows-2025");
  });

  it("keeps publication manual, draft-only, signed, and tag-bound", async () => {
    const document = await workflow("release.yml");
    const triggers = object(document.on, "release triggers");
    expect(Object.keys(triggers)).toEqual(["workflow_dispatch"]);
    const dispatch = object(triggers.workflow_dispatch, "workflow dispatch");
    const inputs = object(dispatch.inputs, "workflow inputs");
    expect(object(inputs.publish, "publish input")).toMatchObject({
      default: false,
      required: true,
      type: "boolean",
    });
    expect(document.permissions).toEqual({ contents: "read" });
    for (const job of allJobs(document)) {
      expect(job["timeout-minutes"]).toEqual(expect.any(Number));
    }

    const jobs = object(document.jobs, "release jobs");
    const publication = object(jobs["publish-draft"], "publication job");
    expect(publication.if).toBe(`\${{ inputs.publish }}`);
    expect(publication.permissions).toEqual({
      attestations: "write",
      contents: "write",
      "id-token": "write",
    });

    const encoded = JSON.stringify(document);
    expect(encoded).not.toContain('"push"');
    expect(encoded).toContain(`"ref":"\${{ inputs.tag }}"`);
    expect(encoded).toContain("pack:mac:universal");
    expect(encoded).toContain("pack:windows:signed");
    expect(encoded).toContain('THREADLEAF_REQUIRE_SIGNED":"1"');
    expect(encoded).toContain("gh release create");
    expect(encoded).toContain("--json isDraft");
    expect(encoded).toContain("--draft");
    expect(encoded).toContain("--verify-tag");

    const macos = object(jobs.macos, "signed macOS job");
    const windows = object(jobs.windows, "signed Windows job");
    expect(macos.if).toBeUndefined();
    expect(windows.if).toBeUndefined();
    expect(JSON.stringify(macos)).not.toContain("continue-on-error");
    expect(JSON.stringify(windows)).not.toContain("continue-on-error");
    expect(exactRun(macos, "pnpm run test:macos-package", "signed macOS job").env).toMatchObject({
      THREADLEAF_REQUIRE_SIGNED: "1",
    });
    expect(
      exactRun(windows, "pnpm run test:windows-package", "signed Windows job").env,
    ).toMatchObject({ THREADLEAF_REQUIRE_SIGNED: "1" });
    expect(publication.needs).toEqual(["preflight", "linux", "macos", "windows"]);
    expect(JSON.stringify(publication)).not.toContain("continue-on-error");
    expect(JSON.stringify(publication)).not.toContain("always()");
  });
});
