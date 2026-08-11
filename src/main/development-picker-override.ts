import { resolve } from "node:path";

export type DevelopmentPickerOverride =
  | { status: "cancelled" }
  | { status: "selected"; path: string };

export function readDevelopmentVaultPath(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (isPackaged) {
    return undefined;
  }
  const configuredPath = environment.THREADLEAF_VAULT_PATH?.trim();
  return configuredPath ? resolve(configuredPath) : undefined;
}

export function readDevelopmentPickerOverride(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv,
): DevelopmentPickerOverride | null {
  if (isPackaged) {
    return null;
  }
  if (environment.THREADLEAF_TEST_PICKER_CANCEL === "1") {
    return { status: "cancelled" };
  }
  const configuredPath = environment.THREADLEAF_TEST_PICKER_PATH?.trim();
  return configuredPath ? { status: "selected", path: resolve(configuredPath) } : null;
}
