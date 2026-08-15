import { createHash } from "node:crypto";
import {
  maxPluginBundleBytes,
  type PluginManifestData,
  parsePluginId,
  parsePluginManifest,
} from "../shared/plugins";

const registryUrl =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const maxRegistryBytes = 8 * 1024 * 1024;
const maxManifestBytes = 64 * 1024;
const maxStylesheetBytes = 2 * 1024 * 1024;
const maxLicenseBytes = 2 * 1024 * 1024;
const maxRegistryEntries = 10_000;
const requestTimeoutMs = 15_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
const repositoryPattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

export interface OpenPluginIndexEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  repository: string;
}

export interface OpenPluginIndex {
  entries: OpenPluginIndexEntry[];
  sha256: string;
  sourceUrl: string;
}

export interface OpenPluginPackageAsset {
  filename: "manifest.json" | "main.js" | "styles.css";
  bytes: Buffer;
  sha256: string;
}

export interface OpenPluginPackageLicense {
  bytes: Buffer;
  name: string;
  sourceUrl: string;
  spdxId: string;
  sha256: string;
}

export interface OpenPluginPackage {
  assets: OpenPluginPackageAsset[];
  indexSha256: string;
  indexUrl: string;
  license: OpenPluginPackageLicense;
  manifest: PluginManifestData;
  releaseUrl: string;
  repository: string;
  warnings: string[];
}

export interface PluginPackageSource {
  getIndex(): Promise<OpenPluginIndex>;
  getPackage(pluginId: string, version?: string): Promise<OpenPluginPackage>;
}

type FetchImplementation = typeof fetch;

interface GitHubContentsResponse {
  content: string;
  encoding: string;
}

interface GitHubLicenseResponse extends GitHubContentsResponse {
  html_url: string;
  license: {
    name: string;
    spdx_id: string | null;
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredIndexText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`Community package index entry requires ${field}.`);
  }
  const normalized = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Community package index entry has an invalid ${field}.`);
  }
  return normalized;
}

function optionalIndexText(
  value: unknown,
  field: string,
  maxLength: number,
  fallback: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`Community package index entry requires ${field}.`);
  }
  const normalized = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length > maxLength) {
    throw new Error(`Community package index entry has an invalid ${field}.`);
  }
  return normalized || fallback;
}

function parseRepository(value: unknown): string {
  const repository = requiredIndexText(value, "repo", 201);
  if (!repositoryPattern.test(repository)) {
    throw new Error("Community package index repository must be a GitHub owner/repository pair.");
  }
  return repository;
}

function parseVersion(value: unknown): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error("Plugin package version is not safe for an exact release lookup.");
  }
  return value;
}

function parseGitHubContents(value: unknown): GitHubContentsResponse {
  if (!isRecord(value) || typeof value.content !== "string" || value.encoding !== "base64") {
    throw new Error("GitHub returned an invalid repository file response.");
  }
  return { content: value.content, encoding: value.encoding };
}

function parseGitHubLicense(value: unknown): GitHubLicenseResponse {
  const contents = parseGitHubContents(value);
  if (
    !isRecord(value) ||
    typeof value.html_url !== "string" ||
    !isRecord(value.license) ||
    typeof value.license.name !== "string" ||
    (value.license.spdx_id !== null && typeof value.license.spdx_id !== "string")
  ) {
    throw new Error("GitHub returned an invalid license response.");
  }
  return {
    ...contents,
    html_url: value.html_url,
    license: { name: value.license.name, spdx_id: value.license.spdx_id },
  };
}

function decodeBase64(value: string, maxBytes: number, label: string): Buffer {
  const normalized = value.replace(/\s+/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new Error(`${label} is not canonical base64.`);
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.toString("base64") !== normalized) {
    throw new Error(`${label} is not canonical base64.`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new Error(`${label} is empty or exceeds its ${formatBytes(maxBytes)} limit.`);
  }
  return bytes;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.floor(bytes / 1024)} KiB` : `${bytes / 1024 / 1024} MiB`;
}

function allowedFinalHost(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "github.com" ||
      url.hostname === "api.github.com" ||
      url.hostname === "raw.githubusercontent.com" ||
      url.hostname.endsWith(".githubusercontent.com"))
  );
}

function requestHeaders(url: string, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept, "User-Agent": "Threadleaf" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && new URL(url).host === "api.github.com") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function responseBytes(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes) {
    throw new Error(`${label} exceeds its ${formatBytes(maxBytes)} limit.`);
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${label} exceeds its ${formatBytes(maxBytes)} limit.`);
    }
    return bytes;
  }
  const chunks: Buffer[] = [];
  const reader = response.body.getReader();
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds its ${formatBytes(maxBytes)} limit.`);
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, size);
}

export class OpenPluginPackageSource implements PluginPackageSource {
  readonly #fetch: FetchImplementation;
  #cachedIndex: { expiresAt: number; value: OpenPluginIndex } | null = null;

  constructor(fetchImplementation: FetchImplementation = fetch) {
    this.#fetch = fetchImplementation;
  }

