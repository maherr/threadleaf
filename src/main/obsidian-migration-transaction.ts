import { createHash, randomUUID } from "node:crypto";
import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import type { PersistedWorkspaceState } from "../application/workspace-state";
import {
  createWorkspaceLayout,
  parseWorkspaceState,
  workspaceStatesEqual,
} from "../application/workspace-state";
import { atomicWriteFile, readStableFileWithinLimit } from "../kernel/durability";
import type { ShortcutTargetId } from "../shared/key-bindings";
import {
  type AppSettings,
  appearanceForVault,
  parseAppSettings,
  pluginsForVault,
  updateKeyBinding,
  updateVaultAppearance,
  updateVaultPlugins,
} from "../shared/key-bindings";
import type {
  MigrationApplyOutcome,
  MigrationApplyRequest,
  MigrationCandidate,
  MigrationPlan,
  MigrationPrivateStateSummary,
  MigrationRollbackResponse,
  ObsidianMigrationPreview,
} from "../shared/migration";
import type { VaultPluginSettings } from "../shared/plugins";

const vaultIdPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{64}$/;
const planIdPattern = /^[a-f0-9]{64}$/;
const transactionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const maxTransactionsPerVault = 16;
const maximumJournalBytes = 16 * 1024 * 1024;

export interface MigrationPrivateState {
  settings: AppSettings;
  workspace: PersistedWorkspaceState | null;
}

export interface MigrationTransactionAdapter {
  writeSettings(settings: AppSettings, expectedCurrent?: AppSettings): Promise<void>;
  writeWorkspace(
    state: PersistedWorkspaceState | null,
    expectedCurrent?: PersistedWorkspaceState | null,
  ): Promise<void>;
}

export interface MigrationTransactionHooks {
  afterPhase?: (phase: MigrationTransactionPhase, transactionId: string) => Promise<void> | void;
}

export type MigrationTransactionPhase =
  | "prepared"
  | "settings-committed"
  | "workspace-committed"
  | "committed"
  | "rolled-back"
  | "aborted"
  | "conflict";

