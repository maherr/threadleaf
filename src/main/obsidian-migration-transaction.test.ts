import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceLayout } from "../application/workspace-state";
import { createDefaultAppSettings, updateVaultPlugins } from "../shared/key-bindings";
import type { ObsidianMigrationPreview } from "../shared/migration";
import {
  applyMigrationSelections,
  buildMigrationPlan,
  type MigrationPrivateState,
  ObsidianMigrationTransactionManager,
} from "./obsidian-migration-transaction";

const vaultA = "a".repeat(64);
const vaultB = "b".repeat(64);
let sandboxPath: string;

function preview(vaultId: string): ObsidianMigrationPreview {
  return {
    vaultId,
    detected: true,
    readOnly: true,
    sourceDigest: "c".repeat(64),
    sourceEvidence: [
      {
        path: ".obsidian/community-plugins.json",
        state: "ready",
        byteLength: 18,
        sha256: "d".repeat(64),
      },
      {
        path: ".obsidian/appearance.json",
        state: "ready",
        byteLength: 36,
        sha256: "e".repeat(64),
      },
      {
        path: ".obsidian/hotkeys.json",
        state: "ready",
        byteLength: 54,
        sha256: "f".repeat(64),
      },
      {
        path: ".obsidian/plugins/exact/manifest.json",
        state: "ready",
        byteLength: 24,
        sha256: "1".repeat(64),
      },
      {
        path: ".obsidian/plugins/exact/main.js",
        state: "ready",
        byteLength: 24,
        sha256: "2".repeat(64),
      },
      {
        path: ".obsidian/plugins/exact/styles.css",
        state: "absent",
        byteLength: null,
        sha256: null,
      },
      {
        path: ".obsidian/plugins/exact/data.json",
        state: "absent",
        byteLength: null,
        sha256: null,
      },
    ],
    sources: [
      {
        path: ".obsidian/community-plugins.json",
        state: "ready",
        byteLength: 18,
        sha256: "d".repeat(64),
        message: null,
      },
      {
        path: ".obsidian/appearance.json",
        state: "ready",
        byteLength: 36,
        sha256: "e".repeat(64),
        message: null,
      },
      {
        path: ".obsidian/hotkeys.json",
        state: "ready",
        byteLength: 54,
        sha256: "f".repeat(64),
        message: null,
      },
    ],
    plugins: [
      {
        id: "exact",
        name: "Exact plugin",
        version: "1.0.0",
        enabledInObsidian: true,
        selectedInThreadleaf: false,
        packageState: "ready",
        authorityState: "granted",
        compatibility: {
          level: 4,
          status: "verified",
          testedVersion: "1.0.0",
          testedThreadleafVersion: "0.1.0",
          lastTested: "2026-08-12",
          summary: "fixture",
        },
        sourceEvidence: [
          {
            path: ".obsidian/plugins/exact/manifest.json",
            state: "ready",
            byteLength: 24,
            sha256: "1".repeat(64),
          },
          {
            path: ".obsidian/plugins/exact/main.js",
            state: "ready",
            byteLength: 24,
            sha256: "2".repeat(64),
          },
        ],
        settings: {
          state: "absent",
          byteLength: null,
          sha256: null,
          rootKind: null,
          topLevelEntryCount: null,
          message: "No settings",
        },
        message: "ready",
      },
    ],
    hotkeys: [
      {
        commandId: "command-palette:open",
        bindings: ["Mod+Shift+P"],
        owner: "core",
        targetId: "ui.command-palette",
        candidateBinding: "Mod+Shift+P",
        state: "ready",
        message: "ready",
      },
    ],
    appearance: {
      sourceColorScheme: "obsidian",
      colorSchemeCandidate: "dark",
      sourceThemeName: null,
      themeIdCandidate: null,
      themeAvailable: false,
      sourceSnippetNames: [],
      snippetIdsCandidate: [],
      missingSnippetNames: [],
    },
    workspace: {
      sourcePath: null,
      leafCount: 0,
      restorablePaths: [],
      missingPaths: [],
      activePath: null,
      recentFileCount: 0,
      unsupportedViewTypes: [],
    },
    warnings: [],
  };
}

