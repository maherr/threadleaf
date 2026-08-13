import { isAbsolute, resolve } from "node:path";
import { canonicalizePotentialPath, isPathInside } from "../kernel/path-policy";
import type { AppUpdateSnapshot } from "../shared/app-updates";
import type { PluginRuntimeState, RuntimeEventKind, RuntimeSnapshot } from "../shared/contracts";
import {
  type AppSettingsSnapshot,
  appearanceForVault,
  defaultKeyBindings,
  pluginsForVault,
  type ShortcutTargetId,
} from "../shared/key-bindings";

export interface SupportBundleEnvironment {
  appVersion: string;
  architecture: string;
  chromiumVersion: string;
  electronVersion: string;
  nodeVersion: string;
  osRelease: string;
  packaged: boolean;
  platform: string;
  updateTrust: "signed-release-v1" | "none";
}

export interface SupportBundleInput {
  appearanceSafeMode: boolean;
  environment: SupportBundleEnvironment;
  generatedAt: string;
  pluginSafeMode: boolean;
  runtime: RuntimeSnapshot;
  settings: AppSettingsSnapshot;
  update: AppUpdateSnapshot;
}

export function readDevelopmentSupportBundlePath(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (isPackaged) {
    return undefined;
  }
  const configuredPath = environment.THREADLEAF_SUPPORT_BUNDLE_PATH?.trim();
  if (!configuredPath) {
    return undefined;
  }
  if (!isAbsolute(configuredPath)) {
    throw new Error("The development support bundle path must be absolute.");
  }
  return resolve(configuredPath);
}

export async function isSupportBundleTargetOutsideVault(
  vaultPath: string,
  targetPath: string,
): Promise<boolean> {
  const [canonicalVaultPath, canonicalTargetPath] = await Promise.all([
    canonicalizePotentialPath(vaultPath),
    canonicalizePotentialPath(targetPath),
  ]);
  return !isPathInside(canonicalVaultPath, canonicalTargetPath);
}

const privacyExclusions = [
  "note and attachment contents",
  "note, attachment, vault, and save paths",
  "vault names and identifiers",
  "file, bundle, and revision hashes",
  "plugin IDs, names, settings, errors, and code",
  "theme and snippet IDs",
  "runtime notice, event, and error messages",
  "hostnames, usernames, home directories, network addresses, and locale",
] as const;

function countBy<T extends string>(values: readonly T[], keys: readonly T[]): Record<T, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) {
    result[value] += 1;
  }
  return result;
}

function customBindingCount(settings: AppSettingsSnapshot): number {
  return Object.entries(settings.settings.keyBindings).filter(([targetId, binding]) => {
    const knownTarget = Object.hasOwn(defaultKeyBindings, targetId);
    const defaultBinding = knownTarget
      ? defaultKeyBindings[targetId as ShortcutTargetId]
      : undefined;
    return !knownTarget || binding !== defaultBinding;
  }).length;
}

function resourceDiagnosticsForSupport(runtime: RuntimeSnapshot) {
  return (runtime.resourceDiagnostics ?? []).map(
    ({ pluginId: _pluginId, ...diagnostic }) => diagnostic,
  );
}

