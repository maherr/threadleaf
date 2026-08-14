import { promises as fs } from "node:fs";
import path from "node:path";
import { type NativeExtensionCapabilityId, nativeExtensionCapabilityIds } from "./manifest";

export const nativeExtensionGrantVersion = 2 as const;

export type NativeExtensionGrantDistributionTrust = "trusted-distribution" | "unsigned-development";

export interface NativeExtensionGrant {
  grantVersion: typeof nativeExtensionGrantVersion;
  vaultId: string;
  extensionId: string;
  bundleSha256: string;
  packageTreeSha256: string;
  authorityDigest: string;
  distributionTrust: NativeExtensionGrantDistributionTrust;
  metadataSha256: string | null;
  publisherId: string | null;
  publisherKeyId: string | null;
  publisherFingerprint: string | null;
  metadataIssuedAt: string | null;
  metadataExpiresAt: string | null;
  metadataRevokedAt: string | null;
  metadataDelistedAt: string | null;
  marketplaceCatalogRevision?: number | null;
  marketplaceCatalogSha256?: string | null;
  marketplaceCatalogRootFingerprint?: string | null;
  capabilities: NativeExtensionCapabilityId[];
  grantedAt: string;
  revokedAt?: string;
}

export interface NativeExtensionGrantStore {
  get(vaultId: string, extensionId: string): Promise<NativeExtensionGrant | undefined>;
  put(grant: NativeExtensionGrant): Promise<void>;
  /** Explicit user-grant replacement. Unlike `put`, this clears an old revocation marker. */
  replace?(grant: NativeExtensionGrant): Promise<void>;
  /** Atomically mark the latest grant revoked, preserving concurrent saves. */
  revoke?(grant: NativeExtensionGrant): Promise<void>;
  list(vaultId: string): Promise<NativeExtensionGrant[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validIdentifier(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function nullable(value: unknown, validator: (candidate: unknown) => boolean): boolean {
  return value === null || validator(value);
}

function parseGrant(value: unknown): NativeExtensionGrant {
  if (isRecord(value)) {
    const allowed = new Set([
      "grantVersion",
      "vaultId",
      "extensionId",
      "bundleSha256",
      "packageTreeSha256",
      "authorityDigest",
      "distributionTrust",
      "metadataSha256",
      "publisherId",
      "publisherKeyId",
      "publisherFingerprint",
      "metadataIssuedAt",
      "metadataExpiresAt",
      "metadataRevokedAt",
      "metadataDelistedAt",
      "marketplaceCatalogRevision",
      "marketplaceCatalogSha256",
      "marketplaceCatalogRootFingerprint",
      "capabilities",
      "grantedAt",
      "revokedAt",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new Error("Native extension grant contains unknown fields.");
    }
  }
  if (
    !isRecord(value) ||
    value.grantVersion !== nativeExtensionGrantVersion ||
    !validIdentifier(value.vaultId, 256) ||
    !validIdentifier(value.extensionId, 128) ||
    !validHash(value.bundleSha256) ||
    !validHash(value.packageTreeSha256) ||
    !validHash(value.authorityDigest) ||
    (value.distributionTrust !== "trusted-distribution" &&
      value.distributionTrust !== "unsigned-development") ||
    !nullable(value.metadataSha256, validHash) ||
    !nullable(value.publisherId, (candidate) => validIdentifier(candidate, 128)) ||
    !nullable(value.publisherKeyId, (candidate) => validIdentifier(candidate, 64)) ||
    !nullable(value.publisherFingerprint, validFingerprint) ||
    !nullable(value.metadataIssuedAt, validTimestamp) ||
    !nullable(value.metadataExpiresAt, validTimestamp) ||
    !nullable(value.metadataRevokedAt, validTimestamp) ||
    !nullable(value.metadataDelistedAt, validTimestamp) ||
    (value.marketplaceCatalogRevision !== undefined &&
      value.marketplaceCatalogRevision !== null &&
      (typeof value.marketplaceCatalogRevision !== "number" ||
        !Number.isSafeInteger(value.marketplaceCatalogRevision) ||
        value.marketplaceCatalogRevision < 1)) ||
    (value.marketplaceCatalogSha256 !== undefined &&
      !nullable(value.marketplaceCatalogSha256, validHash)) ||
    (value.marketplaceCatalogRootFingerprint !== undefined &&
      !nullable(value.marketplaceCatalogRootFingerprint, validFingerprint)) ||
    !Array.isArray(value.capabilities) ||
    !value.capabilities.every(
      (capability) =>
        typeof capability === "string" &&
        nativeExtensionCapabilityIds.includes(capability as NativeExtensionCapabilityId),
    ) ||
    new Set(value.capabilities).size !== value.capabilities.length ||
    !validTimestamp(value.grantedAt) ||
    (value.revokedAt !== undefined && !validTimestamp(value.revokedAt))
  ) {
    throw new Error("Native extension grant is malformed.");
  }
  const identityFields = [
    value.metadataSha256,
    value.publisherId,
    value.publisherKeyId,
    value.publisherFingerprint,
    value.metadataIssuedAt,
    value.metadataExpiresAt,
  ];
  const lifecycleFields = [value.metadataRevokedAt, value.metadataDelistedAt];
  const hasTrustMetadata = [...identityFields, ...lifecycleFields].some((field) => field !== null);
  if (
    (value.distributionTrust === "trusted-distribution" &&
      identityFields.some((field) => field === null)) ||
    (value.distributionTrust === "unsigned-development" && hasTrustMetadata)
  ) {
    throw new Error("Native extension grant trust metadata does not match its distribution mode.");
  }
  const metadataSha256 = value.metadataSha256 as string | null;
  const publisherId = value.publisherId as string | null;
  const publisherKeyId = value.publisherKeyId as string | null;
  const publisherFingerprint = value.publisherFingerprint as string | null;
  const metadataIssuedAt = value.metadataIssuedAt as string | null;
  const metadataExpiresAt = value.metadataExpiresAt as string | null;
  const metadataRevokedAt = value.metadataRevokedAt as string | null;
  const metadataDelistedAt = value.metadataDelistedAt as string | null;
  const marketplaceCatalogRevision =
    (value.marketplaceCatalogRevision as number | null | undefined) ?? null;
  const marketplaceCatalogSha256 =
    (value.marketplaceCatalogSha256 as string | null | undefined) ?? null;
  const marketplaceCatalogRootFingerprint =
    (value.marketplaceCatalogRootFingerprint as string | null | undefined) ?? null;
  // `value` comes from the grant file, so read own keys only. `in` walks the prototype chain,
  // which the rest of this module already avoids.
  const hasCatalogFields =
    Object.hasOwn(value, "marketplaceCatalogRevision") ||
    Object.hasOwn(value, "marketplaceCatalogSha256") ||
    Object.hasOwn(value, "marketplaceCatalogRootFingerprint");
  const catalogFields = [
    marketplaceCatalogRevision,
    marketplaceCatalogSha256,
    marketplaceCatalogRootFingerprint,
  ];
  if (
    (catalogFields.some((field) => field !== null) &&
      catalogFields.some((field) => field === null)) ||
    (value.distributionTrust === "unsigned-development" &&
      catalogFields.some((field) => field !== null))
  ) {
    throw new Error("Native extension grant catalog provenance is malformed.");
  }
  return {
    grantVersion: nativeExtensionGrantVersion,
    vaultId: value.vaultId,
    extensionId: value.extensionId,
    bundleSha256: value.bundleSha256,
    packageTreeSha256: value.packageTreeSha256,
    authorityDigest: value.authorityDigest,
    distributionTrust: value.distributionTrust,
    metadataSha256,
    publisherId,
    publisherKeyId,
    publisherFingerprint,
    metadataIssuedAt,
    metadataExpiresAt,
    metadataRevokedAt,
    metadataDelistedAt,
    ...(hasCatalogFields
      ? {
          marketplaceCatalogRevision,
          marketplaceCatalogSha256,
          marketplaceCatalogRootFingerprint,
        }
      : {}),
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
    const key = `${parsed.vaultId}\u0000${parsed.extensionId}`;
    const previous = this.#grants.get(key);
    this.#grants.set(key, {
      ...parsed,
      ...(previous?.revokedAt !== undefined && parsed.revokedAt === undefined
        ? { revokedAt: previous.revokedAt }
        : {}),
      capabilities: [...parsed.capabilities],
    });
  }

  async replace(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    const key = `${parsed.vaultId}\u0000${parsed.extensionId}`;
    this.#grants.set(key, {
      ...parsed,
      capabilities: [...parsed.capabilities],
    });
  }

