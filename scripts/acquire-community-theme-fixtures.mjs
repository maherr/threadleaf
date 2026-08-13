import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cachePath,
  defaultCacheRoot,
  readCommunityManifest,
  sha256,
  verifyCommunityCache,
} from "./community-theme-fixture.mjs";

const acquire = process.argv.includes("--acquire");
const json = process.argv.includes("--json");

function print(message) {
  if (!json) process.stdout.write(`${message}\n`);
}

async function acquireFile(cacheRoot, theme, file) {
  const target = cachePath(cacheRoot, theme.id, file.path);
  const maximumBytes =
    file.path === "theme.css"
      ? 2 * 1024 * 1024
      : file.path === "manifest.json"
        ? 64 * 1024
        : 512 * 1024;
  const response = await fetch(file.url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`${file.url} returned HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) {
    throw new Error(`${theme.id}/${file.path} exceeds its ${maximumBytes} byte acquisition bound`);
  }
  const actual = sha256(bytes);
  if (actual !== file.sha256) {
    throw new Error(
      `${theme.id}/${file.path} hash mismatch: received ${actual}, expected ${file.sha256}`,
    );
  }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.part-${process.pid}`;
  await fs.writeFile(temporary, bytes, { mode: 0o600 });
  await fs.rename(temporary, target);
  print(`COMMUNITY_THEME_CACHE_WRITE ${theme.id}/${file.path} ${actual}`);
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
