import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireStateLock,
  acquireStateLockAsync,
  nativeStateLockMechanism,
  nativeStateLockPlatform,
  StateLockBusyError,
  StateLockMigrationRequiredError,
  withStateLock,
} from "./index";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-state-lock-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("private state lock", () => {
  it("maps the host mechanism and retains a persistent regular path", async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, "état.lock");
    const lock = acquireStateLock(lockPath);

    expect(lock.platform).toBe(nativeStateLockPlatform());
    expect(lock.mechanism).toBe(nativeStateLockMechanism());
    lock.assertPathIdentity();
    lock.close();
    expect((await fs.stat(lockPath)).isFile()).toBe(true);
  });

  it("reports same-process contention without relying on process metadata", async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, "same-process.lock");
    const holder = acquireStateLock(lockPath);
    expect(() => acquireStateLock(lockPath)).toThrowError(StateLockBusyError);
    holder.close();
    const afterRelease = acquireStateLock(lockPath);
    afterRelease.close();
  });

  it("preserves busy and migration-required as typed states", async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, "state.lock");
    const holder = acquireStateLock(lockPath);
    await expect(
      acquireStateLockAsync(lockPath, { timeoutMs: 35, pollIntervalMs: 5 }),
    ).rejects.toBeInstanceOf(StateLockBusyError);
    holder.close();

    const legacyPath = path.join(root, "legacy.lock");
    await fs.mkdir(legacyPath);
    expect(() => acquireStateLock(legacyPath)).toThrowError(StateLockMigrationRequiredError);
    expect((await fs.stat(legacyPath)).isDirectory()).toBe(true);
  });

  it("always releases after an operation error", async () => {
    const root = await temporaryRoot();
    const lockPath = path.join(root, "error.lock");
    await expect(
      withStateLock(lockPath, async (lock) => {
        lock.assertPathIdentity();
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    const afterError = acquireStateLock(lockPath);
    afterError.close();
  });
});
