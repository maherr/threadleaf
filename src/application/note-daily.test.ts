import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedStateRoot } from "../kernel/ports";
import { VaultKernel } from "../kernel/vault-kernel";
import { createDefaultVaultNoteWorkflowSettings } from "../shared/note-workflows";
import { openOrCreateDailyNote } from "./note-daily";

let sandboxPath: string;
let vaultPath: string;
let statePath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-daily-note-"));
  vaultPath = path.join(sandboxPath, "vault");
  statePath = path.join(sandboxPath, "state");
  await fs.mkdir(path.join(vaultPath, "Templates"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("daily notes", () => {
  it("creates nested daily notes through the recoverable writer and expands a template", async () => {
    await fs.writeFile(
      path.join(vaultPath, "Templates", "Daily.md"),
      "# {{title}}\nCreated {{date:dddd}} at {{time}}\n{{unknown}}\n",
      "utf8",
    );
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const result = await openOrCreateDailyNote(
      kernel,
      {
        ...createDefaultVaultNoteWorkflowSettings(),
        dailyNoteFolder: "Journal",
        dailyNoteDateFormat: "YYYY/MMMM/YYYY-MM-DD",
        dailyNoteTemplate: "Templates/Daily.md",
      },
      moment.parseZone("2026-08-12T18:07:09-04:00"),
    );

    expect(result).toMatchObject({
      path: "Journal/2026/August/2026-08-12.md",
      templatePath: "Templates/Daily.md",
      outcome: { status: "committed", path: "Journal/2026/August/2026-08-12.md" },
    });
    await expect(fs.readFile(path.join(vaultPath, result.path), "utf8")).resolves.toBe(
      "# 2026-08-12\nCreated Wednesday at 18:07\n{{unknown}}\n",
    );
    await expect(fs.readFile(path.join(vaultPath, "Templates", "Daily.md"), "utf8")).resolves.toBe(
      "# {{title}}\nCreated {{date:dddd}} at {{time}}\n{{unknown}}\n",
    );
  });

  it("opens an existing daily note without requiring or rewriting its configured template", async () => {
    await fs.writeFile(path.join(vaultPath, "2026-08-12.md"), "existing bytes", "utf8");
    const kernel = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    const result = await openOrCreateDailyNote(
      kernel,
      {
        ...createDefaultVaultNoteWorkflowSettings(),
        dailyNoteTemplate: "Templates/Missing.md",
      },
      moment.parseZone("2026-08-12T23:59:59-04:00"),
    );

    expect(result).toEqual({
      path: "2026-08-12.md",
      templatePath: null,
      outcome: {
        status: "exists",
        path: "2026-08-12.md",
        currentRevision: expect.any(String),
      },
    });
    await expect(fs.readFile(path.join(vaultPath, "2026-08-12.md"), "utf8")).resolves.toBe(
      "existing bytes",
    );
  });

  it("recovers an interrupted create without losing the daily note", async () => {
    let interrupted = false;
    const faulting = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
      faultInjector: (point) => {
        if (!interrupted && point === "write:after-install") {
          interrupted = true;
          throw new Error("simulated interruption");
        }
      },
    });
    const settings = createDefaultVaultNoteWorkflowSettings();
    const fixedNow = moment.parseZone("2026-08-12T18:07:09-04:00");
    await expect(openOrCreateDailyNote(faulting, settings, fixedNow)).rejects.toThrow(
      "simulated interruption",
    );

    const recovered = await VaultKernel.open({
      vaultRoot: vaultPath,
      stateRoot: new FixedStateRoot(statePath),
    });
    expect(recovered.startupRecoveryActions).toMatchObject([
      { kind: "write", outcome: "committed", path: "2026-08-12.md" },
    ]);
    await expect(fs.readFile(path.join(vaultPath, "2026-08-12.md"), "utf8")).resolves.toBe("");
    await expect(openOrCreateDailyNote(recovered, settings, fixedNow)).resolves.toMatchObject({
      outcome: { status: "exists", path: "2026-08-12.md" },
    });
  });
});