function state(compatibilityMode: "enabled" | "restricted" = "enabled"): MigrationPrivateState {
  return {
    settings: updateVaultPlugins(createDefaultAppSettings(), vaultA, {
      compatibilityMode,
      enabledPluginIds: [],
      capabilityGrantsByPlugin: {},
    }),
    workspace: null,
  };
}

function validateReview(plan: ReturnType<typeof buildMigrationPlan>) {
  return async () => ({
    planId: plan.planId,
    sourceDigest: plan.sourceDigest,
    privateStateRevision: plan.privateStateRevision,
  });
}

class MemoryAdapter {
  current: MigrationPrivateState;

  constructor(initial: MigrationPrivateState) {
    this.current = initial;
  }

  async writeSettings(settings: MigrationPrivateState["settings"]): Promise<void> {
    this.current = { ...this.current, settings };
  }

  async writeWorkspace(workspace: MigrationPrivateState["workspace"]): Promise<void> {
    this.current = { ...this.current, workspace };
  }
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-migration-transaction-"));
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("reviewed Obsidian migration transactions", () => {
  it("binds plans to the vault identity and rejects stale source evidence", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const otherPlan = buildMigrationPlan(preview(vaultB), current);
    expect(plan.planId).not.toBe(otherPlan.planId);
    expect(plan.vaultId).toBe(vaultA);

    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
    );
    await manager.initialize();
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const next = applyMigrationSelections(plan, request, current);
    await expect(
      manager.apply({
        plan,
        request,
        sourceDigest: "9".repeat(64),
        current,
        next,
        validateReview: validateReview(plan),
      }),
    ).rejects.toThrow("metadata changed");
    expect(adapter.current.settings.pluginsByVault[vaultA]?.enabledPluginIds).toEqual([]);
  });

  it("revalidates source, workspace, and private receipts immediately before journaling", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const adapter = new MemoryAdapter(current);
    const stateRoot = path.join(sandboxPath, "state");
    const manager = new ObsidianMigrationTransactionManager(stateRoot, adapter);
    await manager.initialize();

    await expect(
      manager.apply({
        plan,
        request,
        sourceDigest: plan.sourceDigest,
        current,
        next: applyMigrationSelections(plan, request, current),
        validateReview: async () => ({
          planId: "9".repeat(64),
          sourceDigest: plan.sourceDigest,
          privateStateRevision: plan.privateStateRevision,
        }),
      }),
    ).rejects.toThrow("changed before commit");
    expect(adapter.current).toEqual(current);
    await expect(fs.readdir(path.join(stateRoot, "transactions", vaultA))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a source mutation after the final receipt read and before journaling", async () => {
    const current = state();
    const sourcePath = path.join(sandboxPath, "source.json");
    await fs.writeFile(sourcePath, "before", "utf8");
    const migrationPreview = preview(vaultA);
    migrationPreview.sourceDigest = createHash("sha256").update("before", "utf8").digest("hex");
    const plan = buildMigrationPlan(migrationPreview, current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const adapter = new MemoryAdapter(current);
    let firstValidation = true;
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
    );
    await manager.initialize();
    await expect(
      manager.apply({
        plan,
        request,
        sourceDigest: plan.sourceDigest,
        current,
        next: applyMigrationSelections(plan, request, current),
        validateReview: async () => {
          const sourceDigest = createHash("sha256")
            .update(await fs.readFile(sourcePath))
            .digest("hex");
          if (firstValidation) {
            firstValidation = false;
            await fs.writeFile(sourcePath, "after", "utf8");
          }
          return {
            planId: plan.planId,
            sourceDigest,
            privateStateRevision: plan.privateStateRevision,
          };
        },
      }),
    ).rejects.toThrow("changed before commit");
    expect(adapter.current).toEqual(current);
    expect(firstValidation).toBe(false);
  });

