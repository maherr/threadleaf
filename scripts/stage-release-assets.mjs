import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const appRoot = process.cwd();
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const safeTokenPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

const lanes = {
  "linux-x64-unsigned": {
    requiredReceiptSignatureStatus: "unsigned",
    filenames(version) {
      const nativeStem = `Threadleaf-${version}-linux-x86_64`;
      const reproducibleStem = `Threadleaf-${version}-linux-x64-reproducible.tar.xz`;
      return [
        `${nativeStem}.AppImage`,
        `${nativeStem}.rpm`,
        `${nativeStem}.sha256`,
        reproducibleStem,
        `${reproducibleStem}.manifest.json`,
        `${reproducibleStem}.sha256`,
      ];
    },
  },
  "macos-universal-signed": {
    requiredReceiptSignatureStatus: "verified",
    filenames(version) {
      const stem = `Threadleaf-${version}-mac-universal`;
      return [`${stem}.dmg`, `${stem}.zip`, `${stem}.sha256`, "latest-mac.yml"];
    },
  },
  "windows-x64-signed": {
    requiredReceiptSignatureStatus: "verified",
    filenames(version) {
      const stem = `Threadleaf-${version}-win-x64`;
      return [`${stem}.exe`, `${stem}.zip`, `${stem}.sha256`, "latest.yml"];
    },
  },
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function record(value, label) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} has unsupported or missing fields.`,
  );
}

function filename(value, label) {
  assert(typeof value === "string" && value.length > 0, `${label} must be a non-empty filename.`);
  assert(
    path.basename(value) === value && value !== "." && value !== "..",
    `${label} must be a basename.`,
  );
  return value;
}

function parseArguments(argv) {
  const values = new Map();
  const tokens = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    assert(
      flag === "--lane" || flag === "--input" || flag === "--receipt" || flag === "--output",
      `Unsupported argument: ${flag}.`,
    );
    const value = tokens[index + 1];
    assert(typeof value === "string" && value.length > 0, `${flag} requires a value.`);
    assert(!values.has(flag), `${flag} may be supplied only once.`);
    values.set(flag, value);
    index += 1;
  }
  for (const required of ["--lane", "--input", "--receipt", "--output"]) {
    assert(values.has(required), `Missing required argument: ${required}.`);
  }
  return {
    inputPath: path.resolve(appRoot, values.get("--input")),
    laneName: values.get("--lane"),
    outputPath: path.resolve(appRoot, values.get("--output")),
    receiptPath: path.resolve(appRoot, values.get("--receipt")),
  };
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function requiredRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath);
  assert(!stat.isSymbolicLink(), `${label} must not be a symlink.`);
  assert(stat.isFile(), `${label} must be a regular file.`);
  return stat;
}

async function requiredRealDirectory(directoryPath, label) {
  const stat = await fs.lstat(directoryPath);
  assert(!stat.isSymbolicLink(), `${label} must not be a symlink.`);
  assert(stat.isDirectory(), `${label} must be a directory.`);
}

async function sourceCommit() {
  const { stdout } = await runFile("git", ["rev-parse", "HEAD"], {
    cwd: appRoot,
    encoding: "utf8",
  });
  const commit = stdout.trim();
  assert(commitPattern.test(commit), "Git did not provide a full source commit.");
  return commit;
}

async function packageVersion() {
  const value = record(
    JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8")),
    "package.json",
  );
  assert(
    typeof value.version === "string" && safeTokenPattern.test(value.version),
    "package.json has an unsafe version.",
  );
  return value.version;
}

function parseReceiptAsset(value, index) {
  const asset = record(value, `Receipt asset ${index + 1}`);
  exactKeys(asset, ["filename", "bytes", "sha256"], `Receipt asset ${index + 1}`);
  const name = filename(asset.filename, `Receipt asset ${index + 1} filename`);
  assert(
    Number.isSafeInteger(asset.bytes) && asset.bytes >= 0,
    `Receipt asset ${index + 1} bytes must be a non-negative safe integer.`,
  );
  assert(
    typeof asset.sha256 === "string" && sha256Pattern.test(asset.sha256),
    `Receipt asset ${index + 1} has an invalid SHA-256 digest.`,
  );
  return { filename: name, bytes: asset.bytes, sha256: asset.sha256 };
}

function parseReceipt(value) {
  const receipt = record(value, "Release verification receipt");
  exactKeys(
    receipt,
    ["schemaVersion", "sourceCommit", "version", "lane", "signature", "assets"],
    "Release verification receipt",
  );
  assert(receipt.schemaVersion === 1, "Release verification receipt schema is unsupported.");
  assert(
    typeof receipt.sourceCommit === "string" && commitPattern.test(receipt.sourceCommit),
    "Release verification receipt has an invalid source commit.",
  );
  assert(
    typeof receipt.version === "string" && safeTokenPattern.test(receipt.version),
    "Release verification receipt has an invalid version.",
  );
  assert(
    typeof receipt.lane === "string" && Object.hasOwn(lanes, receipt.lane),
    "Release verification receipt has an unknown lane.",
  );
  const signature = record(receipt.signature, "Release verification receipt signature");
  exactKeys(signature, ["status"], "Release verification receipt signature");
  assert(
    signature.status === "unsigned" || signature.status === "verified",
    "Release verification receipt signature status is invalid.",
  );
  assert(Array.isArray(receipt.assets), "Release verification receipt assets must be an array.");
  const assets = receipt.assets.map(parseReceiptAsset);
  const names = new Set(assets.map((asset) => asset.filename));
  assert(
    names.size === assets.length,
    "Release verification receipt has duplicate asset filenames.",
  );
  return {
    assets,
    lane: receipt.lane,
    signatureStatus: signature.status,
    sourceCommit: receipt.sourceCommit,
    version: receipt.version,
  };
}

function compareExactNames(actualNames, expectedNames, label) {
  const actual = [...actualNames].sort();
  const expected = [...expectedNames].sort();
  assert(
    actual.length === expected.length && actual.every((name, index) => name === expected[index]),
    `${label} must contain exactly: ${expected.join(", ")}.`,
  );
}

function isInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function pathDoesNotExist(filePath, label) {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} must not already exist.`);
}

