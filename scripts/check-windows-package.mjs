import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const appRoot = process.cwd();
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const releasePath = path.resolve(process.env.THREADLEAF_PACKAGE_OUTPUT ?? "release");
const requireSigned = process.env.THREADLEAF_REQUIRE_SIGNED === "1";
const artifactStem = `Threadleaf-${packageData.version}-win-x64`;
const installerPath = path.join(releasePath, `${artifactStem}.exe`);
const zipPath = path.join(releasePath, `${artifactStem}.zip`);
const unpackedPath = path.join(releasePath, "win-unpacked");
const scratchPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-windows-package-"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: appRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
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

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function signatureFor(filePath) {
  const script = `$signature = Get-AuthenticodeSignature -LiteralPath ${powershellLiteral(filePath)}; [pscustomobject]@{ Status = $signature.Status.ToString(); Subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress`;
  return JSON.parse(
    command("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script])
      .stdout,
  );
}

function verifyApplication(rootPath, label) {
  const executablePath = path.join(rootPath, "Threadleaf.exe");
  for (const requiredPath of [
    executablePath,
    path.join(rootPath, "resources", "app.asar"),
    path.join(rootPath, "resources", "app-update.yml"),
    path.join(rootPath, "resources", "LICENSE.threadleaf.txt"),
    path.join(rootPath, "resources", "bundled-vault", "Welcome.md"),
    path.join(
      rootPath,
      "resources",
      "bundled-vault",
      ".obsidian",
      "plugins",
      "threadleaf-fixture",
      "manifest.json",
    ),
  ]) {
    assert(existsSync(requiredPath), `${label} is missing ${requiredPath}.`);
  }
  const version = command(executablePath, ["--version"]);
  assert(version.stderr === "", `${label} --version wrote stderr: ${version.stderr}`);
  assert(version.stdout === `${packageData.version}\n`, `${label} has the wrong version.`);
  const updateTrust = command(executablePath, ["--update-trust"]);
  assert(updateTrust.stderr === "", `${label} --update-trust wrote stderr: ${updateTrust.stderr}`);
  assert(
    updateTrust.stdout === `${requireSigned ? "signed-release-v1" : "none"}\n`,
    `${label} has the wrong update trust marker.`,
  );
  return executablePath;
}

async function waitUntilMissing(directoryPath, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await exists(directoryPath))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Windows uninstaller did not remove ${directoryPath}.`);
}

try {
  assert(process.platform === "win32", "Windows package verification requires Windows.");
  assert(process.arch === "x64", "Windows package verification currently requires x64.");
  for (const requiredPath of [installerPath, zipPath, path.join(unpackedPath, "Threadleaf.exe")]) {
    assert(await exists(requiredPath), `Windows package is missing ${requiredPath}.`);
  }

  const unpackedExecutable = verifyApplication(unpackedPath, "Unpacked application");

  const expandedPath = path.join(scratchPath, "expanded");
  command(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${powershellLiteral(zipPath)} -DestinationPath ${powershellLiteral(expandedPath)} -Force`,
    ],
    { timeout: 180_000 },
  );
  verifyApplication(expandedPath, "ZIP application");

  const installedPath = path.join(scratchPath, "installed");
  command(installerPath, ["/S", `/D=${installedPath}`], { timeout: 180_000 });
  verifyApplication(installedPath, "Installed application");
  const uninstallerPath = path.join(installedPath, "Uninstall Threadleaf.exe");
  assert(await exists(uninstallerPath), "Windows installer did not create an uninstaller.");
  command(uninstallerPath, ["/S"], { timeout: 180_000 });
  await waitUntilMissing(installedPath, 30_000);

  const metadataPath = path.join(releasePath, "latest.yml");
  const metadata = parse(await fs.readFile(metadataPath, "utf8"));
  assert(
    metadata.version === packageData.version,
    "Windows update metadata has the wrong version.",
  );
  const installerEntry = metadata.files?.find(
    (candidate) => candidate.url === path.basename(installerPath),
  );
  assert(installerEntry, "Windows update metadata is missing the installer.");
  assert(
    installerEntry.size === (await fs.stat(installerPath)).size,
    "Windows installer metadata size is wrong.",
  );
  assert(
    installerEntry.sha512 === (await hash(installerPath, "sha512", "base64")),
    "Windows installer metadata digest is wrong.",
  );
  assert(
    metadata.path === path.basename(installerPath),
    "Windows primary update artifact is wrong.",
  );

  const appUpdate = parse(
    await fs.readFile(path.join(unpackedPath, "resources", "app-update.yml"), "utf8"),
  );
  assert(appUpdate.provider === "github", "Windows app update provider is not GitHub.");
  assert(appUpdate.owner === "maherr", "Windows app update owner is not maherr.");
  assert(appUpdate.repo === "threadleaf", "Windows app update repository is not threadleaf.");

  const installerSignature = signatureFor(installerPath);
  const executableSignature = signatureFor(unpackedExecutable);
  if (requireSigned) {
    assert(installerSignature.Status === "Valid", "Windows installer signature is not valid.");
    assert(executableSignature.Status === "Valid", "Windows executable signature is not valid.");
  }

  const artifacts = [];
  for (const artifactPath of [installerPath, zipPath, metadataPath]) {
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
      signed: requireSigned,
      installerSignature,
      executableSignature,
      artifacts,
      checksums: checksumName,
    }),
  );
} finally {
  await fs.rm(scratchPath, { recursive: true, force: true });
}
