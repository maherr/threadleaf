import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenPluginPackageSource } from "./open-plugin-package-source";

const registryUrl =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json";
const repository = "fixture-owner/fixture-plugin";
const releaseRoot = `https://github.com/${repository}/releases/download/1.2.3`;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(value: string, status = 200): Response {
  return new Response(value, { status });
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function manifest(version = "1.2.3"): Record<string, unknown> {
  return {
    id: "fixture-plugin",
    name: "Fixture Plugin",
    version,
    minAppVersion: "1.0.0",
    description: "Fixture package",
    author: "Fixture author",
    isDesktopOnly: false,
  };
}

function sourceFetch(
  options: {
    styles?: boolean;
    manifestVersion?: string;
    licenseStatus?: number;
    malformedLicense?: boolean;
    blockedFinalHost?: boolean;
  } = {},
) {
  const manifestText = JSON.stringify(manifest(options.manifestVersion));
  return vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url === registryUrl) {
      const response = jsonResponse([
        {
          id: "fixture-plugin",
          name: "Fixture Plugin",
          author: "Fixture author",
          description: "Fixture package",
          repo: repository,
        },
        {
          id: "scrybble.ink",
          name: "Scrybble",
          author: "",
          description: "Official identifiers may contain dots.",
          repo: "fixture-owner/scrybble",
        },
      ]);
      if (options.blockedFinalHost) {
        Object.defineProperty(response, "url", {
          value: "https://packages.example.test/index.json",
        });
      }
      return response;
    }
    if (url === `https://api.github.com/repos/${repository}/contents/manifest.json`) {
      return jsonResponse({ content: base64(manifestText), encoding: "base64" });
    }
    if (url === `${releaseRoot}/manifest.json`) {
      return bytesResponse(manifestText);
    }
    if (url === `${releaseRoot}/main.js`) {
      return bytesResponse("module.exports = class Fixture {};");
    }
    if (url === `${releaseRoot}/styles.css`) {
      return options.styles ? bytesResponse(".fixture { color: blue; }") : bytesResponse("", 404);
    }
    if (url === `https://api.github.com/repos/${repository}/license?ref=1.2.3`) {
      if (options.licenseStatus) {
        return jsonResponse({}, options.licenseStatus);
      }
      return jsonResponse({
        content: options.malformedLicense
          ? "not canonical base64==="
          : base64("MIT License\n\nPermission is hereby granted."),
        encoding: "base64",
        html_url: `https://github.com/${repository}/blob/1.2.3/LICENSE`,
        license: { name: "MIT License", spdx_id: "MIT" },
      });
    }
    return bytesResponse("", 404);
  });
}

function recordedRequests(fetchImplementation: ReturnType<typeof sourceFetch>) {
  return fetchImplementation.mock.calls as unknown as Array<
    [input: string | URL | Request, init: RequestInit | undefined]
  >;
}

function authorization(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("Authorization");
}

