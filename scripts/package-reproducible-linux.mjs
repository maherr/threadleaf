import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const writeArtifacts = process.argv.includes("--write");
const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-reproducible-package-"));
const firstOutput = path.join(scratchRoot, "first");
const secondOutput = path.join(scratchRoot, "second");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      env: { ...process.env, ...options.env },
      stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const output = [];
    if (options.quiet) {
      for (const stream of [child.stdout, child.stderr]) {
        stream.on("data", (chunk) => output.push(String(chunk)));
      }
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} exited ${code ?? signal}.${output.length ? `\n${output.join("")}` : ""}`,
          ),
        );
      }
    });
  });
}

async function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout.join("").trim());
      } else {
        reject(new Error(`${command} exited ${code ?? signal}: ${stderr.join("").trim()}`));
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

async function treeManifest(rootPath) {
  const entries = [];
  async function visit(relativePath) {
    const absolutePath = path.join(rootPath, relativePath);
    const stat = await fs.lstat(absolutePath);
    const portablePath = relativePath.split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      entries.push({
        path: portablePath,
        type: "symlink",
        target: await fs.readlink(absolutePath),
      });
      return;
    }
    if (stat.isDirectory()) {
      const children = (await fs.readdir(absolutePath)).sort((left, right) =>
        left.localeCompare(right, "en"),
      );
      for (const child of children) {
        await visit(path.join(relativePath, child));
      }
      return;
    }
    assert(stat.isFile(), `Unexpected package entry type at ${portablePath}.`);
    entries.push({
      path: portablePath,
      type: "file",
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: await sha256(absolutePath),
    });
  }
  for (const entry of (await fs.readdir(rootPath)).sort((left, right) =>
    left.localeCompare(right, "en"),
  )) {
    await visit(entry);
  }
  return entries;
}

async function createArchive(sourcePath, archivePath, sourceDateEpoch) {
  await run(
    "tar",
    [
      "--sort=name",
      `--mtime=@${sourceDateEpoch}`,
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mode=u+rwX,go+rX,go-w",
      "--format=gnu",
      "-cJf",
      archivePath,
      "-C",
      sourcePath,
      ".",
    ],
    { env: { XZ_OPT: "-9e -T1" }, quiet: true },
  );
}

try {
  assert(process.platform === "linux", "Reproducible package proof currently requires Linux.");
  assert(process.arch === "x64", "Reproducible package proof currently requires x64.");
  if (writeArtifacts) {
    const status = await commandOutput("git", ["status", "--porcelain"]);
    assert(status === "", "Release artifacts can only be written from a clean source tree.");
  }

  const commit = await commandOutput("git", ["rev-parse", "HEAD"]);
  const sourceDateEpoch = await commandOutput("git", ["show", "-s", "--format=%ct", "HEAD"]);
  assert(/^\d+$/u.test(sourceDateEpoch), "Git did not provide a source timestamp.");
  const builder = path.join(appRoot, "node_modules", ".bin", "electron-builder");
  const environment = {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    SOURCE_DATE_EPOCH: sourceDateEpoch,
  };
  for (const outputPath of [firstOutput, secondOutput]) {
    await run(
      builder,
      [
        "--linux",
        "dir",
        "--x64",
        "--publish",
        "never",
        `--config.directories.output=${outputPath}`,
      ],
      { env: environment },
    );
  }

  const firstApp = path.join(firstOutput, "linux-unpacked");
  const secondApp = path.join(secondOutput, "linux-unpacked");
  const firstFiles = await treeManifest(firstApp);
  const secondFiles = await treeManifest(secondApp);
  const firstTree = JSON.stringify(firstFiles);
  const secondTree = JSON.stringify(secondFiles);
  assert(firstTree === secondTree, "Two package builds produced different application trees.");

  const firstArchive = path.join(scratchRoot, "first.tar.xz");
  const secondArchive = path.join(scratchRoot, "second.tar.xz");
  await createArchive(firstApp, firstArchive, sourceDateEpoch);
  await createArchive(secondApp, secondArchive, sourceDateEpoch);
  const firstArchiveHash = await sha256(firstArchive);
  const secondArchiveHash = await sha256(secondArchive);
  assert(
    firstArchiveHash === secondArchiveHash,
    "Two normalized archives produced different bytes.",
  );

  const treeSha256 = createHash("sha256").update(firstTree).digest("hex");
  const artifactName = `Threadleaf-${packageData.version}-linux-x64-reproducible.tar.xz`;
  const manifest = {
    schemaVersion: 1,
    applicationId: "org.threadleaf.Threadleaf",
    version: packageData.version,
    platform: "linux",
    architecture: "x64",
    commit,
    sourceDateEpoch: Number(sourceDateEpoch),
    treeSha256,
    archive: { filename: artifactName, sha256: firstArchiveHash },
    files: firstFiles,
  };

  if (writeArtifacts) {
    const releasePath = path.join(appRoot, "release");
    await fs.mkdir(releasePath, { recursive: true });
    const artifactPath = path.join(releasePath, artifactName);
    await fs.copyFile(firstArchive, artifactPath);
    await fs.writeFile(
      `${artifactPath}.manifest.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(`${artifactPath}.sha256`, `${firstArchiveHash}  ${artifactName}\n`, "utf8");
  }

  console.log(
    JSON.stringify({
      reproducible: true,
      fileCount: firstFiles.length,
      treeSha256,
      archiveSha256: firstArchiveHash,
      artifact: writeArtifacts ? artifactName : null,
    }),
  );
} finally {
  await fs.rm(scratchRoot, { recursive: true, force: true });
}
