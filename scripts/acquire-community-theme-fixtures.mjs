import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  assertNoSymlinkAncestors,
  assertSafeCacheRoot,
  CACHE_FILE_LIMITS,
  cachePath,
  defaultCacheRoot,
  readCommunityManifest,
  verifyCommunityCache,
} from "./community-theme-fixture.mjs";

const acquire = process.argv.includes("--acquire");
const json = process.argv.includes("--json");
const FETCH_DEADLINE_MS = 30_000;

function print(message) {
  if (!json) process.stdout.write(`${message}\n`);
}

async function acquireFile(cacheRoot, theme, file) {
  const target = cachePath(cacheRoot, theme.id, file.path);
  const maximumBytes = CACHE_FILE_LIMITS[file.path];
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), FETCH_DEADLINE_MS);
  try {
    const response = await fetch(file.url, { redirect: "error", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${file.url} returned HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error(`${file.url} returned no streaming body.`);
    }
    await assertSafeCacheRoot(cacheRoot);
    await assertNoSymlinkAncestors(path.dirname(target));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestors(target);
    const canonicalParent = await fs.realpath(path.dirname(target));
    const canonicalRoot = await fs.realpath(cacheRoot);
    const relative = path.relative(canonicalRoot, canonicalParent);
    if (relative.startsWith(`..${path.sep}`) || relative === "..") {
      throw new Error(`${theme.id}/${file.path} parent escapes the cache root.`);
    }
    const temporary = `${target}.part-${process.pid}-${Math.random().toString(16).slice(2)}`;
    let handle;
    let complete = false;
    let bytesRead = 0;
    const digest = createHash("sha256");
    let actual;
    try {
      handle = await fs.open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytesRead += chunk.length;
        if (bytesRead > maximumBytes) {
          throw new Error(
            `${theme.id}/${file.path} exceeds its ${maximumBytes} byte acquisition bound`,
          );
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      actual = digest.digest("hex");
      if (actual !== file.sha256) {
        throw new Error(
          `${theme.id}/${file.path} hash mismatch: received ${actual}, expected ${file.sha256}`,
        );
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, target);
      complete = true;
    } finally {
      await handle?.close().catch(() => undefined);
      if (!complete) await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    print(`COMMUNITY_THEME_CACHE_WRITE ${theme.id}/${file.path} ${actual}`);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `${file.url} acquisition exceeded its ${FETCH_DEADLINE_MS}ms deadline or was aborted.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

async function main() {
  const manifest = await readCommunityManifest();
  const cacheRoot = defaultCacheRoot();
  let verification = await verifyCommunityCache(manifest, cacheRoot);
  if (!verification.complete && !acquire) {
    process.stderr.write(
      `COMMUNITY_THEME_CACHE_MISSING ${verification.missing.join(", ")}\n` +
        "Run `pnpm community-theme:acquire` to opt in to network acquisition; runtime stays offline.\n",
    );
    process.exitCode = 2;
    return;
  }
  if (!verification.complete) {
    for (const theme of manifest.themes ?? []) {
      for (const file of theme.files ?? []) {
        const expected = `${theme.id}/${file.path}`;
        if (
          verification.missing.some(
            (entry) => entry.startsWith(`${expected} `) || entry === expected,
          )
        ) {
          await acquireFile(cacheRoot, theme, file);
        }
      }
    }
    verification = await verifyCommunityCache(manifest, cacheRoot);
  }
  if (!verification.complete) {
    throw new Error(`Community theme cache remains incomplete: ${verification.missing.join(", ")}`);
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ cacheRoot: verification.cacheRoot, receipts: verification.receipts }, null, 2)}\n`,
    );
  } else {
    print(`COMMUNITY_THEME_CACHE_READY ${verification.cacheRoot}`);
    print(`COMMUNITY_THEME_CACHE_RECEIPTS ${verification.receipts.length}`);
  }
}

main().catch((error) => {
  process.stderr.write(
    `COMMUNITY_THEME_ACQUIRE_FAIL ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
