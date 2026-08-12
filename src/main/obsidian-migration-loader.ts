import { promises as fs } from "node:fs";
import path from "node:path";
import { hasPrivateVaultSegment, isPathInside, normalizeVaultPath } from "../kernel/path-policy";
import { normalizeKeyBinding, type ShortcutTargetId } from "../shared/key-bindings";
import type {
  AppearanceMigrationSummary,
  HotkeyMigrationSummary,
  MigrationSourceFileSummary,
  ObsidianMigrationPreview,
  PluginMigrationSummary,
  PluginSettingsMigrationSummary,
  WorkspaceMigrationSummary,
} from "../shared/migration";
import type { DiscoveredVaultPlugin } from "./vault-plugin-loader";
import { discoverVaultPlugins } from "./vault-plugin-loader";

const decoder = new TextDecoder("utf-8", { fatal: true });
const maximumCommunityPluginBytes = 128 * 1024;
const maximumAppearanceBytes = 256 * 1024;
const maximumHotkeyBytes = 512 * 1024;
const maximumWorkspaceBytes = 4 * 1024 * 1024;
const maximumPluginDataBytes = 4 * 1024 * 1024;
const maximumPluginCount = 256;
const maximumHotkeyCommandCount = 512;
const maximumBindingsPerCommand = 16;
const maximumWorkspaceNodes = 8_192;
const maximumWorkspacePaths = 1_024;

const sourceDefinitions = [
  { path: ".obsidian/community-plugins.json", maximumBytes: maximumCommunityPluginBytes },
  { path: ".obsidian/appearance.json", maximumBytes: maximumAppearanceBytes },
  { path: ".obsidian/hotkeys.json", maximumBytes: maximumHotkeyBytes },
  { path: ".obsidian/workspace.json", maximumBytes: maximumWorkspaceBytes },
  { path: ".obsidian/workspace-mobile.json", maximumBytes: maximumWorkspaceBytes },
] as const;

const hotkeyTargets: Readonly<Record<string, ShortcutTargetId>> = {
  "command-palette:open": "ui.command-palette",
};

interface JsonSource {
  summary: MigrationSourceFileSummary;
  value: unknown;
}

export interface ObsidianMigrationLoaderOptions {
  vaultPath: string;
  vaultId: string;
  selectedPluginIds: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function oneLine(value: string, maximumLength = 300): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximumLength);
}