interface MigrationJournal {
  version: 1;
  id: string;
  vaultId: string;
  operation: "apply" | "rollback";
  rollbackOf: string | null;
  phase: MigrationTransactionPhase;
  planId: string;
  sourceDigest: string;
  selectedItemIds: string[];
  before: MigrationPrivateState;
  after: MigrationPrivateState;
  beforeRevision: string;
  afterRevision: string;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationRecoveryNotice {
  transactionId: string;
  status: "completed" | "aborted" | "conflict";
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function parseVaultId(value: string): string {
  if (!vaultIdPattern.test(value)) {
    throw new Error("Migration transactions require a lowercase SHA-256 vault identity.");
  }
  return value;
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedObject);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en-US"))
        .map((key) => [key, sortedObject(value[key])]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortedObject(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function cloneSettings(settings: AppSettings): AppSettings {
  return JSON.parse(stableJson(settings)) as AppSettings;
}

function cloneWorkspace(state: PersistedWorkspaceState | null): PersistedWorkspaceState | null {
  return state ? (JSON.parse(stableJson(state)) as PersistedWorkspaceState) : null;
}

function workspacePaths(state: PersistedWorkspaceState | null): string[] {
  return state ? state.panes.flatMap((pane) => pane.openPaths) : [];
}

function activeWorkspacePath(state: PersistedWorkspaceState | null): string | null {
  if (!state) {
    return null;
  }
  return state.panes.find((pane) => pane.id === state.activePaneId)?.activePath ?? null;
}

export function privateStateRevision(state: MigrationPrivateState): string {
  return digest(state);
}

export function privateStateSummary(
  state: MigrationPrivateState,
  vaultIdValue: string,
): MigrationPrivateStateSummary {
  return stateSummaryForVault(state, parseVaultId(vaultIdValue));
}

function stateSummaryForVault(
  state: MigrationPrivateState,
  vaultId: string,
): MigrationPrivateStateSummary {
  const appearance = appearanceForVault(state.settings, vaultId);
  const plugins = pluginsForVault(state.settings, vaultId);
  return {
    revision: privateStateRevision(state),
    enabledPluginIds: [...plugins.enabledPluginIds],
    colorScheme: appearance.colorScheme,
    themeId: appearance.themeId,
    enabledSnippetIds: [...appearance.enabledSnippetIds],
    keyBindings: { ...state.settings.keyBindings },
    workspacePaths: workspacePaths(state.workspace),
    activeWorkspacePath: activeWorkspacePath(state.workspace),
  };
}

function sourcePath(preview: ObsidianMigrationPreview, suffix: string): string[] {
  return preview.sourceEvidence
    .filter((evidence) => evidence.path === suffix || evidence.path.endsWith(suffix))
    .map((evidence) => evidence.path);
}

function workspaceProposal(preview: ObsidianMigrationPreview): {
  openPaths: string[];
  activePath: string | null;
} | null {
  if (!preview.workspace.sourcePath || preview.workspace.restorablePaths.length === 0) {
    return null;
  }
  return {
    openPaths: [...preview.workspace.restorablePaths],
    activePath: preview.workspace.activePath,
  };
}

function migrationCandidates(
  preview: ObsidianMigrationPreview,
  before: MigrationPrivateState,
  vaultId: string,
): {
  candidates: MigrationCandidate[];
  workspaceAfter: { openPaths: string[]; activePath: string | null } | null;
} {
  const currentAppearance = appearanceForVault(before.settings, vaultId);
  const currentPlugins = pluginsForVault(before.settings, vaultId);
  const candidates: MigrationCandidate[] = [];
  for (const plugin of preview.plugins) {
    if (!plugin.enabledInObsidian || currentPlugins.enabledPluginIds.includes(plugin.id)) {
      continue;
    }
    const packageStatus =
      plugin.packageState === "missing"
        ? "missing"
        : plugin.packageState !== "ready"
          ? "unsupported"
          : plugin.compatibility?.status !== "verified"
            ? "review"
            : plugin.authorityState !== "granted"
              ? "conflict"
              : "ready";
    const status =
      packageStatus === "ready" && currentPlugins.compatibilityMode !== "enabled"
        ? "conflict"
        : packageStatus;
    candidates.push({
      id: `plugin:${plugin.id}`,
      kind: "plugin-enable",
      label: plugin.name,
      status,
      message:
        status === "ready"
          ? "Exact installed version and current authority grant verified."
          : status === "missing"
            ? "Package is missing. Nothing will be downloaded."
            : packageStatus === "ready" && currentPlugins.compatibilityMode !== "enabled"
              ? "Enable compatibility mode explicitly before migrating plugin enablement."
              : status === "conflict"
                ? "A current exact-bundle authority grant is required before enablement."
                : plugin.compatibility?.status === "different-version"
                  ? "Installed version differs from the reviewed workflow evidence."
                  : "Package is not eligible for automatic migration.",
      sourcePaths: plugin.sourceEvidence.map((evidence) => evidence.path),
      before: currentPlugins.enabledPluginIds.includes(plugin.id) ? "enabled" : "disabled",
      after: "enabled",
    });
  }

  for (const hotkey of preview.hotkeys) {
    if (!hotkey.targetId) {
      continue;
    }
    let status: MigrationCandidate["status"] = hotkey.state === "ready" ? "ready" : "review";
    let message =
      status === "ready"
        ? "One behavior-tested binding is available for review."
        : "Multiple or unsupported bindings require manual review.";
    if (status === "ready") {
      try {
        const updated = updateKeyBinding(before.settings, hotkey.targetId, hotkey.candidateBinding);
        if (updated.keyBindings[hotkey.targetId] === before.settings.keyBindings[hotkey.targetId]) {
          continue;
        }
      } catch {
        status = "conflict";
        message = "This binding conflicts with an existing Threadleaf shortcut.";
      }
    }
    candidates.push({
      id: `hotkey:${hotkey.targetId}`,
      kind: "hotkey",
      label: hotkey.commandId,
      status,
      message,
      sourcePaths: sourcePath(preview, ".obsidian/hotkeys.json"),
      before: before.settings.keyBindings[hotkey.targetId] ?? null,
      after: hotkey.candidateBinding,
    });
  }

  if (
    preview.appearance.colorSchemeCandidate &&
    preview.appearance.colorSchemeCandidate !== currentAppearance.colorScheme
  ) {
    candidates.push({
      id: "appearance:scheme",
      kind: "appearance-scheme",
      label: "Base color scheme",
      status: "ready",
      message: "Reviewed Obsidian mode mapping.",
      sourcePaths: sourcePath(preview, ".obsidian/appearance.json"),
      before: currentAppearance.colorScheme,
      after: preview.appearance.colorSchemeCandidate,
    });
  } else if (preview.appearance.sourceColorScheme) {
    candidates.push({
      id: "appearance:scheme",
      kind: "appearance-scheme",
      label: "Base color scheme",
      status: "unsupported",
      message: "No reviewed Threadleaf mapping exists for this mode.",
      sourcePaths: sourcePath(preview, ".obsidian/appearance.json"),
      before: currentAppearance.colorScheme,
      after: null,
    });
  }
  if (preview.appearance.sourceThemeName) {
    const status = preview.appearance.themeIdCandidate ? "ready" : "missing";
    if (status !== "ready" || preview.appearance.themeIdCandidate !== currentAppearance.themeId) {
      candidates.push({
        id: "appearance:theme",
        kind: "appearance-theme",
        label: preview.appearance.sourceThemeName,
        status,
        message:
          status === "ready"
            ? "Contained theme.css is available for explicit selection."
            : "Theme package is missing.",
        sourcePaths: sourcePath(preview, ".obsidian/appearance.json"),
        before: currentAppearance.themeId,
        after: preview.appearance.themeIdCandidate,
      });
    }
  }
  for (const snippetId of preview.appearance.snippetIdsCandidate) {
    if (currentAppearance.enabledSnippetIds.includes(snippetId)) {
      continue;
    }
    candidates.push({
      id: `appearance:snippet:${snippetId}`,
      kind: "appearance-snippet",
      label: snippetId,
      status: "ready",
      message:
        "Contained CSS snippet is available for explicit selection. CSS is not applied during review.",
      sourcePaths: sourcePath(preview, ".obsidian/appearance.json"),
      before: currentAppearance.enabledSnippetIds.includes(snippetId) ? "enabled" : "disabled",
      after: "enabled",
    });
  }
  const workspace = workspaceProposal(preview);
  const proposedWorkspace =
    workspace && !(workspace.openPaths.length > 0 && workspace.activePath === null)
      ? createWorkspaceLayout(
          vaultId,
          [
            {
              id: "primary",
              openPaths: workspace.openPaths,
              activePath: workspace.activePath,
            },
          ],
          "primary",
          null,
        )
      : null;
  const workspaceIsNoop =
    before.workspace !== null &&
    proposedWorkspace !== null &&
    workspaceStatesEqual(before.workspace, proposedWorkspace);
  if (workspace && !workspaceIsNoop) {
    const hasLimitations =
      preview.workspace.missingPaths.length > 0 ||
      preview.workspace.unsupportedViewTypes.length > 0 ||
      (workspace.openPaths.length > 0 && workspace.activePath === null);
    candidates.push({
      id: "workspace:tabs",
      kind: "workspace",
      label: "Main-area note tabs",
      status: hasLimitations ? "review" : "ready",
      message: hasLimitations
        ? "Some source views, paths, or the active tab are not restorable and need review."
        : "Restorable main-area Markdown tabs are ready for selection.",
      sourcePaths: sourcePath(preview, preview.workspace.sourcePath ?? ""),
      before: workspacePaths(before.workspace).join("\n") || null,
      after: workspace.openPaths.join("\n"),
    });
  }
  return { candidates, workspaceAfter: workspaceIsNoop ? null : workspace };
}

export function buildMigrationPlan(
  preview: ObsidianMigrationPreview,
  before: MigrationPrivateState,
): MigrationPlan & { workspaceAfter: { openPaths: string[]; activePath: string | null } | null } {
  const vaultId = parseVaultId(preview.vaultId);
  const privateState = stateSummaryForVault(before, vaultId);
  const built = migrationCandidates(preview, before, vaultId);
  const unsigned = {
    version: 1 as const,
    vaultId,
    sourceDigest: preview.sourceDigest,
    privateStateRevision: privateStateRevision(before),
    sourceEvidence: preview.sourceEvidence,
    candidates: built.candidates,
    before: privateState,
    workspaceAfter: built.workspaceAfter,
  };
  return {
    ...unsigned,
    planId: digest(unsigned),
  };
}

function selectedSet(request: MigrationApplyRequest, plan: MigrationPlan): Set<string> {
  if (request.planId !== plan.planId || request.sourceDigest !== plan.sourceDigest) {
    throw new Error("Migration review is stale. Refresh the preview and review it again.");
  }
  const selected = new Set(request.selectedItemIds);
  if (selected.size !== request.selectedItemIds.length) {
    throw new Error("Migration review contains duplicate selections.");
  }
  if (selected.size === 0) {
    throw new Error("Select at least one reviewed migration item before applying.");
  }
  const candidates = new Map(plan.candidates.map((candidate) => [candidate.id, candidate]));
  for (const id of selected) {
    const candidate = candidates.get(id);
    if (!candidate) {
      throw new Error("Migration selection is not part of this reviewed plan.");
    }
    if (candidate.status !== "ready") {
      throw new Error(`${candidate.label} is ${candidate.status} and cannot be selected.`);
    }
  }
  return selected;
}

export function applyMigrationSelections(
  plan: MigrationPlan & {
    workspaceAfter?: { openPaths: string[]; activePath: string | null } | null;
  },
  request: MigrationApplyRequest,
  before: MigrationPrivateState,
): MigrationPrivateState {
  const selected = selectedSet(request, plan);
  const vaultId = parseVaultId(plan.vaultId);
  let settings = cloneSettings(before.settings);
  const currentPlugins = pluginsForVault(settings, vaultId);
  let plugins: VaultPluginSettings = {
    ...currentPlugins,
    enabledPluginIds: [...currentPlugins.enabledPluginIds],
    capabilityGrantsByPlugin: { ...currentPlugins.capabilityGrantsByPlugin },
  };
  let appearance = appearanceForVault(settings, vaultId);
  let pluginsTouched = false;
  let appearanceTouched = false;
  for (const candidate of plan.candidates) {
    if (!selected.has(candidate.id)) {
      continue;
    }
    if (candidate.kind === "plugin-enable") {
      const pluginId = candidate.id.slice("plugin:".length);
      plugins = {
        ...plugins,
        enabledPluginIds: [...new Set([...plugins.enabledPluginIds, pluginId])],
      };
      pluginsTouched = true;
    } else if (candidate.kind === "hotkey") {
      const targetId = candidate.id.slice("hotkey:".length) as ShortcutTargetId;
      settings = updateKeyBinding(settings, targetId, candidate.after);
    } else if (candidate.kind === "appearance-scheme" && candidate.after) {
      appearance = { ...appearance, colorScheme: candidate.after as typeof appearance.colorScheme };
      appearanceTouched = true;
    } else if (candidate.kind === "appearance-theme") {
      appearance = { ...appearance, themeId: candidate.after };
      appearanceTouched = true;
    } else if (candidate.kind === "appearance-snippet") {
      const snippetId = candidate.id.slice("appearance:snippet:".length);
      appearance = {
        ...appearance,
        enabledSnippetIds: [...new Set([...appearance.enabledSnippetIds, snippetId])],
      };
      appearanceTouched = true;
    }
  }
  if (pluginsTouched) {
    settings = updateVaultPlugins(settings, vaultId, plugins);
  }
  if (appearanceTouched) {
    settings = updateVaultAppearance(settings, vaultId, appearance);
  }
  let workspace = cloneWorkspace(before.workspace);
  const workspaceCandidate = plan.candidates.find(
    (candidate) => candidate.kind === "workspace" && selected.has(candidate.id),
  );
  if (workspaceCandidate && plan.workspaceAfter) {
    workspace = createWorkspaceLayout(
      vaultId,
      [
        {
          id: "primary",
          openPaths: plan.workspaceAfter.openPaths,
          activePath: plan.workspaceAfter.activePath,
        },
      ],
      "primary",
      null,
    );
  }
  return { settings, workspace };
}

function parsePrivateState(value: unknown, expectedVaultId: string): MigrationPrivateState {
  if (!isRecord(value) || !isRecord(value.settings)) {
    throw new Error("Migration transaction private state is malformed.");
  }
  return {
    settings: parseAppSettings(value.settings),
    workspace:
      value.workspace === null ? null : parseWorkspaceState(value.workspace, expectedVaultId),
  };
}

function parseJournal(
  value: unknown,
  expectedVaultId: string,
  expectedId?: string,
): MigrationJournal {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !transactionIdPattern.test(value.id) ||
    (expectedId !== undefined && value.id !== expectedId) ||
    value.vaultId !== expectedVaultId ||
    (value.operation !== "apply" && value.operation !== "rollback") ||
    typeof value.planId !== "string" ||
    !planIdPattern.test(value.planId) ||
    typeof value.sourceDigest !== "string" ||
    !revisionPattern.test(value.sourceDigest) ||
    !Array.isArray(value.selectedItemIds) ||
    value.selectedItemIds.length > 512 ||
    !value.selectedItemIds.every(
      (item): item is string => typeof item === "string" && item.length > 0 && item.length <= 300,
    ) ||
    new Set(value.selectedItemIds).size !== value.selectedItemIds.length ||
    typeof value.beforeRevision !== "string" ||
    !revisionPattern.test(value.beforeRevision) ||
    typeof value.afterRevision !== "string" ||
    !revisionPattern.test(value.afterRevision) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    ![
      "prepared",
      "settings-committed",
      "workspace-committed",
      "committed",
      "rolled-back",
      "aborted",
      "conflict",
    ].includes(String(value.phase)) ||
    !(
      value.rollbackOf === null ||
      (typeof value.rollbackOf === "string" && transactionIdPattern.test(value.rollbackOf))
    ) ||
    (value.operation === "apply" && value.rollbackOf !== null) ||
    (value.operation === "rollback" &&
      (typeof value.rollbackOf !== "string" ||
        value.selectedItemIds.length !== 0 ||
        value.phase === "rolled-back"))
  ) {
    throw new Error("Migration transaction journal is malformed.");
  }
  const before = parsePrivateState(value.before, expectedVaultId);
  const after = parsePrivateState(value.after, expectedVaultId);
  if (
    privateStateRevision(before) !== value.beforeRevision ||
    privateStateRevision(after) !== value.afterRevision
  ) {
    throw new Error("Migration transaction journal revision evidence is malformed.");
  }
  return {
    version: 1,
    id: value.id,
    vaultId: expectedVaultId,
    operation: value.operation,
    rollbackOf: value.rollbackOf,
    phase: value.phase as MigrationTransactionPhase,
    planId: value.planId,
    sourceDigest: value.sourceDigest,
    selectedItemIds: value.selectedItemIds.filter(
      (item): item is string => typeof item === "string",
    ),
    before,
    after,
    beforeRevision: value.beforeRevision,
    afterRevision: value.afterRevision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function validateJournalRelationships(journals: readonly MigrationJournal[]): void {
  const byId = new Map(journals.map((journal) => [journal.id, journal] as const));
  const committedRollbackOf = new Set(
    journals
      .filter((journal) => journal.operation === "rollback" && journal.phase === "committed")
      .map((journal) => journal.rollbackOf)
      .filter((id): id is string => id !== null),
  );
  for (const journal of journals) {
    if (journal.operation === "apply") {
      if (journal.phase === "rolled-back" && !committedRollbackOf.has(journal.id)) {
        throw new Error("Rolled-back migration journal has no committed rollback transaction.");
      }
      continue;
    }
    const source = journal.rollbackOf ? byId.get(journal.rollbackOf) : undefined;
    if (
      source?.operation !== "apply" ||
      source.id === journal.id ||
      !["committed", "rolled-back"].includes(source.phase)
    ) {
      throw new Error(
        "Migration rollback journal does not reference a retained apply transaction.",
      );
    }
  }
}

function journalBytes(journal: MigrationJournal): Buffer {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

export class MigrationRollbackConflict extends Error {
  readonly transactionId: string;
  readonly vaultId: string;

  constructor(vaultId: string, transactionId: string) {
    super("Private state changed after this migration. Review the newer changes before rollback.");
    this.name = "MigrationRollbackConflict";
    this.transactionId = transactionId;
    this.vaultId = vaultId;
  }
}

export class ObsidianMigrationTransactionManager {
  readonly #stateRoot: string;
  readonly #adapter: MigrationTransactionAdapter;
  readonly #clock: () => Date;
  readonly #hooks: MigrationTransactionHooks;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    stateRoot: string,
    adapter: MigrationTransactionAdapter,
    clock: () => Date = () => new Date(),
    hooks: MigrationTransactionHooks = {},
  ) {
    this.#stateRoot = path.resolve(stateRoot);
    this.#adapter = adapter;
    this.#clock = clock;
    this.#hooks = hooks;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#transactionsRoot(), { recursive: true, mode: 0o700 });
  }

  async recover(
    vaultIdValue: string,
    currentState: MigrationPrivateState | (() => Promise<MigrationPrivateState>),
  ): Promise<MigrationRecoveryNotice[]> {
    return this.#serialize(async () => {
      const vaultId = parseVaultId(vaultIdValue);
      let current = typeof currentState === "function" ? await currentState() : currentState;
      const root = this.#vaultRoot(vaultId);
      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return [];
        }
        throw error;
      }
      const journals: MigrationJournal[] = [];
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        journals.push(await this.#readJournal(vaultId, entry.name.slice(0, -5)));
      }
      validateJournalRelationships(journals);
      const notices: MigrationRecoveryNotice[] = [];
      for (const journal of journals) {
        const transactionId = journal.id;
        if (!["prepared", "settings-committed", "workspace-committed"].includes(journal.phase)) {
          continue;
        }
        const currentSettingsRevision = digest(current.settings);
        const beforeSettingsRevision = digest(journal.before.settings);
        const afterSettingsRevision = digest(journal.after.settings);
        const currentWorkspaceRevision = digest(current.workspace);
        const beforeWorkspaceRevision = digest(journal.before.workspace);
        const afterWorkspaceRevision = digest(journal.after.workspace);
        if (
          currentSettingsRevision === beforeSettingsRevision &&
          currentWorkspaceRevision === beforeWorkspaceRevision
        ) {
          journal.phase = "aborted";
          journal.updatedAt = this.#clock().toISOString();
          await this.#writeJournal(journal);
          notices.push({
            transactionId,
            status: "aborted",
            message: "Interrupted migration had not committed private state.",
          });
          continue;
        }
        if (
          currentSettingsRevision === afterSettingsRevision &&
          currentWorkspaceRevision === afterWorkspaceRevision
        ) {
          journal.phase = "committed";
          journal.updatedAt = this.#clock().toISOString();
          await this.#writeJournal(journal);
          notices.push({
            transactionId,
            status: "completed",
            message:
              "Interrupted migration was already fully committed. Reload plugins or restart Threadleaf if plugin enablement changed.",
          });
          continue;
        }
        if (
          currentSettingsRevision === afterSettingsRevision &&
          currentWorkspaceRevision === beforeWorkspaceRevision
        ) {
          await this.#adapter.writeWorkspace(
            cloneWorkspace(journal.after.workspace),
            cloneWorkspace(current.workspace),
          );
          current = {
            settings: cloneSettings(journal.after.settings),
            workspace: cloneWorkspace(journal.after.workspace),
          };
          journal.phase = "committed";
          journal.updatedAt = this.#clock().toISOString();
          await this.#writeJournal(journal);
          notices.push({
            transactionId,
            status: "completed",
            message:
              "Interrupted migration completed its pending workspace state. Reload plugins or restart Threadleaf if plugin enablement changed.",
          });
          continue;
        }
        journal.phase = "conflict";
        journal.updatedAt = this.#clock().toISOString();
        await this.#writeJournal(journal);
        notices.push({
          transactionId,
          status: "conflict",
          message: "Interrupted migration found newer private changes and was not rewritten.",
        });
      }
      const completedRollbackOf = new Set(
        journals
          .filter((journal) => journal.operation === "rollback" && journal.phase === "committed")
          .map((journal) => journal.rollbackOf)
          .filter((transactionId): transactionId is string => transactionId !== null),
      );
      for (const journal of journals) {
        if (
          journal.operation === "apply" &&
          journal.phase === "committed" &&
          completedRollbackOf.has(journal.id)
        ) {
          journal.phase = "rolled-back";
          journal.updatedAt = this.#clock().toISOString();
          await this.#writeJournal(journal);
        }
      }
      return notices;
    });
  }

