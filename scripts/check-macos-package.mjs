import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const appRoot = process.cwd();
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const releasePath = path.resolve(process.env.THREADLEAF_PACKAGE_OUTPUT ?? "release");
const architecture = process.env.THREADLEAF_PACKAGE_ARCH ?? process.arch;
const requireSigned = process.env.THREADLEAF_REQUIRE_SIGNED === "1";
const artifactStem = `Threadleaf-${packageData.version}-mac-${architecture}`;
const zipPath = path.join(releasePath, `${artifactStem}.zip`);
const dmgPath = path.join(releasePath, `${artifactStem}.dmg`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: appRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${commandName} exited ${result.status ?? result.signal}.\n${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result;
}

async function verifyNativeArtifact(appPath, executablePath) {
  const nativePath = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "native",
    "threadleaf-state-lock.node",
  );
  const nativeSignature = command("codesign", ["--verify", "--strict", "--verbose=2", nativePath], {
    allowFailure: true,
  });
  if (requireSigned) {
    assert(nativeSignature.status === 0, "The packaged native state-lock addon is not signed.");
  }
  command(process.execPath, [
    "scripts/check-extracted-native-lock.mjs",
    nativePath,
    "darwin",
    architecture,
  ]);
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-macos-native-probe-"));
  try {
    const lockPath = path.join(probeRoot, "state.lock");
    const probe = command(executablePath, ["--native-lock-probe", lockPath]);
    const receipt = JSON.parse(probe.stdout.trim());
    assert(
      receipt.imported && receipt.acquired && receipt.asserted && receipt.released,
      "macOS packaged Electron did not complete native import/acquire/assert/release.",
    );
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true });
  }
  return {
    path: nativePath,
    bytes: (await fs.stat(nativePath)).size,
    sha256: await hash(nativePath, "sha256", "hex"),
    signatureStatus: nativeSignature.status,
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hash(filePath, algorithm, encoding) {
  const digest = createHash(algorithm);
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => digest.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return digest.digest(encoding);
}

async function findApplication() {
  const directories =
    architecture === "arm64"
      ? ["mac-arm64"]
      : architecture === "x64"
        ? ["mac", "mac-x64"]
        : architecture === "universal"
          ? ["mac-universal"]
          : [];
  assert(directories.length > 0, `Unsupported macOS package architecture: ${architecture}`);
  const matches = [];
  for (const directory of directories) {
    const candidate = path.join(releasePath, directory, "Threadleaf.app");
    if (await exists(candidate)) {
      matches.push(candidate);
    }
  }
  assert(matches.length === 1, `Expected one unpacked macOS application, found ${matches.length}.`);
  return matches[0];
}

assert(process.platform === "darwin", "macOS package verification requires macOS.");
const appPath = await findApplication();
const contentsPath = path.join(appPath, "Contents");
const resourcesPath = path.join(contentsPath, "Resources");
const executablePath = path.join(contentsPath, "MacOS", "Threadleaf");

for (const requiredPath of [
  executablePath,
  path.join(resourcesPath, "app.asar"),
  path.join(resourcesPath, "app-update.yml"),
  path.join(resourcesPath, "app.asar.unpacked", "dist", "native", "threadleaf-state-lock.node"),
  path.join(resourcesPath, "LICENSE.threadleaf.txt"),
  path.join(resourcesPath, "bundled-vault", "Welcome.md"),
  path.join(
    resourcesPath,
    "bundled-vault",
    ".obsidian",
    "plugins",
    "threadleaf-fixture",
    "manifest.json",
  ),
  zipPath,
  dmgPath,
]) {
  assert(await exists(requiredPath), `macOS package is missing ${requiredPath}.`);
}

const version = command(executablePath, ["--version"]);
assert(version.stderr === "", `macOS --version wrote stderr: ${version.stderr}`);
assert(version.stdout === `${packageData.version}\n`, "macOS version differs from package.json.");
const updateTrust = command(executablePath, ["--update-trust"]);
assert(updateTrust.stderr === "", `macOS --update-trust wrote stderr: ${updateTrust.stderr}`);
assert(
  updateTrust.stdout === `${requireSigned ? "signed-release-v1" : "none"}\n`,
  "macOS package has the wrong update trust marker.",
);

const plistPath = path.join(contentsPath, "Info.plist");
const bundleId = command("plutil", [
  "-extract",
  "CFBundleIdentifier",
  "raw",
  "-o",
  "-",
  plistPath,
]).stdout.trim();
const bundleVersion = command("plutil", [
  "-extract",
  "CFBundleShortVersionString",
  "raw",
  "-o",
  "-",
  plistPath,
]).stdout.trim();
assert(bundleId === "org.threadleaf.Threadleaf", `Unexpected macOS bundle id: ${bundleId}`);
assert(bundleVersion === packageData.version, `Unexpected macOS bundle version: ${bundleVersion}`);

const executableArchitectures = new Set(
  command("lipo", ["-archs", executablePath]).stdout.trim().split(/\s+/u),
);
const expectedArchitectures =
  architecture === "universal"
    ? new Set(["arm64", "x86_64"])
    : new Set([architecture === "x64" ? "x86_64" : architecture]);
assert(
  executableArchitectures.size === expectedArchitectures.size &&
    [...expectedArchitectures].every((entry) => executableArchitectures.has(entry)),
  `Unexpected executable architectures: ${[...executableArchitectures].join(", ")}`,
);

const nativeArtifact = await verifyNativeArtifact(appPath, executablePath);

command("unzip", ["-tqq", zipPath], { timeout: 180_000 });
command("hdiutil", ["verify", dmgPath], { timeout: 180_000 });

const metadataPath = path.join(releasePath, "latest-mac.yml");
const metadata = parse(await fs.readFile(metadataPath, "utf8"));
assert(metadata.version === packageData.version, "macOS update metadata has the wrong version.");
for (const artifactPath of [zipPath, dmgPath]) {
  const filename = path.basename(artifactPath);
  const entry = metadata.files?.find((candidate) => candidate.url === filename);
  assert(entry, `macOS update metadata is missing ${filename}.`);
  assert(entry.size === (await fs.stat(artifactPath)).size, `${filename} metadata size is wrong.`);
  assert(
    entry.sha512 === (await hash(artifactPath, "sha512", "base64")),
    `${filename} metadata digest is wrong.`,
  );
}
assert(metadata.path === path.basename(zipPath), "macOS primary update artifact is not the ZIP.");

const appUpdate = parse(await fs.readFile(path.join(resourcesPath, "app-update.yml"), "utf8"));
assert(appUpdate.provider === "github", "macOS app update provider is not GitHub.");
assert(appUpdate.owner === "maherr", "macOS app update owner is not maherr.");
assert(appUpdate.repo === "threadleaf", "macOS app update repository is not threadleaf.");

const codeSignature = command(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  {
    allowFailure: true,
  },
);
let gatekeeperStatus = null;
if (requireSigned) {
  assert(codeSignature.status === 0, `macOS code signature is invalid: ${codeSignature.stderr}`);
  command("xcrun", ["stapler", "validate", appPath]);
  const gatekeeper = command("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  gatekeeperStatus = gatekeeper.stderr.trim() || gatekeeper.stdout.trim();
}

const artifacts = [];
for (const artifactPath of [zipPath, dmgPath, metadataPath]) {
  artifacts.push({
    filename: path.basename(artifactPath),
    bytes: (await fs.stat(artifactPath)).size,
    sha256: await hash(artifactPath, "sha256", "hex"),
  });
}
const checksumName = `${artifactStem}.sha256`;
await fs.writeFile(
  path.join(releasePath, checksumName),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.filename}`).join("\n")}\n`,
  "utf8",
);

console.log(
  JSON.stringify({
    verified: true,
    version: packageData.version,
    architecture,
    executableArchitectures: [...executableArchitectures].sort(),
    signed: requireSigned,
    nativeArtifact,
    codeSignatureStatus: codeSignature.status,
    gatekeeperStatus,
    artifacts,
    checksums: checksumName,
  }),
);