  it("applies a partial reviewed choice, records before/after state, and rolls it back", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const next = applyMigrationSelections(plan, request, current);
    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
    );
    await manager.initialize();
    const outcome = await manager.apply({
      plan,
      request,
      sourceDigest: plan.sourceDigest,
      current,
      next,
      validateReview: validateReview(plan),
    });
    expect(outcome.selectedItemIds).toEqual(["plugin:exact"]);
    expect(outcome.skippedItemIds).toContain("hotkey:ui.command-palette");
    expect(outcome.after.enabledPluginIds).toEqual(["exact"]);
    expect(adapter.current.settings.pluginsByVault[vaultA]?.enabledPluginIds).toEqual(["exact"]);

    const rollback = await manager.rollback(vaultA, outcome.transactionId, adapter.current);
    expect(rollback.status).toBe("rolled-back");
    expect(adapter.current.settings.pluginsByVault[vaultA]?.enabledPluginIds).toEqual([]);
  });

  it("refuses to clobber a newer private change during rollback", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
    );
    await manager.initialize();
    const outcome = await manager.apply({
      plan,
      request,
      sourceDigest: plan.sourceDigest,
      current,
      next: applyMigrationSelections(plan, request, current),
      validateReview: validateReview(plan),
    });
    adapter.current.settings.keyBindings["editor.revert-note"] = "Alt+R";
    const rollback = await manager.rollback(vaultA, outcome.transactionId, adapter.current);
    expect(rollback).toMatchObject({ status: "conflict", transactionId: outcome.transactionId });
    expect(adapter.current.settings.pluginsByVault[vaultA]?.enabledPluginIds).toEqual(["exact"]);
  });

  it("recovers an interruption after settings but before workspace state", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const adapter = new MemoryAdapter(current);
    let interrupt = true;
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
      () => new Date("2026-08-12T22:00:00.000Z"),
      {
        afterPhase: async (phase) => {
          if (phase === "settings-committed" && interrupt) {
            interrupt = false;
            throw new Error("simulated interruption");
          }
        },
      },
    );
    await manager.initialize();
    await expect(
      manager.apply({
        plan,
        request,
        sourceDigest: plan.sourceDigest,
        current,
        next: applyMigrationSelections(plan, request, current),
        validateReview: validateReview(plan),
      }),
    ).rejects.toThrow("simulated interruption");
    expect(adapter.current.settings.pluginsByVault[vaultA]?.enabledPluginIds).toEqual(["exact"]);

    const recovered = await new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
      () => new Date("2026-08-12T22:01:00.000Z"),
    );
    await recovered.initialize();
    const notices = await recovered.recover(vaultA, adapter.current);
    expect(notices).toMatchObject([{ status: "completed" }]);
  });

  it("serializes recovery behind a migration that is still applying", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const adapter = new MemoryAdapter(current);
    let markPrepared: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      markPrepared = resolve;
    });
    let continueApply: () => void = () => undefined;
    const applyGate = new Promise<void>((resolve) => {
      continueApply = resolve;
    });
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
      () => new Date("2026-08-12T22:00:00.000Z"),
      {
        afterPhase: async (phase) => {
          if (phase === "prepared") {
            markPrepared();
            await applyGate;
          }
        },
      },
    );
    await manager.initialize();
    const applying = manager.apply({
      plan,
      request,
      sourceDigest: plan.sourceDigest,
      current,
      next: applyMigrationSelections(plan, request, current),
      validateReview: validateReview(plan),
    });
    await prepared;

    let recoveryStateRead = false;
    let recoveryFinished = false;
    const recovering = manager
      .recover(vaultA, async () => {
        recoveryStateRead = true;
        return adapter.current;
      })
      .then((notices) => {
        recoveryFinished = true;
        return notices;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recoveryFinished).toBe(false);
    expect(recoveryStateRead).toBe(false);

    continueApply();
    await applying;
    expect(await recovering).toEqual([]);
    expect(recoveryStateRead).toBe(true);
  });

  it("rejects an oversized private migration journal without reading it", async () => {
    const stateRoot = path.join(sandboxPath, "state");
    const manager = new ObsidianMigrationTransactionManager(stateRoot, new MemoryAdapter(state()));
    await manager.initialize();
    const vaultRoot = path.join(stateRoot, "transactions", vaultA);
    const transactionId = "00000000-0000-0000-0000-000000000000";
    const journalPath = path.join(vaultRoot, `${transactionId}.json`);
    await fs.mkdir(vaultRoot, { recursive: true });
    await fs.writeFile(journalPath, "");
    await fs.truncate(journalPath, 16 * 1024 * 1024 + 1);

    await expect(manager.recover(vaultA, state())).rejects.toThrow(
      "journal exceeds the private-state safety limit",
    );
  });

  it("rejects a journal whose retained state no longer matches its revision receipt", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const stateRoot = path.join(sandboxPath, "state");
    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(stateRoot, adapter);
    await manager.initialize();
    const outcome = await manager.apply({
      plan,
      request,
      sourceDigest: plan.sourceDigest,
      current,
      next: applyMigrationSelections(plan, request, current),
      validateReview: validateReview(plan),
    });
    const journalPath = path.join(
      stateRoot,
      "transactions",
      vaultA,
      `${outcome.transactionId}.json`,
    );
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.afterRevision = "9".repeat(64);
    await fs.writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");

    await expect(manager.latestRollbackTransaction(vaultA)).rejects.toThrow(
      "revision evidence is malformed",
    );
  });

  it("rejects impossible rollback phases and missing rollback relationships", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const stateRoot = path.join(sandboxPath, "state");
    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(stateRoot, adapter);
    await manager.initialize();
    const outcome = await manager.apply({
      plan,
      request,
      sourceDigest: plan.sourceDigest,
      current,
      next: applyMigrationSelections(plan, request, current),
      validateReview: validateReview(plan),
    });
    const vaultRoot = path.join(stateRoot, "transactions", vaultA);
    const applyPath = path.join(vaultRoot, `${outcome.transactionId}.json`);
    const applyJournal = JSON.parse(await fs.readFile(applyPath, "utf8")) as Record<
      string,
      unknown
    >;
    applyJournal.phase = "rolled-back";
    await fs.writeFile(applyPath, `${JSON.stringify(applyJournal)}\n`, "utf8");
    await expect(manager.latestRollbackTransaction(vaultA)).rejects.toThrow(
      "no committed rollback transaction",
    );

    applyJournal.phase = "committed";
    await fs.writeFile(applyPath, `${JSON.stringify(applyJournal)}\n`, "utf8");
    const orphanRollback = {
      ...applyJournal,
      id: "00000000-0000-4000-8000-000000000001",
      operation: "rollback",
      rollbackOf: "00000000-0000-4000-8000-000000000002",
      phase: "prepared",
      selectedItemIds: [],
    };
    await fs.writeFile(
      path.join(vaultRoot, `${orphanRollback.id}.json`),
      `${JSON.stringify(orphanRollback)}\n`,
      "utf8",
    );
    await expect(manager.latestRollbackTransaction(vaultA)).rejects.toThrow(
      "does not reference a retained apply transaction",
    );
  });

  it("bounds pending journals and refuses a seventeenth interrupted transaction", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const stateRoot = path.join(sandboxPath, "state");
    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(
      stateRoot,
      adapter,
      () => new Date("2026-08-12T22:00:00.000Z"),
      {
        afterPhase: (phase) => {
          if (phase === "prepared") {
            throw new Error("simulated interruption");
          }
        },
      },
    );
    await manager.initialize();
    const apply = () =>
      manager.apply({
        plan,
        request,
        sourceDigest: plan.sourceDigest,
        current,
        next: applyMigrationSelections(plan, request, current),
        validateReview: validateReview(plan),
      });
    for (let index = 0; index < 16; index += 1) {
      await expect(apply()).rejects.toThrow("simulated interruption");
    }
    await expect(apply()).rejects.toThrow(
      "Too many pending migration transactions require recovery",
    );
    await expect(fs.readdir(path.join(stateRoot, "transactions", vaultA))).resolves.toHaveLength(
      16,
    );
  });

  it("reaps an interrupted apply/rollback retention pair before validating journals", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const stateRoot = path.join(sandboxPath, "state");
    const adapter = new MemoryAdapter(current);
    let injectRetentionFailure = false;
    let deletedBeforeFailure = 0;
    const manager = new ObsidianMigrationTransactionManager(
      stateRoot,
      adapter,
      () => new Date("2026-08-12T22:00:00.000Z"),
      {
        afterJournalDeletion: () => {
          if (injectRetentionFailure) {
            deletedBeforeFailure += 1;
            throw new Error("simulated retention interruption");
          }
        },
      },
    );
    await manager.initialize();
    for (let index = 0; index < 8; index += 1) {
      const outcome = await manager.apply({
        plan,
        request,
        sourceDigest: plan.sourceDigest,
        current,
        next: applyMigrationSelections(plan, request, current),
        validateReview: validateReview(plan),
      });
      await expect(
        manager.rollback(vaultA, outcome.transactionId, adapter.current),
      ).resolves.toMatchObject({
        status: "rolled-back",
      });
    }

    injectRetentionFailure = true;
    await expect(
      manager.apply({
        plan,
        request,
        sourceDigest: plan.sourceDigest,
        current,
        next: applyMigrationSelections(plan, request, current),
        validateReview: validateReview(plan),
      }),
    ).rejects.toThrow("simulated retention interruption");
    expect(deletedBeforeFailure).toBe(1);

    const vaultRoot = path.join(stateRoot, "transactions", vaultA);
    await expect(
      fs
        .readdir(vaultRoot)
        .then((entries) => entries.some((entry) => entry.startsWith(".threadleaf-retention-"))),
    ).resolves.toBe(true);

    const recovered = new ObsidianMigrationTransactionManager(stateRoot, adapter);
    await recovered.initialize();
    await expect(recovered.recover(vaultA, adapter.current)).resolves.toEqual([]);
    await expect(
      fs.readdir(vaultRoot).then((entries) => entries.filter((entry) => entry.endsWith(".json"))),
    ).resolves.toHaveLength(14);
    await expect(recovered.latestRollbackTransaction(vaultA)).resolves.toBeNull();
  });

  it("rejects malformed selection and unsupported candidates without writing state", async () => {
    const current = state();
    const malformedPreview = preview(vaultA);
    const plugin = malformedPreview.plugins[0];
    expect(plugin).toBeDefined();
    if (plugin) {
      plugin.authorityState = "required";
    }
    const plan = buildMigrationPlan(malformedPreview, current);
    const adapter = new MemoryAdapter(current);
    expect(() =>
      applyMigrationSelections(
        plan,
        {
          planId: plan.planId,
          sourceDigest: plan.sourceDigest,
          selectedItemIds: ["plugin:exact"],
        },
        current,
      ),
    ).toThrow("conflict");
    expect(adapter.current).toEqual(current);
  });

  it("locks plugin enablement while compatibility mode is restricted", () => {
    const current = state("restricted");
    const plan = buildMigrationPlan(preview(vaultA), current);
    const candidate = plan.candidates.find((item) => item.id === "plugin:exact");
    expect(candidate).toMatchObject({
      status: "conflict",
      message: "Enable compatibility mode explicitly before migrating plugin enablement.",
    });
    expect(() =>
      applyMigrationSelections(
        plan,
        {
          planId: plan.planId,
          sourceDigest: plan.sourceDigest,
          selectedItemIds: ["plugin:exact"],
        },
        current,
      ),
    ).toThrow("conflict");
  });

  it("locks a reviewed hotkey that collides with an existing Threadleaf shortcut", () => {
    const current = state();
    const migrationPreview = preview(vaultA);
    const hotkey = migrationPreview.hotkeys[0];
    expect(hotkey).toBeDefined();
    if (hotkey) {
      hotkey.bindings = ["Mod+P"];
      hotkey.candidateBinding = "Mod+P";
    }
    const plan = buildMigrationPlan(migrationPreview, current);
    expect(plan.candidates.find((item) => item.kind === "hotkey")).toMatchObject({
      status: "conflict",
      message: "This binding conflicts with an existing Threadleaf shortcut.",
    });
  });

  it("omits candidates whose private target state is already satisfied", () => {
    const current = state();
    const firstPlan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: firstPlan.planId,
      sourceDigest: firstPlan.sourceDigest,
      selectedItemIds: ["plugin:exact", "hotkey:ui.command-palette", "appearance:scheme"],
    };
    const migrated = applyMigrationSelections(firstPlan, request, current);
    const nextPlan = buildMigrationPlan(preview(vaultA), migrated);
    expect(nextPlan.candidates.map((candidate) => candidate.id)).not.toEqual(
      expect.arrayContaining(["plugin:exact", "hotkey:ui.command-palette", "appearance:scheme"]),
    );

    const workspacePreview = preview(vaultA);
    workspacePreview.workspace = {
      sourcePath: ".obsidian/workspace.json",
      leafCount: 1,
      restorablePaths: ["Present.md"],
      missingPaths: [],
      activePath: "Present.md",
      recentFileCount: 1,
      unsupportedViewTypes: [],
    };
    const workspaceCurrent = {
      ...current,
      workspace: createWorkspaceLayout(
        vaultA,
        [{ id: "primary", openPaths: ["Present.md"], activePath: "Present.md" }],
        "primary",
        null,
      ),
    };
    const workspacePlan = buildMigrationPlan(workspacePreview, workspaceCurrent);
    expect(workspacePlan.candidates.some((candidate) => candidate.id === "workspace:tabs")).toBe(
      false,
    );
    expect(workspacePlan.workspaceAfter).toBeNull();
  });

  it("locks a workspace candidate whose active tab is no longer restorable", async () => {
    const current = state();
    const migrationPreview = preview(vaultA);
    migrationPreview.workspace = {
      sourcePath: ".obsidian/workspace.json",
      leafCount: 1,
      restorablePaths: ["Present.md"],
      missingPaths: [],
      activePath: null,
      recentFileCount: 1,
      unsupportedViewTypes: [],
    };
    const plan = buildMigrationPlan(migrationPreview, current);
    const workspaceCandidate = plan.candidates.find((candidate) => candidate.kind === "workspace");
    expect(workspaceCandidate?.status).toBe("review");
    expect(() =>
      applyMigrationSelections(
        plan,
        {
          planId: plan.planId,
          sourceDigest: plan.sourceDigest,
          selectedItemIds: [workspaceCandidate?.id ?? "workspace:tabs"],
        },
        current,
      ),
    ).toThrow("review");
  });

  it("repairs the apply receipt when rollback commits before its source journal is marked", async () => {
    const current = state();
    const plan = buildMigrationPlan(preview(vaultA), current);
    const request = {
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      selectedItemIds: ["plugin:exact"],
    };
    const adapter = new MemoryAdapter(current);
    const manager = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
    );
    await manager.initialize();
    const outcome = await manager.apply({
      plan,
      request,
      sourceDigest: plan.sourceDigest,
      current,
      next: applyMigrationSelections(plan, request, current),
      validateReview: validateReview(plan),
    });
    let failRollbackCommit = true;
    const interruptedRollback = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
      () => new Date("2026-08-12T22:02:00.000Z"),
      {
        afterPhase: (phase) => {
          if (phase === "committed" && failRollbackCommit) {
            failRollbackCommit = false;
            throw new Error("simulated post-commit interruption");
          }
        },
      },
    );
    await expect(
      interruptedRollback.rollback(vaultA, outcome.transactionId, adapter.current),
    ).rejects.toThrow("post-commit interruption");
    const recovered = new ObsidianMigrationTransactionManager(
      path.join(sandboxPath, "state"),
      adapter,
    );
    await recovered.initialize();
    await recovered.recover(vaultA, adapter.current);
    expect(await recovered.latestRollbackTransaction(vaultA)).toBeNull();
  });
});