  async latestRollbackTransaction(vaultIdValue: string): Promise<string | null> {
    return this.#serialize(async () => {
      const vaultId = parseVaultId(vaultIdValue);
      const root = this.#vaultRoot(vaultId);
      let entries: Dirent<string>[];
      try {
        entries = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          return null;
        }
        throw error;
      }
      const journals: MigrationJournal[] = [];
      for (const entry of entries
        .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        journals.push(await this.#readJournal(vaultId, entry.name.slice(0, -5)));
      }
      validateJournalRelationships(journals);
      const rolledBack = new Set(
        journals
          .filter((journal) => journal.operation === "rollback" && journal.phase === "committed")
          .map((journal) => journal.rollbackOf)
          .filter((transactionId): transactionId is string => transactionId !== null),
      );
      return (
        journals
          .filter(
            (journal) =>
              journal.operation === "apply" &&
              journal.phase === "committed" &&
              !rolledBack.has(journal.id),
          )
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
          )[0]?.id ?? null
      );
    });
  }

  async apply(options: {
    plan: MigrationPlan & {
      workspaceAfter?: { openPaths: string[]; activePath: string | null } | null;
    };
    request: MigrationApplyRequest;
    sourceDigest: string;
    current: MigrationPrivateState;
    next: MigrationPrivateState;
    validateReview: () => Promise<{
      planId: string;
      sourceDigest: string;
      privateStateRevision: string;
    }>;
  }): Promise<MigrationApplyOutcome> {
    return this.#serialize(async () => {
      const { plan, request, sourceDigest, current, next, validateReview } = options;
      const selected = selectedSet(request, plan);
      if (sourceDigest !== plan.sourceDigest) {
        throw new Error(
          "Obsidian metadata changed after review. Refresh the preview before applying.",
        );
      }
      if (privateStateRevision(current) !== plan.privateStateRevision) {
        throw new Error(
          "Threadleaf private state changed after review. Refresh the preview before applying.",
        );
      }
      if (privateStateRevision(next) === privateStateRevision(current)) {
        throw new Error("The reviewed selection would not change private state.");
      }
      const finalReview = await validateReview();
      if (
        finalReview.planId !== plan.planId ||
        finalReview.sourceDigest !== plan.sourceDigest ||
        finalReview.privateStateRevision !== plan.privateStateRevision
      ) {
        throw new Error(
          "Obsidian metadata, workspace paths, or private state changed before commit. Refresh the preview.",
        );
      }
      const vaultId = parseVaultId(plan.vaultId);
      const transactionId = randomUUID();
      const now = this.#clock().toISOString();
      const journal: MigrationJournal = {
        version: 1,
        id: transactionId,
        vaultId,
        operation: "apply",
        rollbackOf: null,
        phase: "prepared",
        planId: plan.planId,
        sourceDigest: plan.sourceDigest,
        selectedItemIds: [...selected],
        before: {
          settings: cloneSettings(current.settings),
          workspace: cloneWorkspace(current.workspace),
        },
        after: {
          settings: cloneSettings(next.settings),
          workspace: cloneWorkspace(next.workspace),
        },
        beforeRevision: privateStateRevision(current),
        afterRevision: privateStateRevision(next),
        createdAt: now,
        updatedAt: now,
      };
      await this.#writeJournal(journal);
      await this.#afterPhase(journal);
      await this.#adapter.writeSettings(cloneSettings(next.settings), current.settings);
      journal.phase = "settings-committed";
      journal.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(journal);
      await this.#afterPhase(journal);
      await this.#adapter.writeWorkspace(
        cloneWorkspace(next.workspace),
        cloneWorkspace(current.workspace),
      );
      journal.phase = "workspace-committed";
      journal.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(journal);
      await this.#afterPhase(journal);
      journal.phase = "committed";
      journal.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(journal);
      await this.#afterPhase(journal);
      const beforeSummary = stateSummaryForVault(current, vaultId);
      const afterSummary = stateSummaryForVault(next, vaultId);
      return {
        status: "applied",
        transactionId,
        vaultId,
        planId: plan.planId,
        selectedItemIds: [...selected],
        skippedItemIds: plan.candidates
          .map((candidate) => candidate.id)
          .filter((id) => !selected.has(id)),
        before: beforeSummary,
        after: afterSummary,
        rollbackAvailable: true,
      };
    });
  }

  async rollback(
    vaultIdValue: string,
    transactionId: string,
    current: MigrationPrivateState,
  ): Promise<MigrationRollbackResponse> {
    return this.#serialize(async () => {
      const vaultId = parseVaultId(vaultIdValue);
      const journal = await this.#readJournal(vaultId, transactionId);
      if (journal.operation !== "apply" || journal.phase !== "committed") {
        throw new Error("Migration transaction is not available for rollback.");
      }
      if (privateStateRevision(current) !== journal.afterRevision) {
        return {
          status: "conflict",
          vaultId,
          transactionId,
          message:
            "Private state changed after this migration. Review the newer changes before rollback.",
        };
      }
      const rollbackTransactionId = randomUUID();
      const now = this.#clock().toISOString();
      const rollback: MigrationJournal = {
        version: 1,
        id: rollbackTransactionId,
        vaultId,
        operation: "rollback",
        rollbackOf: transactionId,
        phase: "prepared",
        planId: journal.planId,
        sourceDigest: journal.sourceDigest,
        selectedItemIds: [],
        before: {
          settings: cloneSettings(current.settings),
          workspace: cloneWorkspace(current.workspace),
        },
        after: {
          settings: cloneSettings(journal.before.settings),
          workspace: cloneWorkspace(journal.before.workspace),
        },
        beforeRevision: privateStateRevision(current),
        afterRevision: journal.beforeRevision,
        createdAt: now,
        updatedAt: now,
      };
      await this.#writeJournal(rollback);
      await this.#afterPhase(rollback);
      await this.#adapter.writeSettings(cloneSettings(rollback.after.settings), current.settings);
      rollback.phase = "settings-committed";
      rollback.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(rollback);
      await this.#afterPhase(rollback);
      await this.#adapter.writeWorkspace(
        cloneWorkspace(rollback.after.workspace),
        cloneWorkspace(current.workspace),
      );
      rollback.phase = "workspace-committed";
      rollback.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(rollback);
      await this.#afterPhase(rollback);
      rollback.phase = "committed";
      rollback.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(rollback);
      await this.#afterPhase(rollback);
      journal.phase = "rolled-back";
      journal.updatedAt = this.#clock().toISOString();
      await this.#writeJournal(journal);
      return {
        status: "rolled-back",
        transactionId,
        rollbackTransactionId,
        vaultId,
        before: stateSummaryForVault(current, vaultId),
        after: stateSummaryForVault(rollback.after, vaultId),
      };
    });
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #afterPhase(journal: MigrationJournal): Promise<void> {
    await this.#hooks.afterPhase?.(journal.phase, journal.id);
  }

  #transactionsRoot(): string {
    return path.join(this.#stateRoot, "transactions");
  }

  #vaultRoot(vaultId: string): string {
    return path.join(this.#transactionsRoot(), vaultId);
  }

  #journalPath(vaultId: string, transactionId: string): string {
    if (!transactionIdPattern.test(transactionId)) {
      throw new Error("Migration transaction identity is malformed.");
    }
    return path.join(this.#vaultRoot(vaultId), `${transactionId}.json`);
  }

  async #readJournal(vaultId: string, transactionId: string): Promise<MigrationJournal> {
    const result = await readStableFileWithinLimit(
      this.#journalPath(vaultId, transactionId),
      maximumJournalBytes,
    );
    if (!result) {
      throw new Error("Migration transaction is missing.");
    }
    if (result.status === "too-large") {
      throw new Error("Migration transaction journal exceeds the private-state safety limit.");
    }
    const snapshot = result.snapshot;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes));
    } catch {
      throw new Error("Migration transaction journal is not valid JSON.");
    }
    return parseJournal(value, vaultId, transactionId);
  }

  async #writeJournal(journal: MigrationJournal): Promise<void> {
    await fs.mkdir(this.#vaultRoot(journal.vaultId), { recursive: true, mode: 0o700 });
    const bytes = journalBytes(journal);
    if (bytes.byteLength > maximumJournalBytes) {
      throw new Error("Migration transaction journal exceeds the private-state safety limit.");
    }
    const journalPath = this.#journalPath(journal.vaultId, journal.id);
    let exists = true;
    try {
      await fs.lstat(journalPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        exists = false;
      } else {
        throw error;
      }
    }
    if (!exists) {
      const remaining = await this.#pruneJournals(
        journal.vaultId,
        maxTransactionsPerVault - 1,
        new Set(journal.rollbackOf ? [journal.rollbackOf] : []),
      );
      if (remaining >= maxTransactionsPerVault) {
        throw new Error(
          "Too many pending migration transactions require recovery before another can start.",
        );
      }
    }
    await atomicWriteFile(journalPath, bytes);
    await this.#pruneJournals(journal.vaultId, maxTransactionsPerVault);
  }

  async #pruneJournals(
    vaultId: string,
    targetCount: number,
    protectedIds: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    const entries = (await fs.readdir(this.#vaultRoot(vaultId)))
      .filter((entry) => entry.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
    if (entries.length <= targetCount) {
      return entries.length;
    }
    const records: MigrationJournal[] = [];
    for (const entry of entries) {
      records.push(await this.#readJournal(vaultId, entry.slice(0, -5)));
    }
    validateJournalRelationships(records);
    const byId = new Map(records.map((record) => [record.id, record] as const));
    const referencedApplyIds = new Set(
      records
        .filter((record) => record.operation === "rollback")
        .map((record) => record.rollbackOf)
        .filter((id): id is string => id !== null),
    );
    const pending = new Set<MigrationTransactionPhase>([
      "prepared",
      "settings-committed",
      "workspace-committed",
    ]);
    const grouped = new Set<string>();
    const groups: Array<{ ids: string[]; updatedAt: string }> = [];
    for (const record of records) {
      if (
        record.operation !== "rollback" ||
        pending.has(record.phase) ||
        protectedIds.has(record.id)
      ) {
        continue;
      }
      const ids = [record.id];
      if (record.phase === "committed" && record.rollbackOf) {
        const source = byId.get(record.rollbackOf);
        if (source && !protectedIds.has(source.id)) {
          ids.push(source.id);
        }
      }
      for (const id of ids) {
        grouped.add(id);
      }
      groups.push({ ids, updatedAt: record.updatedAt });
    }
    for (const record of records) {
      if (
        grouped.has(record.id) ||
        pending.has(record.phase) ||
        protectedIds.has(record.id) ||
        (record.operation === "apply" && referencedApplyIds.has(record.id))
      ) {
        continue;
      }
      grouped.add(record.id);
      groups.push({ ids: [record.id], updatedAt: record.updatedAt });
    }
    let remaining = records.length;
    for (const group of groups.sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        (left.ids[0] ?? "").localeCompare(right.ids[0] ?? ""),
    )) {
      if (remaining <= targetCount) {
        break;
      }
      for (const id of group.ids) {
        await fs.unlink(this.#journalPath(vaultId, id));
        remaining -= 1;
      }
    }
    return remaining;
  }
}
