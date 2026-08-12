import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppUpdateDisabledReason } from "../shared/app-updates";

export const signedUpdateTrust = "signed-release-v1";

export function parsePackageUpdateTrust(value: unknown): typeof signedUpdateTrust | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return (value as Record<string, unknown>).threadleafUpdateTrust === signedUpdateTrust
    ? signedUpdateTrust
    : null;
}

export function readPackageUpdateTrust(appPath: string): typeof signedUpdateTrust | null {
  try {
    return parsePackageUpdateTrust(
      JSON.parse(readFileSync(join(appPath, "package.json"), "utf8")) as unknown,
    );
  } catch {
    return null;
  }
}

export function appUpdateDisabledReason(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  updateTrust: typeof signedUpdateTrust | null;
}): AppUpdateDisabledReason | null {
  if (!options.isPackaged) {
    return "development-build";
  }
  if (options.platform !== "darwin" && options.platform !== "win32") {
    return "unsupported-platform";
  }
  if (options.updateTrust !== signedUpdateTrust) {
    return "unsigned-package";
  }
  return null;
}
