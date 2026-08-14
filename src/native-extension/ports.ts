import type { VaultMutationPort } from "../kernel/ports";
import { NativeExtensionError } from "./errors";
import type { NativeNotificationPort } from "./notifications";

export {
  bindNativeNotificationPort,
  type NativeNotificationPort,
  type NativeNotificationSink,
  nativeNotificationLimits,
} from "./notifications";

export interface NativeVaultListRequest {
  vaultId: string;
  relativeDirectory?: string;
}

export interface NativeVaultReadRequest {
  vaultId: string;
  relativePath: string;
}

export interface NativeVaultWriteRequest {
  vaultId: string;
  relativePath: string;
  content: string;
  expectedRevision: string | null;
}

export interface NativeVaultTextSnapshot {
  path: string;
  content: string;
  revision: string;
  size: number;
}

export type NativeVaultWriteResult =
  | { status: "committed"; path: string; revision: string; transactionId: string }
  | {
      status: "conflict";
      path: string;
      currentRevision: string | null;
      conflictPath: string;
      transactionId?: string;
    };

/** Public storage authority. Implementations must enforce the vault identity on every call. */
export interface NativeVaultPort {
  listMarkdownPaths(request: NativeVaultListRequest): Promise<string[]>;
  readText(request: NativeVaultReadRequest): Promise<NativeVaultTextSnapshot>;
  writeText(request: NativeVaultWriteRequest): Promise<NativeVaultWriteResult>;
}

export interface NativeNetworkRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export interface NativeNetworkResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface NativeNetworkPort {
  request(request: NativeNetworkRequest, signal?: AbortSignal): Promise<NativeNetworkResponse>;
}

export interface NativeClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface NativeExternalNavigationPort {
  openExternal(url: string): Promise<void>;
}

export interface NativeEditorSelection {
  path: string;
  content: string;
  anchor: number;
  head: number;
}

export interface NativeEditorPort {
  getSelection(vaultId: string): Promise<NativeEditorSelection | null>;
  replaceSelection(vaultId: string, content: string): Promise<void>;
}

export interface NativeWorkspacePort {
  notice(message: string): Promise<void>;
  openFile(vaultId: string, relativePath: string): Promise<void>;
}

export interface NativeSubprocessRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
}

export interface NativeSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeSubprocessPort {
  run(request: NativeSubprocessRequest, signal?: AbortSignal): Promise<NativeSubprocessResult>;
}

export interface NativeSecretsPort {
  get(name: string): Promise<string | null>;
}

export interface NativeDynamicCodePort {
  evaluate(source: string, signal?: AbortSignal): Promise<unknown>;
}

export interface NativeExtensionPortSet {
  vault: NativeVaultPort;
  network?: NativeNetworkPort;
  clipboard?: NativeClipboardPort;
  navigation?: NativeExternalNavigationPort;
  editor?: NativeEditorPort;
  workspace?: NativeWorkspacePort;
  notifications?: NativeNotificationPort;
  subprocess?: NativeSubprocessPort;
  secrets?: NativeSecretsPort;
  dynamicCode?: NativeDynamicCodePort;
}

/**
 * Adapt the kernel's public recoverable vault port into the native-extension port. The adapter
 * keeps the extension API explicit about identity and rejects a different identity before the
 * kernel is called.
 */
export function bindNativeVaultPort(vaultId: string, port: VaultMutationPort): NativeVaultPort {
  const assertVault = (requestedVaultId: string): void => {
    if (requestedVaultId !== vaultId) {
      throw new NativeExtensionError(
        "cross-vault",
        "Native extension attempted to use a different vault identity.",
        { operation: "vault", vaultId: requestedVaultId },
      );
    }
  };
  return {
    listMarkdownPaths: async (request) => {
      assertVault(request.vaultId);
      return port.listMarkdownPaths(request.relativeDirectory);
    },
    readText: async (request) => {
      assertVault(request.vaultId);
      return port.readText(request.relativePath);
    },
    writeText: async (request) => {
      assertVault(request.vaultId);
      return port.writeText(request.relativePath, request.content, request.expectedRevision);
    },
  };
}