describe("open plugin package source", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads and caches the public index while accepting real-world plugin identifiers", async () => {
    const fetchImplementation = sourceFetch();
    const source = new OpenPluginPackageSource(fetchImplementation as typeof fetch);

    const first = await source.getIndex();
    const second = await source.getIndex();

    expect(first.entries.map((entry) => entry.id)).toEqual(["fixture-plugin", "scrybble.ink"]);
    expect(first.entries[1]?.author).toBe("Unknown author");
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toBe(first);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("resolves the latest exact release and retains version-specific license evidence", async () => {
    const fetchImplementation = sourceFetch({ styles: true });
    const source = new OpenPluginPackageSource(fetchImplementation as typeof fetch);

    const pkg = await source.getPackage("fixture-plugin");

    expect(pkg.manifest.version).toBe("1.2.3");
    expect(pkg.assets.map((asset) => asset.filename)).toEqual([
      "manifest.json",
      "main.js",
      "styles.css",
    ]);
    expect(pkg.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256))).toBe(true);
    expect(pkg.license).toMatchObject({ name: "MIT License", spdxId: "MIT" });
    expect(pkg.license.bytes.toString("utf8")).toContain("Permission is hereby granted");
    expect(fetchImplementation).toHaveBeenCalledWith(
      `https://api.github.com/repos/${repository}/license?ref=1.2.3`,
      expect.any(Object),
    );
  });

  it("sends the preferred GitHub token only to exact api.github.com requests", async () => {
    vi.stubEnv("GITHUB_TOKEN", "preferred-token");
    vi.stubEnv("GH_TOKEN", "fallback-token");
    const fetchImplementation = sourceFetch({ styles: true });
    const source = new OpenPluginPackageSource(fetchImplementation as typeof fetch);

    await source.getPackage("fixture-plugin");

    const requests = recordedRequests(fetchImplementation);
    const apiRequests = requests.filter(
      ([input]) => new URL(String(input)).host === "api.github.com",
    );
    const nonApiRequests = requests.filter(
      ([input]) => new URL(String(input)).host !== "api.github.com",
    );
    expect(apiRequests).toHaveLength(2);
    expect(nonApiRequests.length).toBeGreaterThan(0);
    for (const [, init] of apiRequests) {
      expect(authorization(init)).toBe("Bearer preferred-token");
    }
    for (const [, init] of nonApiRequests) {
      expect(authorization(init)).toBeNull();
    }
  });

  it("falls back to GH_TOKEN for GitHub API requests", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "fallback-token");
    const fetchImplementation = sourceFetch();
    const source = new OpenPluginPackageSource(fetchImplementation as typeof fetch);

    await source.getPackage("fixture-plugin");

    const apiRequests = recordedRequests(fetchImplementation).filter(
      ([input]) => new URL(String(input)).host === "api.github.com",
    );
    expect(apiRequests).toHaveLength(2);
    for (const [, init] of apiRequests) {
      expect(authorization(init)).toBe("Bearer fallback-token");
    }
  });

  it("leaves GitHub API requests unauthenticated when no token is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const fetchImplementation = sourceFetch();
    const source = new OpenPluginPackageSource(fetchImplementation as typeof fetch);

    await source.getPackage("fixture-plugin");

    const apiRequests = recordedRequests(fetchImplementation).filter(
      ([input]) => new URL(String(input)).host === "api.github.com",
    );
    expect(apiRequests).toHaveLength(2);
    for (const [, init] of apiRequests) {
      expect(authorization(init)).toBeNull();
    }
  });

  it("treats styles.css as optional but requires a retained license", async () => {
    const withoutStyles = new OpenPluginPackageSource(sourceFetch() as typeof fetch);
    const pkg = await withoutStyles.getPackage("fixture-plugin", "1.2.3");
    expect(pkg.assets.map((asset) => asset.filename)).toEqual(["manifest.json", "main.js"]);

    const withoutLicense = new OpenPluginPackageSource(
      sourceFetch({ licenseStatus: 404 }) as typeof fetch,
    );
    await expect(withoutLicense.getPackage("fixture-plugin", "1.2.3")).rejects.toThrow(
      "license metadata download failed with HTTP 404",
    );
  });

  it("rejects a release whose manifest version differs from the exact tag", async () => {
    const source = new OpenPluginPackageSource(
      sourceFetch({ manifestVersion: "9.9.9" }) as typeof fetch,
    );

    await expect(source.getPackage("fixture-plugin", "1.2.3")).rejects.toThrow(
      "does not match exact tag",
    );
  });

  it("rejects malformed encoded evidence and redirects outside GitHub hosts", async () => {
    const malformed = new OpenPluginPackageSource(
      sourceFetch({ malformedLicense: true }) as typeof fetch,
    );
    await expect(malformed.getPackage("fixture-plugin", "1.2.3")).rejects.toThrow(
      "not canonical base64",
    );

    const redirected = new OpenPluginPackageSource(
      sourceFetch({ blockedFinalHost: true }) as typeof fetch,
    );
    await expect(redirected.getIndex()).rejects.toThrow("outside the allowed GitHub hosts");
  });
});
