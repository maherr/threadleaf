export const trustedWorkspaceProbeArgument = "--threadleaf-trusted-workspace-probe";

export function trustedWorkspaceProbeEnabled(
  isPackaged: boolean,
  environment: NodeJS.ProcessEnv,
): boolean {
  return !isPackaged && environment.THREADLEAF_TRUSTED_WORKSPACE_TEST === "1";
}