export function createSupportBundleData(input: SupportBundleInput) {
  const { runtime, settings } = input;
  const plugins = runtime.plugins ?? (runtime.plugin ? [runtime.plugin] : []);
  const pluginStates = countBy(
    plugins.map((plugin) => plugin.state),
    ["empty", "loaded", "unloaded", "failed"] satisfies readonly PluginRuntimeState[],
  );
  const compatibilityLevels = countBy(
    plugins.map((plugin) => String(plugin.compatibilityLevel)),
    ["0", "1", "2", "3", "4"] as const,
  );
  const eventKinds = countBy(
    runtime.events.map((event) => event.kind),
    ["runtime", "plugin", "command", "notice", "error"] satisfies readonly RuntimeEventKind[],
  );
  const vaultId = runtime.vault.id;
  const appearance = vaultId
    ? appearanceForVault(settings.settings, vaultId)
    : { colorScheme: "system" as const, themeId: null, enabledSnippetIds: [] };
  const pluginPreferences = vaultId
    ? pluginsForVault(settings.settings, vaultId)
    : {
        compatibilityMode: "restricted" as const,
        enabledPluginIds: [],
        capabilityGrantsByPlugin: {},
      };
  const workspace = runtime.workspace;
  const integrations = runtime.integrations;

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    privacy: {
      aggregateOnly: true,
      excluded: [...privacyExclusions],
    },
    application: {
      version: input.environment.appVersion,
      packaged: input.environment.packaged,
      updateTrust: input.environment.updateTrust,
      platform: input.environment.platform,
      architecture: input.environment.architecture,
      osRelease: input.environment.osRelease,
      runtimes: {
        electron: input.environment.electronVersion,
        chromium: input.environment.chromiumVersion,
        node: input.environment.nodeVersion,
      },
    },
    vault: {
      mode: runtime.vault.mode,
      source: runtime.vault.source,
      opening: runtime.startup?.phase === "opening",
      noteCount: runtime.vault.markdownFileCount,
      workspaceState: workspace?.state ?? "opening",
      openTabCount: workspace?.tabs.length ?? 0,
      activeNoteOpen: workspace?.activeNote !== null && workspace?.activeNote !== undefined,
      recoveryActionCount: workspace?.recoveryActionCount ?? 0,
      indexGeneration: workspace?.indexGeneration ?? 0,
      watcher: {
        sequence: workspace?.watcher.lastSequence ?? 0,
        rescanObserved: workspace?.watcher.lastRescanReason !== null && workspace !== undefined,
        errorObserved: workspace?.watcher.error !== null && workspace !== undefined,
      },
    },
    plugins: {
      safeMode: input.pluginSafeMode,
      runtimeCount: plugins.length,
      states: pluginStates,
      compatibilityLevels,
      commandCount: runtime.commands.length,
      integrations: {
        editorSuggests: integrations?.editorSuggests ?? 0,
        editorExtensions: integrations?.extensions.length ?? 0,
        markdownPostProcessors: integrations?.markdownPostProcessors ?? 0,
        ribbonItems: integrations?.ribbonItems ?? 0,
        settingTabs: integrations?.settingTabs ?? 0,
        statusBarItems: integrations?.statusBarItems ?? 0,
        viewTypes: integrations?.viewTypes.length ?? 0,
      },
      surfaceOpen: runtime.pluginSurface !== null && runtime.pluginSurface !== undefined,
      resourcePolicy: {
        version: runtime.resourcePolicy?.version ?? null,
        state: runtime.resourcePolicy?.state ?? "unavailable",
        operationDeadlinesMs: runtime.resourcePolicy?.operationDeadlinesMs ?? null,
        memoryCeilingBytes: runtime.resourcePolicy?.memoryCeilingBytes ?? null,
        cpuBudgetPercent: runtime.resourcePolicy?.cpuBudgetPercent ?? null,
        cpuSampleIntervalMs: runtime.resourcePolicy?.cpuSampleIntervalMs ?? null,
        cpuStartupQuietWindowMs: runtime.resourcePolicy?.cpuStartupQuietWindowMs ?? null,
        cpuConsecutiveSamples: runtime.resourcePolicy?.cpuConsecutiveSamples ?? null,
        metrics: {
          sampledAt: runtime.resourcePolicy?.metrics.sampledAt ?? null,
          memoryAvailable: runtime.resourcePolicy?.metrics.memoryAvailable ?? false,
          cpuAvailable: runtime.resourcePolicy?.metrics.cpuAvailable ?? false,
        },
        diagnostics: resourceDiagnosticsForSupport(runtime),
      },
    },
    appearance: {
      safeMode: input.appearanceSafeMode,
      colorScheme: appearance.colorScheme,
      customThemeSelected: appearance.themeId !== null,
      enabledSnippetCount: appearance.enabledSnippetIds.length,
    },
    preferences: {
      schemaVersion: settings.settings.version,
      warningObserved: settings.warning !== null,
      customBindingCount: customBindingCount(settings),
      savedAppearanceVaultCount: Object.keys(settings.settings.appearanceByVault).length,
      savedPluginVaultCount: Object.keys(settings.settings.pluginsByVault).length,
      savedNoteWorkflowVaultCount: Object.keys(settings.settings.noteWorkflowsByVault).length,
      currentPluginMode: pluginPreferences.compatibilityMode,
      enabledPluginCount: pluginPreferences.enabledPluginIds.length,
      pluginGrantCount: Object.keys(pluginPreferences.capabilityGrantsByPlugin).length,
    },
    runtimeSignals: {
      actions: runtime.actions.length,
      notices: runtime.notices.length,
      events: eventKinds,
    },
    updates: {
      phase: input.update.phase,
      disabledReason: input.update.disabledReason,
      canCheck: input.update.canCheck,
      canDownload: input.update.canDownload,
      canInstall: input.update.canInstall,
    },
  } as const;
}

export function createSupportBundleMarkdown(input: SupportBundleInput): string {
  const diagnostics = createSupportBundleData(input);
  return `# Threadleaf beta support bundle

Generated: ${input.generatedAt}

## Privacy boundary

This file is aggregate-only. It intentionally excludes note text, filenames, vault paths and
identifiers, hashes, plugin identities and settings, raw errors, usernames, hostnames, and network
addresses. Review optional screenshots separately because they can contain note text.

## Feedback

- Report type: bug / improvement
- Summary:
- What happened:
- What you expected:
- Steps to reproduce:
  1.
- Frequency: once / sometimes / every time
- Data safety: no unexpected file change / unexpected change / unsure
- Reproduces with plugin safe mode: yes / no / not tested
- Reproduces with appearance safe mode: yes / no / not tested
- Affected plugin and version, only if relevant:
- Anything else:

## Aggregate diagnostics

\`\`\`json
${JSON.stringify(diagnostics, null, 2)}
\`\`\`
`;
}