async function inspectAssets(inputPath, expectedNames, receiptAssets) {
  await requiredRealDirectory(inputPath, "Release input directory");
  const inputEntries = await fs.readdir(inputPath);
  compareExactNames(inputEntries, expectedNames, "Release input directory");
  compareExactNames(
    receiptAssets.map((asset) => asset.filename),
    expectedNames,
    "Release verification receipt assets",
  );

  const byName = new Map(receiptAssets.map((asset) => [asset.filename, asset]));
  const inspected = [];
  for (const name of expectedNames) {
    const receipt = byName.get(name);
    assert(receipt, `Release verification receipt is missing ${name}.`);
    const sourcePath = path.join(inputPath, name);
    const stat = await requiredRegularFile(sourcePath, `Release input ${name}`);
    assert(stat.size === receipt.bytes, `Release input ${name} size differs from its receipt.`);
    const digest = await sha256(sourcePath);
    assert(digest === receipt.sha256, `Release input ${name} SHA-256 differs from its receipt.`);
    inspected.push({
      bytes: stat.size,
      filename: name,
      mode: stat.mode & 0o777,
      sha256: digest,
      sourcePath,
    });
  }
  return inspected;
}

async function stageAssets(outputPath, assets, manifest) {
  await requiredRealDirectory(path.dirname(outputPath), "Release output parent directory");
  await pathDoesNotExist(outputPath, "Release output directory");
  await fs.mkdir(outputPath, { mode: 0o755 });

  for (const asset of assets) {
    const destination = path.join(outputPath, asset.filename);
    await fs.copyFile(asset.sourcePath, destination);
    await fs.chmod(destination, asset.mode);
    const staged = await requiredRegularFile(destination, `Staged asset ${asset.filename}`);
    assert(staged.size === asset.bytes, `Staged asset ${asset.filename} size changed during copy.`);
    assert(
      (await sha256(destination)) === asset.sha256,
      `Staged asset ${asset.filename} SHA-256 changed during copy.`,
    );
  }

  const manifestPath = path.join(outputPath, manifest.filename);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest.value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await requiredRegularFile(manifestPath, `Staged manifest ${manifest.filename}`);
  compareExactNames(
    await fs.readdir(outputPath),
    [...assets.map((asset) => asset.filename), manifest.filename],
    "Staged release directory",
  );
}

async function main() {
  const { inputPath, laneName, outputPath, receiptPath } = parseArguments(process.argv.slice(2));
  assert(Object.hasOwn(lanes, laneName), `Unknown release lane: ${laneName}.`);
  const lane = lanes[laneName];
  await requiredRegularFile(receiptPath, "Release verification receipt");
  const [version, commit, receiptValue] = await Promise.all([
    packageVersion(),
    sourceCommit(),
    fs.readFile(receiptPath, "utf8"),
  ]);
  const receipt = parseReceipt(JSON.parse(receiptValue));
  assert(receipt.version === version, "Release verification receipt version is stale.");
  assert(
    receipt.lane === laneName,
    "Release verification receipt lane differs from the selected lane.",
  );
  assert(
    receipt.sourceCommit === commit,
    "Release verification receipt source commit differs from the current source commit.",
  );
  assert(
    receipt.signatureStatus === lane.requiredReceiptSignatureStatus,
    `Release lane ${laneName} requires ${lane.requiredReceiptSignatureStatus} signature evidence.`,
  );
  assert(
    !isInside(inputPath, outputPath),
    "Release output directory must not be inside the input directory.",
  );

  const expectedNames = lane.filenames(version);
  const assets = await inspectAssets(inputPath, expectedNames, receipt.assets);
  const manifestFilename = `Threadleaf-${version}-${laneName}.release-manifest.json`;
  const manifest = {
    filename: manifestFilename,
    value: {
      assets: assets.map(({ bytes, filename, mode, sha256 }) => ({
        bytes,
        filename,
        mode,
        sha256,
      })),
      lane: laneName,
      product: "threadleaf",
      schemaVersion: 1,
      receiptSignatureStatus: lane.requiredReceiptSignatureStatus,
      sourceCommit: commit,
      version,
    },
  };
  await stageAssets(outputPath, assets, manifest);
  process.stdout.write(
    `${JSON.stringify({
      assets: assets.map(({ filename }) => filename),
      lane: laneName,
      manifest: manifestFilename,
      sourceCommit: commit,
      staged: true,
      version,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
