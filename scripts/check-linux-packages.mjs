import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

const appRoot = process.cwd();
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const artifactStem = `Threadleaf-${packageData.version}-linux-x86_64`;
const releasePath = path.join(appRoot, "release");
const appImagePath = path.join(releasePath, `${artifactStem}.AppImage`);
const rpmPath = path.join(releasePath, `${artifactStem}.rpm`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
      } else {
        reject(
          new Error(
            `${command} exited ${code ?? signal}.\n${stdout.join("")}${stderr.join("")}`.trim(),
          ),
        );
      }
    });
  });
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      env: { ...process.env, ...options.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code ?? signal}.`));
      }
    });
  });
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
}

assert(process.platform === "linux", "Linux package verification requires Linux.");
assert(process.arch === "x64", "Linux package verification currently requires x64.");

const appImageStat = await fs.stat(appImagePath);
assert(appImageStat.isFile(), "The AppImage artifact is missing.");
assert((appImageStat.mode & 0o111) !== 0, "The AppImage artifact is not executable.");
const rpmStat = await fs.stat(rpmPath);
assert(rpmStat.isFile(), "The RPM artifact is missing.");

const version = await output(appImagePath, ["--version"], {
  env: { ELECTRON_OZONE_PLATFORM_HINT: "x11" },
});
assert(version.stderr === "", `AppImage --version wrote stderr: ${version.stderr}`);
assert(
  version.stdout === `${packageData.version}\n`,
  "AppImage version differs from package.json.",
);

const metadata = await output("rpm", [
  "-qp",
  "--queryformat",
  "%{NAME}\\n%{VERSION}\\n%{RELEASE}\\n%{ARCH}\\n%{LICENSE}\\n%{URL}\\n%{SUMMARY}\\n",
  rpmPath,
]);
const [name, rpmVersion, release, architecture, license, url, summary] = metadata.stdout
  .trimEnd()
  .split("\n");
assert(name === packageData.name, `Unexpected RPM name: ${name}`);
assert(
  rpmVersion === packageData.version.replace("-", "~"),
  `Unexpected RPM version: ${rpmVersion}`,
);
assert(release === "1", `Unexpected RPM release: ${release}`);
assert(architecture === "x86_64", `Unexpected RPM architecture: ${architecture}`);
assert(license === packageData.license, `Unexpected RPM license: ${license}`);
assert(url === packageData.homepage, `Unexpected RPM homepage: ${url}`);
assert(
  summary === "Open local Markdown vaults on an open runtime",
  `Unexpected RPM summary: ${summary}`,
);

const rpmFiles = new Set(
  (await output("rpm", ["-qpl", rpmPath])).stdout.trim().split("\n").filter(Boolean),
);
for (const expected of [
  "/opt/Threadleaf/threadleaf",
  "/opt/Threadleaf/resources/app.asar",
  "/opt/Threadleaf/resources/LICENSE.threadleaf.txt",
  "/opt/Threadleaf/resources/bundled-vault/Welcome.md",
  "/opt/Threadleaf/resources/bundled-vault/.obsidian/plugins/threadleaf-fixture/manifest.json",
  "/usr/share/applications/threadleaf.desktop",
  "/usr/share/icons/hicolor/scalable/apps/threadleaf.svg",
]) {
  assert(rpmFiles.has(expected), `RPM is missing ${expected}.`);
}
const requirements = (await output("rpm", ["-qp", "--requires", rpmPath])).stdout
  .trim()
  .split("\n")
  .filter(Boolean);
assert(requirements.includes("gtk3"), "RPM dependency metadata is missing gtk3.");
assert(requirements.includes("nss"), "RPM dependency metadata is missing nss.");

await run("xvfb-run", ["-a", process.execPath, "scripts/check-packaged-app.mjs"], {
  env: { THREADLEAF_PACKAGED_EXECUTABLE: appImagePath },
});
await run("xvfb-run", ["-a", process.execPath, "scripts/check-packaged-properties.mjs"], {
  env: { THREADLEAF_PACKAGED_EXECUTABLE: appImagePath },
});

const artifacts = [];
for (const filePath of [appImagePath, rpmPath]) {
  artifacts.push({
    filename: path.basename(filePath),
    bytes: (await fs.stat(filePath)).size,
    sha256: await sha256(filePath),
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
    rpm: {
      version: rpmVersion,
      release,
      architecture,
      files: rpmFiles.size,
      requirements: requirements.length,
    },
    artifacts,
    checksums: checksumName,
  }),
);