  async revoke(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    const key = `${parsed.vaultId}\u0000${parsed.extensionId}`;
    const previous = this.#grants.get(key);
    const revokedAt = previous?.revokedAt ?? parsed.revokedAt;
    this.#grants.set(key, {
      ...(previous ?? parsed),
      ...(revokedAt === undefined ? {} : { revokedAt }),
      capabilities: [...(previous?.capabilities ?? parsed.capabilities)],
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
    const vaultGrants = Object.hasOwn(file.grants, vaultId) ? file.grants[vaultId] : undefined;
    const grant =
      vaultGrants && Object.hasOwn(vaultGrants, extensionId) ? vaultGrants[extensionId] : undefined;
    return grant === undefined ? undefined : { ...grant, capabilities: [...grant.capabilities] };
  }

  async list(vaultId: string): Promise<NativeExtensionGrant[]> {
    const file = await this.readFile();
    const grants = Object.hasOwn(file.grants, vaultId) ? file.grants[vaultId] : undefined;
    if (!grants) return [];
    return Object.values(grants).map((grant) => ({
      ...grant,
      capabilities: [...grant.capabilities],
    }));
  }

  async put(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    const write = this.#writeTail.then(async () => {
      await withGrantFileLock(this.#filePath, async () => {
        const file = await this.readFile();
        const vaultGrants = Object.hasOwn(file.grants, parsed.vaultId)
          ? file.grants[parsed.vaultId]
          : Object.create(null);
        const previous = Object.hasOwn(vaultGrants, parsed.extensionId)
          ? vaultGrants[parsed.extensionId]
          : undefined;
        vaultGrants[parsed.extensionId] = {
          ...parsed,
          ...(previous?.revokedAt !== undefined && parsed.revokedAt === undefined
            ? { revokedAt: previous.revokedAt }
            : {}),
          capabilities: [...parsed.capabilities],
        };
        file.grants[parsed.vaultId] = vaultGrants;
        await this.writeFile(file);
      });
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  async replace(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    const write = this.#writeTail.then(async () => {
      await withGrantFileLock(this.#filePath, async () => {
        const file = await this.readFile();
        const vaultGrants = Object.hasOwn(file.grants, parsed.vaultId)
          ? file.grants[parsed.vaultId]
          : Object.create(null);
        vaultGrants[parsed.extensionId] = {
          ...parsed,
          capabilities: [...parsed.capabilities],
        };
        file.grants[parsed.vaultId] = vaultGrants;
        await this.writeFile(file);
      });
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  async revoke(grant: NativeExtensionGrant): Promise<void> {
    const parsed = parseGrant(grant);
    const write = this.#writeTail.then(async () => {
      await withGrantFileLock(this.#filePath, async () => {
        const file = await this.readFile();
        const vaultGrants = Object.hasOwn(file.grants, parsed.vaultId)
          ? file.grants[parsed.vaultId]
          : Object.create(null);
        const previous = Object.hasOwn(vaultGrants, parsed.extensionId)
          ? vaultGrants[parsed.extensionId]
          : undefined;
        const revokedAt = previous?.revokedAt ?? parsed.revokedAt;
        vaultGrants[parsed.extensionId] = {
          ...(previous ?? parsed),
          ...(revokedAt === undefined ? {} : { revokedAt }),
          capabilities: [...(previous?.capabilities ?? parsed.capabilities)],
        };
        file.grants[parsed.vaultId] = vaultGrants;
        await this.writeFile(file);
      });
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
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
    if (Object.keys(value).some((key) => key !== "version" && key !== "grants")) {
      throw new Error("Native extension grant store contains unknown fields.");
    }
    const grants: Record<string, Record<string, NativeExtensionGrant>> = Object.create(null);
    for (const [vaultId, rawVaultGrants] of Object.entries(value.grants)) {
      if (!isRecord(rawVaultGrants)) {
        throw new Error("Native extension grant store has malformed vault entries.");
      }
      const vaultGrants: Record<string, NativeExtensionGrant> = Object.create(null);
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

async function withGrantFileLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  if (!handle) throw new Error("Native extension grant store lock timed out.");
  try {
    return await action();
  } finally {
    await handle.close();
    try {
      await fs.unlink(lockPath);
    } catch {
      // The lock is advisory and the atomic store write has already completed.
    }
  }
}
