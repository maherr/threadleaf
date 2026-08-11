import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

export interface FileSnapshot {
  bytes: Buffer;
  revision: string;
  size: number;
}

export function revisionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readStableFile(filePath: string): Promise<FileSnapshot | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(filePath, "r");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    try {
      const before = await handle.stat({ bigint: true });
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs
      ) {
        return { bytes, revision: revisionOf(bytes), size: bytes.length };
      }
    } finally {
      await handle.close();
    }
  }

  throw new Error(`File kept changing while it was read: ${filePath}`);
}

export async function durableCreate(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(
    filePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

export async function atomicWriteFile(filePath: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  try {
    await durableCreate(temporaryPath, bytes);
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await removeIfPresent(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function installStagedFile(stagedPath: string, targetPath: string): Promise<boolean> {
  try {
    await fs.link(stagedPath, targetPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
  await fs.unlink(stagedPath);
  const sourceDirectory = path.dirname(stagedPath);
  const targetDirectory = path.dirname(targetPath);
  await syncDirectory(targetDirectory);
  if (sourceDirectory !== targetDirectory) {
    await syncDirectory(sourceDirectory);
  }
  return true;
}

export async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function sameFile(leftPath: string, rightPath: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      fs.stat(leftPath, { bigint: true }),
      fs.stat(rightPath, { bigint: true }),
    ]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !(
        process.platform === "win32" &&
        error instanceof Error &&
        "code" in error &&
        (error.code === "EISDIR" || error.code === "EPERM" || error.code === "EINVAL")
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
