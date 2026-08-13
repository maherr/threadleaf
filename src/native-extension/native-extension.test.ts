import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  crossVaultRead,
  partialWrite,
  traversalRead,
  unavailableNetwork,
  undeclaredNetwork,
} from "../../fixtures/native-extensions/malicious/index";
import { portableSummaryFixture } from "../../fixtures/native-extensions/portable-summary/index";
import type { VaultMutationPort } from "../kernel/ports";
import type { NativeExtensionError } from "./errors";
import { FileNativeExtensionGrantStore, InMemoryNativeExtensionGrantStore } from "./grants";
import { NativeExtensionHost } from "./host";
import { nativeExtensionCapabilityDefinitions, parseNativeExtensionManifest } from "./manifest";
import { bindNativeVaultPort, type NativeVaultPort } from "./ports";
import { defineNativeExtension, type NativeExtensionBundle } from "./sdk";

const vaultId = "vault-a";
const otherVaultId = "vault-b";

function manifest(id: string, capabilities: string[], target: "portable" | "desktop" = "portable") {
  return {
    manifestVersion: 1,
    apiVersion: "1.0",
    id,
    name: id,
    version: "1.0.0",
    entrypoint: "bundle.js",
    portable: target === "portable",
    desktopOnly: target === "desktop",
    capabilities,
  };
}

function fakeVault(): { port: NativeVaultPort; reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    writes,
    port: {
      listMarkdownPaths: async () => ["Welcome.md"],
      readText: async ({ relativePath }) => {
        reads.push(relativePath);
        return {
          path: relativePath,
          content: "# Welcome\nBody",
          revision: "a".repeat(64),
          size: 14,
        };
      },
      writeText: async ({ relativePath, content }) => {
        writes.push(`${relativePath}:${content}`);
        return {
          status: "committed",
          path: relativePath,
          revision: "b".repeat(64),
          transactionId: "transaction-1",
        };
      },
    },
  };
}

function hostWith(
  port: NativeVaultPort,
  options: Partial<ConstructorParameters<typeof NativeExtensionHost>[0]> = {},
): NativeExtensionHost {
  return new NativeExtensionHost({ ports: { vault: port }, ...options });
}

function bundle<Input = unknown, Output = unknown>(
  id: string,
  capabilities: string[],
  entrypoint: NativeExtensionBundle<Input, Output>["entrypoint"],
  target: "portable" | "desktop" = "portable",
  bytes = `bundle:${id}:1`,
): NativeExtensionBundle<Input, Output> {
  return defineNativeExtension({
    manifest: manifest(id, capabilities, target),
    bundleBytes: new TextEncoder().encode(bytes),
    entrypoint,
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: NativeExtensionError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "NativeExtensionError", code });
}