function formatByteLimit(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.floor(bytes / 1024)} KiB`
    : `${Math.floor(bytes / (1024 * 1024))} MiB`;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error("File is not valid UTF-8.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSON could not be parsed.");
  }
}

async function canonicalContainedPath(rootPath: string, candidatePath: string): Promise<string> {
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath),
  ]);
  if (!isPathInside(canonicalRoot, canonicalCandidate)) {
    throw new Error("path resolves outside the vault");
  }
  return canonicalCandidate;
}

function lexicalVaultPath(vaultPath: string, relativePath: string): string {
  return path.resolve(vaultPath, ...relativePath.split("/"));
}

async function readJsonSource(
  vaultPath: string,
  relativePath: string,
  maximumBytes: number,
): Promise<JsonSource> {
  try {
    const filePath = await canonicalContainedPath(
      vaultPath,
      lexicalVaultPath(vaultPath, relativePath),
    );
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    if (stat.size > maximumBytes) {
      return {
        summary: {
          path: relativePath,
          state: "oversized",
          byteLength: stat.size,
          message: `File exceeds the ${formatByteLimit(maximumBytes)} preview limit.`,
        },
        value: undefined,
      };
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > maximumBytes) {
      return {
        summary: {
          path: relativePath,
          state: "oversized",
          byteLength: bytes.byteLength,
          message: `File grew beyond the ${formatByteLimit(maximumBytes)} preview limit.`,
        },
        value: undefined,
      };
    }
    return {
      summary: {
        path: relativePath,
        state: "ready",
        byteLength: bytes.byteLength,
        message: null,
      },
      value: parseJsonBytes(bytes),
    };
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      return {
        summary: { path: relativePath, state: "absent", byteLength: null, message: null },
        value: undefined,
      };
    }
    return {
      summary: {
        path: relativePath,
        state: "invalid",
        byteLength: null,
        message: oneLine(errorMessage(error)),
      },
      value: undefined,
    };
  }
}

function invalidateSource(source: JsonSource, error: unknown): void {
  source.summary.state = "invalid";
  source.summary.message = oneLine(errorMessage(error));
  source.value = undefined;
}

function boundedString(value: unknown, label: string, maximumLength = 500): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = oneLine(value, maximumLength);
  if (!normalized) {
    throw new Error(`${label} must not be empty.`);
  }
  return normalized;
}

function safePluginId(value: unknown): string {
  const pluginId = boundedString(value, "Community plugin identifier", 128);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(pluginId)) {
    throw new Error(`Invalid community plugin identifier: ${pluginId}`);
  }
  return pluginId;
}

function parseCommunityPluginIds(source: JsonSource, warnings: string[]): string[] {
  if (source.summary.state !== "ready") {
    return [];
  }
  try {
    if (!Array.isArray(source.value) || source.value.length > maximumPluginCount) {
      throw new Error(
        `Community plugin inventory must be an array with at most ${maximumPluginCount} entries.`,
      );
    }
    const ids: string[] = [];
    for (const value of source.value) {
      try {
        const pluginId = safePluginId(value);
        if (!ids.includes(pluginId)) {
          ids.push(pluginId);
        }
      } catch (error) {
        warnings.push(errorMessage(error));
      }
    }
    return ids;
  } catch (error) {
    invalidateSource(source, error);
    warnings.push(`Could not interpret community-plugins.json: ${errorMessage(error)}`);
    return [];
  }
}

function pluginDataRoot(value: unknown): {
  rootKind: PluginSettingsMigrationSummary["rootKind"];
  topLevelEntryCount: number;
} {
  if (Array.isArray(value)) {
    return { rootKind: "array", topLevelEntryCount: value.length };
  }
  if (isRecord(value)) {
    return { rootKind: "object", topLevelEntryCount: Object.keys(value).length };
  }
  return { rootKind: "primitive", topLevelEntryCount: 1 };
}

async function inspectPluginSettings(
  vaultPath: string,
  pluginId: string,
): Promise<PluginSettingsMigrationSummary> {
  const relativePath = `.obsidian/plugins/${pluginId}/data.json`;
  try {
    const filePath = await canonicalContainedPath(
      vaultPath,
      lexicalVaultPath(vaultPath, relativePath),
    );
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error("data.json is not a regular file");
    }
    if (stat.size > maximumPluginDataBytes) {
      return {
        state: "oversized",
        byteLength: stat.size,
        rootKind: null,
        topLevelEntryCount: null,
        message: `Settings exceed the ${formatByteLimit(maximumPluginDataBytes)} preview limit. Values were not read.`,
      };
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > maximumPluginDataBytes) {
      return {
        state: "oversized",
        byteLength: bytes.byteLength,
        rootKind: null,
        topLevelEntryCount: null,
        message: `Settings grew beyond the ${formatByteLimit(maximumPluginDataBytes)} preview limit. Values were not read.`,
      };
    }
    const shape = pluginDataRoot(parseJsonBytes(bytes));
    return {
      state: "shared",
      byteLength: bytes.byteLength,
      ...shape,
      message:
        "Valid JSON is shared in place. Previewing does not change it; an enabled plugin may update it through saveData.",
    };
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      return {
        state: "absent",
        byteLength: null,
        rootKind: null,
        topLevelEntryCount: null,
        message: "No data.json settings file is present.",
      };
    }
    return {
      state: "invalid",
      byteLength: null,
      rootKind: null,
      topLevelEntryCount: null,
      message: `Settings could not be previewed: ${oneLine(errorMessage(error))}`,
    };
  }
}

function pluginMessage(
  plugin: DiscoveredVaultPlugin | undefined,
  enabledInObsidian: boolean,
  selectedInThreadleaf: boolean,
): string {
  if (!plugin) {
    return "Enabled in Obsidian, but no installed package was found. Nothing will be selected.";
  }
  if (plugin.summary.packageState === "invalid") {
    return `Installed package is invalid: ${plugin.summary.error ?? "unknown validation failure"}`;
  }
  if (selectedInThreadleaf) {
    return "Already selected in Threadleaf. This preview did not load or change it.";
  }
  return enabledInObsidian
    ? "Available for explicit selection after review. This preview leaves it disabled."
    : "Installed but not enabled in Obsidian. This preview proposes no change.";
}

async function buildPluginPreview(
  vaultPath: string,
  enabledIds: readonly string[],
  selectedIds: readonly string[],
  warnings: string[],
): Promise<PluginMigrationSummary[]> {
  const discovery = await discoverVaultPlugins(vaultPath);
  warnings.push(...discovery.warnings);
  const discoveredById = new Map(
    discovery.plugins.map((plugin) => [plugin.summary.id, plugin] as const),
  );
  const orderedIds = [
    ...enabledIds,
    ...discovery.plugins
      .map((plugin) => plugin.summary.id)
      .filter((pluginId) => !enabledIds.includes(pluginId)),
  ];
  const selectedSet = new Set(selectedIds);
  return Promise.all(
    orderedIds.map(async (pluginId) => {
      const plugin = discoveredById.get(pluginId);
      const enabledInObsidian = enabledIds.includes(pluginId);
      const selectedInThreadleaf = selectedSet.has(pluginId);
      if (!plugin) {
        warnings.push(`Obsidian enables ${pluginId}, but its installed package is missing.`);
      }
      const settings = plugin
        ? await inspectPluginSettings(vaultPath, pluginId)
        : {
            state: "absent" as const,
            byteLength: null,
            rootKind: null,
            topLevelEntryCount: null,
            message: "No installed package or settings file is present.",
          };
      return {
        id: pluginId,
        name: plugin?.summary.name ?? pluginId,
        version: plugin?.summary.version === "unknown" ? null : (plugin?.summary.version ?? null),
        enabledInObsidian,
        selectedInThreadleaf,
        packageState: plugin?.summary.packageState ?? "missing",
        compatibility: plugin?.summary.compatibility ?? null,
        settings,
        message: pluginMessage(plugin, enabledInObsidian, selectedInThreadleaf),
      };
    }),
  );
}

function hotkeyOwner(
  commandId: string,
  pluginIds: ReadonlySet<string>,
): HotkeyMigrationSummary["owner"] {
  const prefix = commandId.split(":", 1)[0] ?? "";
  if (pluginIds.has(prefix)) {
    return "plugin";
  }
  return hotkeyTargets[commandId] ? "core" : "unknown";
}

function formatHotkeyBinding(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.modifiers) || value.modifiers.length > 8) {
    throw new Error("Hotkey bindings require a bounded modifiers array.");
  }
  const key = boundedString(value.key, "Hotkey key", 100);
  const modifiers = value.modifiers.map((modifier) =>
    boundedString(modifier, "Hotkey modifier", 30),
  );
  return [...modifiers, key].join("+");
}

function parseHotkeys(
  source: JsonSource,
  pluginIds: ReadonlySet<string>,
  warnings: string[],
): HotkeyMigrationSummary[] {
  if (source.summary.state !== "ready") {
    return [];
  }
  try {
    if (!isRecord(source.value)) {
      throw new Error("Hotkey overrides must be an object keyed by command identifier.");
    }
    const entries = Object.entries(source.value);
    if (entries.length > maximumHotkeyCommandCount) {
      throw new Error(`Hotkey overrides exceed the ${maximumHotkeyCommandCount} command limit.`);
    }
    return entries.map(([rawCommandId, rawBindings]) => {
      const commandId = boundedString(rawCommandId, "Hotkey command identifier", 300);
      if (!Array.isArray(rawBindings) || rawBindings.length > maximumBindingsPerCommand) {
        throw new Error(
          `Hotkey ${commandId} must contain at most ${maximumBindingsPerCommand} bindings.`,
        );
      }
      const bindings: string[] = [];
      for (const rawBinding of rawBindings) {
        try {
          bindings.push(formatHotkeyBinding(rawBinding));
        } catch (error) {
          warnings.push(`Hotkey ${commandId} contains an invalid binding: ${errorMessage(error)}`);
        }
      }
      const targetId = hotkeyTargets[commandId] ?? null;
      let candidateBinding: string | null = null;
      if (targetId && bindings.length === 1) {
        try {
          candidateBinding = normalizeKeyBinding(bindings[0] ?? "");
        } catch (error) {
          warnings.push(`Hotkey ${commandId} needs review: ${errorMessage(error)}`);
        }
      }
      const state = candidateBinding ? "ready" : "review";
      return {
        commandId,
        bindings,
        owner: hotkeyOwner(commandId, pluginIds),
        targetId,
        candidateBinding,
        state,
        message: candidateBinding
          ? `Candidate ${targetId} binding. No shortcut was changed.`
          : targetId
            ? "Multiple or unsupported bindings require review."
            : "No behavior-tested Threadleaf command mapping exists yet.",
      };
    });
  } catch (error) {
    invalidateSource(source, error);
    warnings.push(`Could not interpret hotkeys.json: ${errorMessage(error)}`);
    return [];
  }
}

function safeAssetName(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const name = boundedString(value, label, 300);
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`${label} must be a filename or folder name.`);
  }
  return name;
}

async function containedFileExists(vaultPath: string, relativePath: string): Promise<boolean> {
  try {
    const filePath = await canonicalContainedPath(
      vaultPath,
      lexicalVaultPath(vaultPath, relativePath),
    );
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function parseAppearance(
  vaultPath: string,
  source: JsonSource,
  warnings: string[],
): Promise<AppearanceMigrationSummary> {
  const empty: AppearanceMigrationSummary = {
    sourceColorScheme: null,
    colorSchemeCandidate: null,
    sourceThemeName: null,
    themeIdCandidate: null,
    themeAvailable: false,
    sourceSnippetNames: [],
    snippetIdsCandidate: [],
    missingSnippetNames: [],
  };
  if (source.summary.state !== "ready") {
    return empty;
  }
  try {
    if (!isRecord(source.value)) {
      throw new Error("Appearance settings must be an object.");
    }
    const sourceColorScheme = safeAssetName(source.value.theme, "Appearance theme mode");
    const colorSchemeCandidate =
      sourceColorScheme === "obsidian"
        ? "dark"
        : sourceColorScheme === "moonstone"
          ? "light"
          : sourceColorScheme === "system"
            ? "system"
            : null;
    if (sourceColorScheme && colorSchemeCandidate === null) {
      warnings.push(`Appearance mode ${sourceColorScheme} has no reviewed Threadleaf mapping.`);
    }
    const sourceThemeName = safeAssetName(source.value.cssTheme, "Community theme name");
    const themeAvailable = sourceThemeName
      ? await containedFileExists(vaultPath, `.obsidian/themes/${sourceThemeName}/theme.css`)
      : false;
    const themeIdCandidate =
      sourceThemeName && themeAvailable
        ? `obsidian-theme:${encodeURIComponent(sourceThemeName)}`
        : null;
    if (sourceThemeName && !themeAvailable) {
      warnings.push(
        `Selected Obsidian theme ${sourceThemeName} is not installed as a readable package.`,
      );
    }
    const rawSnippets = source.value.enabledCssSnippets ?? [];
    if (!Array.isArray(rawSnippets) || rawSnippets.length > 128) {
      throw new Error("Appearance enabledCssSnippets must contain at most 128 names.");
    }
    const sourceSnippetNames = rawSnippets
      .map((value) => safeAssetName(value, "CSS snippet name"))
      .filter((value): value is string => value !== null);
    const snippetIdsCandidate: string[] = [];
    const missingSnippetNames: string[] = [];
    for (const snippetName of sourceSnippetNames) {
      const filename = snippetName.toLocaleLowerCase("en-US").endsWith(".css")
        ? snippetName
        : `${snippetName}.css`;
      if (await containedFileExists(vaultPath, `.obsidian/snippets/${filename}`)) {
        snippetIdsCandidate.push(`obsidian-snippet:${encodeURIComponent(filename)}`);
      } else {
        missingSnippetNames.push(snippetName);
      }
    }
    if (missingSnippetNames.length > 0) {
      warnings.push(
        `${missingSnippetNames.length} enabled CSS snippet names are not readable files.`,
      );
    }
    return {
      sourceColorScheme,
      colorSchemeCandidate,
      sourceThemeName,
      themeIdCandidate,
      themeAvailable,
      sourceSnippetNames,
      snippetIdsCandidate,
      missingSnippetNames,
    };
  } catch (error) {
    invalidateSource(source, error);
    warnings.push(`Could not interpret appearance.json: ${errorMessage(error)}`);
    return empty;
  }
}

function normalizeWorkspaceFile(value: unknown): string {
  const filePath = normalizeVaultPath(boundedString(value, "Workspace file path", 2_000));
  if (hasPrivateVaultSegment(filePath) || !filePath.toLocaleLowerCase("en-US").endsWith(".md")) {
    throw new Error(`Workspace file is not a visible Markdown note: ${filePath}`);
  }
  return filePath;
}

interface WorkspaceLeafCandidate {
  id: string | null;
  area: "left" | "main" | "right";
  viewType: string;
  filePath: string | null;
}

function collectWorkspaceLeaves(root: Record<string, unknown>): WorkspaceLeafCandidate[] {
  const stack: Array<{ area: WorkspaceLeafCandidate["area"]; value: unknown }> = [
    { area: "right", value: root.right },
    { area: "left", value: root.left },
    { area: "main", value: root.main },
  ];
  const leaves: WorkspaceLeafCandidate[] = [];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !isRecord(current.value)) {
      continue;
    }
    visited += 1;
    if (visited > maximumWorkspaceNodes) {
      throw new Error(`Workspace layout exceeds the ${maximumWorkspaceNodes} node preview limit.`);
    }
    if (current.value.type === "leaf") {
      const state = isRecord(current.value.state) ? current.value.state : {};
      const viewType =
        typeof state.type === "string" ? oneLine(state.type, 200) || "unknown" : "unknown";
      const nestedState = isRecord(state.state) ? state.state : {};
      let filePath: string | null = null;
      if (
        current.area === "main" &&
        (viewType === "markdown" || viewType === "excalidraw") &&
        typeof nestedState.file === "string"
      ) {
        try {
          filePath = normalizeWorkspaceFile(nestedState.file);
        } catch {
          filePath = null;
        }
      }
      leaves.push({
        id: typeof current.value.id === "string" ? oneLine(current.value.id, 300) : null,
        area: current.area,
        viewType,
        filePath,
      });
      continue;
    }
    const children = Array.isArray(current.value.children) ? current.value.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ area: current.area, value: children[index] });
    }
  }
  return leaves;
}

async function availableWorkspacePath(vaultPath: string, filePath: string): Promise<boolean> {
  return containedFileExists(vaultPath, filePath);
}

async function parseWorkspace(
  vaultPath: string,
  source: JsonSource,
  warnings: string[],
): Promise<WorkspaceMigrationSummary | null> {
  if (source.summary.state !== "ready") {
    return null;
  }
  try {
    if (!isRecord(source.value)) {
      throw new Error("Workspace layout must be an object.");
    }
    const leaves = collectWorkspaceLeaves(source.value);
    const candidatePaths = leaves
      .filter((leaf) => leaf.area === "main" && leaf.filePath)
      .map((leaf) => leaf.filePath as string)
      .filter((filePath, index, paths) => paths.indexOf(filePath) === index)
      .slice(0, maximumWorkspacePaths);
    const availability = await Promise.all(
      candidatePaths.map((filePath) => availableWorkspacePath(vaultPath, filePath)),
    );
    const restorablePaths = candidatePaths.filter((_path, index) => availability[index]);
    const missingPaths = candidatePaths.filter((_path, index) => !availability[index]);
    const activeLeafId = typeof source.value.active === "string" ? source.value.active : null;
    const activeCandidate = leaves.find((leaf) => leaf.id === activeLeafId)?.filePath ?? null;
    const activePath =
      activeCandidate && restorablePaths.includes(activeCandidate) ? activeCandidate : null;
    const recentFiles = Array.isArray(source.value.lastOpenFiles)
      ? source.value.lastOpenFiles.slice(0, maximumWorkspacePaths)
      : [];
    const unsupportedCounts = new Map<string, number>();
    for (const leaf of leaves) {
      if (
        leaf.area === "main" &&
        (leaf.viewType === "markdown" || leaf.viewType === "excalidraw")
      ) {
        continue;
      }
      unsupportedCounts.set(leaf.viewType, (unsupportedCounts.get(leaf.viewType) ?? 0) + 1);
    }
    if (missingPaths.length > 0) {
      warnings.push(`${missingPaths.length} workspace tab paths are not readable Markdown files.`);
    }
    if (activeCandidate && !activePath) {
      warnings.push("The active Obsidian workspace tab is not currently restorable.");
    }
    return {
      sourcePath: source.summary.path,
      leafCount: leaves.length,
      restorablePaths,
      missingPaths,
      activePath,
      recentFileCount: recentFiles.length,
      unsupportedViewTypes: [...unsupportedCounts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => left.type.localeCompare(right.type, "en-US")),
    };
  } catch (error) {
    invalidateSource(source, error);
    warnings.push(
      `Could not interpret ${path.posix.basename(source.summary.path)}: ${errorMessage(error)}`,
    );
    return null;
  }
}

function emptyWorkspace(): WorkspaceMigrationSummary {
  return {
    sourcePath: null,
    leafCount: 0,
    restorablePaths: [],
    missingPaths: [],
    activePath: null,
    recentFileCount: 0,
    unsupportedViewTypes: [],
  };
}

export async function loadObsidianMigrationPreview(
  options: ObsidianMigrationLoaderOptions,
): Promise<ObsidianMigrationPreview> {
  const sources = await Promise.all(
    sourceDefinitions.map((definition) =>
      readJsonSource(options.vaultPath, definition.path, definition.maximumBytes),
    ),
  );
  const byPath = new Map(sources.map((source) => [source.summary.path, source] as const));
  const warnings: string[] = [];
  const communitySource = byPath.get(".obsidian/community-plugins.json") as JsonSource;
  const appearanceSource = byPath.get(".obsidian/appearance.json") as JsonSource;
  const hotkeySource = byPath.get(".obsidian/hotkeys.json") as JsonSource;
  const desktopWorkspaceSource = byPath.get(".obsidian/workspace.json") as JsonSource;
  const mobileWorkspaceSource = byPath.get(".obsidian/workspace-mobile.json") as JsonSource;

  const enabledPluginIds = parseCommunityPluginIds(communitySource, warnings);
  const plugins = await buildPluginPreview(
    options.vaultPath,
    enabledPluginIds,
    options.selectedPluginIds,
    warnings,
  );
  const pluginIds = new Set(plugins.map((plugin) => plugin.id));
  const [appearance, desktopWorkspace] = await Promise.all([
    parseAppearance(options.vaultPath, appearanceSource, warnings),
    parseWorkspace(options.vaultPath, desktopWorkspaceSource, warnings),
  ]);
  const mobileWorkspace = desktopWorkspace
    ? null
    : await parseWorkspace(options.vaultPath, mobileWorkspaceSource, warnings);
  const hotkeys = parseHotkeys(hotkeySource, pluginIds, warnings);

  for (const source of sources) {
    if (source.summary.state === "invalid" || source.summary.state === "oversized") {
      warnings.push(`${source.summary.path}: ${source.summary.message ?? source.summary.state}`);
    }
  }
  return {
    vaultId: options.vaultId,
    detected: sources.some((source) => source.summary.state !== "absent") || plugins.length > 0,
    readOnly: true,
    sources: sources.map((source) => ({ ...source.summary })),
    plugins,
    hotkeys,
    appearance,
    workspace: desktopWorkspace ?? mobileWorkspace ?? emptyWorkspace(),
    warnings: [...new Set(warnings.map((warning) => oneLine(warning)).filter(Boolean))],
  };
}
