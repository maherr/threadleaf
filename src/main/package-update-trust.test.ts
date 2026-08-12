import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appUpdateDisabledReason,
  parsePackageUpdateTrust,
  readPackageUpdateTrust,
  signedUpdateTrust,
} from "./package-update-trust";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("package update trust", () => {
  it("accepts only the exact signed release marker", () => {
    expect(parsePackageUpdateTrust({ threadleafUpdateTrust: signedUpdateTrust })).toBe(
      signedUpdateTrust,
    );
    expect(parsePackageUpdateTrust({ threadleafUpdateTrust: "signed" })).toBeNull();
    expect(parsePackageUpdateTrust(null)).toBeNull();
  });

  it("fails closed for missing, malformed, and unsigned package metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "threadleaf-update-trust-"));
    scratchDirectories.push(directory);
    expect(readPackageUpdateTrust(directory)).toBeNull();

    await writeFile(join(directory, "package.json"), "not-json", "utf8");
    expect(readPackageUpdateTrust(directory)).toBeNull();

    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "threadleaf" }),
      "utf8",
    );
    expect(readPackageUpdateTrust(directory)).toBeNull();
  });

  it("enables updates only for signed macOS and Windows packages", () => {
    expect(
      appUpdateDisabledReason({
        isPackaged: false,
        platform: "darwin",
        updateTrust: signedUpdateTrust,
      }),
    ).toBe("development-build");
    expect(
      appUpdateDisabledReason({
        isPackaged: true,
        platform: "linux",
        updateTrust: signedUpdateTrust,
      }),
    ).toBe("unsupported-platform");
    expect(
      appUpdateDisabledReason({ isPackaged: true, platform: "darwin", updateTrust: null }),
    ).toBe("unsigned-package");
    expect(
      appUpdateDisabledReason({ isPackaged: true, platform: "win32", updateTrust: null }),
    ).toBe("unsigned-package");
    expect(
      appUpdateDisabledReason({
        isPackaged: true,
        platform: "darwin",
        updateTrust: signedUpdateTrust,
      }),
    ).toBeNull();
    expect(
      appUpdateDisabledReason({
        isPackaged: true,
        platform: "win32",
        updateTrust: signedUpdateTrust,
      }),
    ).toBeNull();
  });
});