describe("native extension manifest and capability host", () => {
  it("runs the portable SDK workflow only through the vault public port", async () => {
    const fake = fakeVault();
    const host = hostWith(fake.port);
    const review = host.register(portableSummaryFixture);

    expect(review.capabilities).toEqual(["vault.read", "vault.write"]);
    expect(review.authorityChange).toBe("new");
    expect(review.requiresReReview).toBe(false);
    expect(review.boundaries["vault.read"]).toBe("capability-governed");
    await expectCode(
      host.execute(vaultId, "threadleaf.portable-summary", {
        path: "Welcome.md",
        outputPath: "Summary.md",
      }),
      "grant-required",
    );

    await host.grant(vaultId, "threadleaf.portable-summary");
    const result = await host.execute<{ path: string; outputPath: string }, { status: string }>(
      vaultId,
      "threadleaf.portable-summary",
      { path: "Welcome.md", outputPath: "Summary.md" },
    );
    expect(result.status).toBe("committed");
    expect(fake.reads).toEqual(["Welcome.md"]);
    expect(fake.writes).toEqual(["Summary.md:# Portable summary\n\n# Welcome\n"]);
    const inspection = await host.inspect(vaultId, "threadleaf.portable-summary");
    expect(inspection).toMatchObject({
      state: "granted",
      sandboxed: false,
      boundary: "capability-governed",
      grantedCapabilities: ["vault.read", "vault.write"],
    });
    await host.close();
  });

  it("binds grants to exact bytes and requires re-review when authority grows", async () => {
    const fake = fakeVault();
    const host = hostWith(fake.port);
    const first = bundle("upgrade", ["vault.read"], async (context) =>
      context.vault.readText({ vaultId: context.vaultId, relativePath: "Welcome.md" }),
    );
    host.register(first);
    await host.grant(vaultId, "upgrade");
    expect(await host.inspect(vaultId, "upgrade")).toMatchObject({ state: "granted" });

    const changedBytes = bundle(
      "upgrade",
      ["vault.read"],
      async (context) =>
        context.vault.readText({ vaultId: context.vaultId, relativePath: "Welcome.md" }),
      "portable",
      "bundle:upgrade:2",
    );
    host.register(changedBytes);
    expect(await host.inspect(vaultId, "upgrade")).toMatchObject({ state: "stale" });
    await expectCode(host.execute(vaultId, "upgrade", undefined), "stale-grant");

    const authorityGrowth = bundle(
      "upgrade",
      ["vault.read", "vault.write"],
      async (context) =>
        context.vault.readText({ vaultId: context.vaultId, relativePath: "Welcome.md" }),
      "portable",
      "bundle:upgrade:3",
    );
    const review = host.register(authorityGrowth);
    expect(review.authorityChange).toBe("grew");
    expect(review.requiresReReview).toBe(true);
    await expectCode(host.execute(vaultId, "upgrade", undefined), "stale-grant");
    await host.close();
  });

  it("rejects undeclared, unavailable, partial, and cross-vault calls with typed failures", async () => {
    const fake = fakeVault();
    const host = hostWith(fake.port);
    const undeclared = bundle("undeclared", ["vault.read"], undeclaredNetwork);
    host.register(undeclared);
    await host.grant(vaultId, "undeclared");
    await expectCode(host.execute(vaultId, "undeclared", undefined), "undeclared-capability");

    const unavailable = bundle("unavailable", ["network"], unavailableNetwork);
    host.register(unavailable);
    await host.grant(vaultId, "unavailable");
    await expectCode(host.execute(vaultId, "unavailable", undefined), "capability-unavailable");

    const partial = bundle("partial", ["vault.read", "vault.write"], partialWrite);
    host.register(partial);
    await host.grant(vaultId, "partial", ["vault.read"]);
    await expectCode(host.execute(vaultId, "partial", undefined), "capability-denied");

    const crossVault = bundle("cross-vault", ["vault.read"], crossVaultRead);
    host.register(crossVault);
    await host.grant(vaultId, "cross-vault");
    await expectCode(host.execute(vaultId, "cross-vault", undefined), "cross-vault");
    expect(fake.reads).toEqual([]);

    const traversal = bundle("traversal", ["vault.read"], traversalRead);
    host.register(traversal);
    await host.grant(vaultId, "traversal");
    await expectCode(host.execute(vaultId, "traversal", undefined), "invalid-request");
    expect(fake.reads).toEqual([]);
    await host.close();
  });

  it("keeps safe mode and revocation separate from the private grant", async () => {
    const fake = fakeVault();
    const store = new InMemoryNativeExtensionGrantStore();
    const host = hostWith(fake.port, { grantStore: store });
    const extension = bundle("lifecycle", ["vault.read"], async (context) =>
      context.vault.readText({ vaultId: context.vaultId, relativePath: "Welcome.md" }),
    );
    host.register(extension);
    await host.grant(vaultId, "lifecycle");
    host.setSafeMode(vaultId, true);
    await expectCode(host.execute(vaultId, "lifecycle", undefined), "safe-mode");
    host.setSafeMode(vaultId, false);
    expect((await host.inspect(vaultId, "lifecycle")).state).toBe("granted");
    await host.revoke(vaultId, "lifecycle");
    expect((await host.inspect(vaultId, "lifecycle")).state).toBe("revoked");
    await expectCode(host.execute(vaultId, "lifecycle", undefined), "revoked");
    const stored = await store.get(vaultId, "lifecycle");
    expect(stored?.revokedAt).toEqual(expect.any(String));
    await host.close();
  });

  it("runs teardown on timeout and explicit stop, and never reuses a stopped context", async () => {
    const fake = fakeVault();
    let cleaned = 0;
    const host = hostWith(fake.port, { invocationTimeoutMs: 10, teardownTimeoutMs: 20 });
    const timeout = bundle("timeout", [], async (context) => {
      context.onTeardown(() => {
        cleaned += 1;
      });
      await new Promise<void>(() => undefined);
    });
    host.register(timeout);
    await host.grant(vaultId, "timeout");
    await expectCode(host.execute(vaultId, "timeout", undefined), "timeout");
    expect(cleaned).toBe(1);
    expect((await host.inspect(vaultId, "timeout")).active).toBe(false);

    let release: (() => void) | undefined;
    const stopped = bundle("stopped", [], async (context) => {
      context.onTeardown(() => {
        cleaned += 1;
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    host.register(stopped);
    await host.grant(vaultId, "stopped");
    const running = host.execute(vaultId, "stopped", undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await host.stop(vaultId, "stopped");
    await expectCode(running, "teardown");
    release?.();
    expect((await host.inspect(vaultId, "stopped")).active).toBe(false);
    await host.close();
  });

  it("labels desktop escapes and rejects them from the portable runtime", async () => {
    const fake = fakeVault();
    const portableHost = hostWith(fake.port);
    const desktop = bundle("desktop-escape", ["subprocess"], async () => undefined, "desktop");
    const review = portableHost.register(desktop);
    expect(review.boundaries.subprocess).toBe("trusted-desktop-escape");
    await expectCode(portableHost.grant(vaultId, "desktop-escape"), "runtime-unavailable");
    await portableHost.close();

    const desktopHost = hostWith(fake.port, { runtime: "desktop-trusted" });
    desktopHost.register(desktop);
    await desktopHost.grant(vaultId, "desktop-escape");
    expect(await desktopHost.inspect(vaultId, "desktop-escape")).toMatchObject({
      runtime: "desktop-trusted",
      sandboxed: false,
      boundary: "trusted-desktop-escape",
    });
    await desktopHost.close();
  });

  it("persists private per-vault grants atomically with restrictive permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-native-grants-"));
    try {
      const filePath = path.join(root, "application", "native-grants.v1.json");
      const store = new FileNativeExtensionGrantStore(filePath);
      const grant = {
        grantVersion: 1 as const,
        vaultId,
        extensionId: "portable",
        bundleSha256: "a".repeat(64),
        authorityDigest: "b".repeat(64),
        capabilities: ["vault.read" as const],
        grantedAt: "2026-08-12T00:00:00.000Z",
      };
      await store.put(grant);
      expect(await store.get(vaultId, "portable")).toEqual(grant);
      const mode = (await fs.stat(filePath)).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(await store.list(otherVaultId)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("native extension capability vocabulary", () => {
  it("parses the versioned manifest and rejects target or authority mismatches", () => {
    const parsed = parseNativeExtensionManifest(manifest("manifest", ["vault.write"]));
    expect(parsed.capabilities).toEqual([{ id: "vault.write" }]);
    expect(() =>
      parseNativeExtensionManifest({
        ...manifest("invalid-target", ["subprocess"]),
        portable: true,
        desktopOnly: false,
      }),
    ).toThrow("Portable native extensions cannot declare a desktop-only capability.");
    expect(() =>
      parseNativeExtensionManifest({
        ...manifest("invalid-flags", []),
        portable: false,
        desktopOnly: false,
      }),
    ).toThrow("exactly one runtime target");
  });

  it("gives every declared ID an enforcement definition", () => {
    expect(Object.keys(nativeExtensionCapabilityDefinitions).sort()).toEqual([
      "clipboard",
      "dynamic-code",
      "editor-ui",
      "external-navigation",
      "network",
      "secrets",
      "subprocess",
      "vault.read",
      "vault.write",
      "workspace-ui",
    ]);
  });

  it("adapts the recoverable kernel port without dropping its vault identity check", async () => {
    const kernel: VaultMutationPort = {
      getName: () => "fixture",
      listMarkdownPaths: async () => ["Welcome.md"],
      readText: async (relativePath) => ({
        path: relativePath,
        content: "# Welcome",
        revision: "a".repeat(64),
        size: 9,
      }),
      writeText: async (relativePath) => ({
        status: "committed",
        path: relativePath,
        revision: "b".repeat(64),
        transactionId: "transaction-2",
      }),
      renameFile: async (sourcePath, targetPath) => ({
        status: "committed",
        from: sourcePath,
        to: targetPath,
        transactionId: "transaction-3",
      }),
      writeMany: async () => ({ status: "committed", transactionId: "transaction-4", entries: [] }),
      moveWithWrites: async ({ sourcePath, targetPath }) => ({
        status: "committed",
        from: sourcePath,
        to: targetPath,
        transactionId: "transaction-5",
        writes: [],
      }),
    };
    const port = bindNativeVaultPort(vaultId, kernel);
    await expect(
      port.readText({ vaultId: otherVaultId, relativePath: "Welcome.md" }),
    ).rejects.toMatchObject({
      code: "cross-vault",
    });
    await expect(port.readText({ vaultId, relativePath: "Welcome.md" })).resolves.toMatchObject({
      path: "Welcome.md",
      revision: "a".repeat(64),
    });
  });
});
