import { promises as fs } from "node:fs";
import path from "node:path";
import { type NativeExtensionCapabilityId, nativeExtensionCapabilityIds } from "./manifest";

export const nativeExtensionGrantVersion = 1 as const;

export interface NativeExtensionGrant {
  grantVersion: typeof nativeExtensionGrantVersion;
  vaultId: string;
  extensionId: string;
  bundleSha256: string;
  authorityDigest: string;
  capabilities: NativeExtensionCapabilityId[];
  grantedAt: string;
  revokedAt?: string;
}

export interface NativeExtensionGrantStore {
  get(vaultId: string, extensionId: string): Promise<NativeExtensionGrant | undefined>;
  put(grant: NativeExtensionGrant): Promise<void>;
  list(vaultId: string): Promise<NativeExtensionGrant[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function parseGrant(value: unknown): NativeExtensionGrant {
  if (
    !isRecord(value) ||
    value.grantVersion !== nativeExtensionGrantVersion ||
    typeof value.vaultId !== "string" ||
    typeof value.extensionId !== "string" ||
    !validHash(value.bundleSha256) ||
    !validHash(value.authorityDigest) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        nativeExtensionCapabilityIds.includes(capability as NativeExtensionCapabilityId),
    ) ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    typeof value.grantedAt !== "string" ||
    (value.revokedAt !== undefined && typeof value.revokedAt !== "string")
  ) {
    throw new Error("Native extension grant is malformed.");
  }
  return {
    grantVersion: nativeExtensionGrantVersion,
    vaultId: value.vaultId,
    extensionId: value.extensionId,
    bundleSha256: value.bundleSha256,
    authorityDigest: value.authorityDigest,
    capabilities: [...(value.capabilities as NativeExtensionCapabilityId[])],
    grantedAt: value.grantedAt,
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
  };
}

export function parseNativeExtensionGrant(value: unknown): NativeExtensionGrant {
  return parseGrant(value);
}

export class InMemoryNativeExtensionGrantStore implements NativeExtensionGrantStore {
  readonly #grants = new Map<string, NativeExtensionGrant>();

  async get(vaultId: string, extensionId: string): Promise<NativeExtensionGrant | undefined> {
    const grant = this.#grants.get(`${vaultId}\u0000${extensionId}`);
    return grant === undefined ? undefined : { ...grant, capabilities: [...grant.capabilities] };
  }

  async put(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    this.#grants.set(`${parsed.vaultId}\u0000${parsed.extensionId}`, {
      ...parsed,
      capabilities: [...parsed.capabilities],
    });
  }

  async list(vaultId: string): Promise<NativeExtensionGrant[]> {
    return [...this.#grants.values()]
      .filter((grant) => grant.vaultId === vaultId)
      .map((grant) => ({ ...grant, capabilities: [...grant.capabilities] }));
  }
}

interface NativeExtensionGrantFile {
  version: typeof nativeExtensionGrantVersion;
  grants: Record<string, Record<string, NativeExtensionGrant>>;
}

/**
 * Private application-data store. The caller must place `filePath` outside all vaults; this
 * class never writes a grant into a vault or `.obsidian/`.
 */
export class FileNativeExtensionGrantStore implements NativeExtensionGrantStore {
  readonly #filePath: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  async get(vaultId: string, extensionId: string): Promise<NativeExtensionGrant | undefined> {
    const file = await this.readFile();
    const grant = file.grants[vaultId]?.[extensionId];
    return grant === undefined ? undefined : { ...grant, capabilities: [...grant.capabilities] };
  }

  async list(vaultId: string): Promise<NativeExtensionGrant[]> {
    const grants = (await this.readFile()).grants[vaultId] ?? {};
    return Object.values(grants).map((grant) => ({
      ...grant,
      capabilities: [...grant.capabilities],
    }));
  }

  async put(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    this.#writeTail = this.#writeTail.then(async () => {
      const file = await this.readFile();
      const vaultGrants = file.grants[parsed.vaultId] ?? {};
      vaultGrants[parsed.extensionId] = { ...parsed, capabilities: [...parsed.capabilities] };
      file.grants[parsed.vaultId] = vaultGrants;
      await this.writeFile(file);
    });
    await this.#writeTail;
  }

  private async readFile(): Promise<NativeExtensionGrantFile> {
    let bytes: string;
    try {
      bytes = await fs.readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: nativeExtensionGrantVersion, grants: {} };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      throw new Error("Native extension grant store is not valid JSON.");
    }
    if (
      !isRecord(value) ||
      value.version !== nativeExtensionGrantVersion ||
      !isRecord(value.grants)
    ) {
      throw new Error("Native extension grant store has an unsupported shape.");
    }
    const grants: Record<string, Record<string, NativeExtensionGrant>> = {};
    for (const [vaultId, rawVaultGrants] of Object.entries(value.grants)) {
      if (!isRecord(rawVaultGrants)) {
        throw new Error("Native extension grant store has malformed vault entries.");
      }
      const vaultGrants: Record<string, NativeExtensionGrant> = {};
      for (const [extensionId, rawGrant] of Object.entries(rawVaultGrants)) {
        const grant = parseGrant(rawGrant);
        if (grant.vaultId !== vaultId || grant.extensionId !== extensionId) {
          throw new Error("Native extension grant store identity does not match its key.");
        }
        vaultGrants[extensionId] = grant;
      }
      grants[vaultId] = vaultGrants;
    }
    return { version: nativeExtensionGrantVersion, grants };
  }

  private async writeFile(file: NativeExtensionGrantFile): Promise<void> {
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    const bytes = `${JSON.stringify(file, null, 2)}\n`;
    await fs.writeFile(temporaryPath, bytes, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, this.#filePath);
    await fs.chmod(this.#filePath, 0o600);
  }
}