  async getIndex(): Promise<OpenPluginIndex> {
    if (this.#cachedIndex && this.#cachedIndex.expiresAt > Date.now()) {
      return this.#cachedIndex.value;
    }
    const bytes = await this.#request(registryUrl, maxRegistryBytes, "community package index");
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(parsed) || parsed.length > maxRegistryEntries) {
      throw new Error("Community package index must be a bounded array.");
    }
    const entries = parsed.map((value): OpenPluginIndexEntry => {
      if (!isRecord(value)) {
        throw new Error("Community package index contains a non-object entry.");
      }
      return {
        id: parsePluginId(value.id),
        name: requiredIndexText(value.name, "name", 200),
        author: optionalIndexText(value.author, "author", 200, "Unknown author"),
        description: requiredIndexText(value.description, "description", 2_000),
        repository: parseRepository(value.repo),
      };
    });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      throw new Error("Community package index contains duplicate plugin identifiers.");
    }
    const value = { entries, sha256: sha256(bytes), sourceUrl: registryUrl };
    this.#cachedIndex = { expiresAt: Date.now() + 5 * 60_000, value };
    return value;
  }

  async getPackage(pluginIdValue: string, requestedVersion?: string): Promise<OpenPluginPackage> {
    const pluginId = parsePluginId(pluginIdValue);
    const index = await this.getIndex();
    const entry = index.entries.find((candidate) => candidate.id === pluginId);
    if (!entry) {
      throw new Error(`Plugin ${pluginId} is not present in the community package index.`);
    }
    const version = requestedVersion
      ? parseVersion(requestedVersion)
      : await this.#latestVersion(entry.repository, pluginId);
    const releaseRoot = `https://github.com/${entry.repository}/releases/download/${encodeURIComponent(version)}`;
    const manifestBytes = await this.#request(
      `${releaseRoot}/manifest.json`,
      maxManifestBytes,
      `${pluginId} manifest.json`,
    );
    const manifest = parsePluginManifest(JSON.parse(decoder.decode(manifestBytes)));
    if (manifest.id !== pluginId) {
      throw new Error(`Release manifest id ${manifest.id} does not match indexed id ${pluginId}.`);
    }
    if (manifest.version !== version) {
      throw new Error(
        `Release manifest version ${manifest.version} does not match exact tag ${version}.`,
      );
    }
    const mainBytes = await this.#request(
      `${releaseRoot}/main.js`,
      maxPluginBundleBytes,
      `${pluginId} main.js`,
    );
    decoder.decode(mainBytes);
    const stylesBytes = await this.#requestOptional(
      `${releaseRoot}/styles.css`,
      maxStylesheetBytes,
      `${pluginId} styles.css`,
    );
    if (stylesBytes) {
      decoder.decode(stylesBytes);
    }
    const license = await this.#license(entry.repository, version);
    const assets: OpenPluginPackageAsset[] = [
      { filename: "manifest.json", bytes: manifestBytes, sha256: sha256(manifestBytes) },
      { filename: "main.js", bytes: mainBytes, sha256: sha256(mainBytes) },
    ];
    if (stylesBytes) {
      assets.push({ filename: "styles.css", bytes: stylesBytes, sha256: sha256(stylesBytes) });
    }
    const warnings =
      license.spdxId === "NOASSERTION" || license.spdxId === "UNKNOWN"
        ? ["The release includes license text, but GitHub did not identify an SPDX license."]
        : [];
    return {
      assets,
      indexSha256: index.sha256,
      indexUrl: index.sourceUrl,
      license,
      manifest,
      releaseUrl: `https://github.com/${entry.repository}/releases/tag/${encodeURIComponent(version)}`,
      repository: entry.repository,
      warnings,
    };
  }

  async #latestVersion(repository: string, pluginId: string): Promise<string> {
    const bytes = await this.#request(
      `https://api.github.com/repos/${repository}/contents/manifest.json`,
      maxManifestBytes * 2,
      `${pluginId} repository manifest`,
      "application/vnd.github+json",
    );
    const contents = parseGitHubContents(JSON.parse(decoder.decode(bytes)));
    const manifestBytes = decodeBase64(contents.content, maxManifestBytes, `${pluginId} manifest`);
    const manifest = parsePluginManifest(JSON.parse(decoder.decode(manifestBytes)));
    if (manifest.id !== pluginId) {
      throw new Error(
        `Repository manifest id ${manifest.id} does not match indexed id ${pluginId}.`,
      );
    }
    return parseVersion(manifest.version);
  }

  async #license(repository: string, version: string): Promise<OpenPluginPackageLicense> {
    const bytes = await this.#request(
      `https://api.github.com/repos/${repository}/license?ref=${encodeURIComponent(version)}`,
      maxLicenseBytes * 2,
      `${repository} license metadata`,
      "application/vnd.github+json",
    );
    const response = parseGitHubLicense(JSON.parse(decoder.decode(bytes)));
    const licenseBytes = decodeBase64(response.content, maxLicenseBytes, `${repository} license`);
    decoder.decode(licenseBytes);
    return {
      bytes: licenseBytes,
      name: response.license.name.trim() || "Unidentified license",
      sourceUrl: response.html_url,
      spdxId: response.license.spdx_id?.trim() || "UNKNOWN",
      sha256: sha256(licenseBytes),
    };
  }

  async #request(
    url: string,
    maxBytes: number,
    label: string,
    accept = "application/octet-stream",
  ): Promise<Buffer> {
    const response = await this.#fetch(url, {
      headers: requestHeaders(url, accept),
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${label} download failed with HTTP ${response.status}.`);
    }
    if (!allowedFinalHost(new URL(response.url || url))) {
      throw new Error(`${label} redirected outside the allowed GitHub hosts.`);
    }
    return responseBytes(response, maxBytes, label);
  }

  async #requestOptional(url: string, maxBytes: number, label: string): Promise<Buffer | null> {
    const response = await this.#fetch(url, {
      headers: requestHeaders(url, "application/octet-stream"),
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`${label} download failed with HTTP ${response.status}.`);
    }
    if (!allowedFinalHost(new URL(response.url || url))) {
      throw new Error(`${label} redirected outside the allowed GitHub hosts.`);
    }
    return responseBytes(response, maxBytes, label);
  }
}
