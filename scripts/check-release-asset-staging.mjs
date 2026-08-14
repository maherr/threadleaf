import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const appRoot = process.cwd();
const stagingScript = path.join(appRoot, "scripts", "stage-release-assets.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function filenamesFor(lane, version) {
  switch (lane) {
    case "linux-x64-unsigned": {
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
    }
    case "macos-universal-signed": {
      const stem = `Threadleaf-${version}-mac-universal`;
      return [`${stem}.dmg`, `${stem}.zip`, `${stem}.sha256`, "latest-mac.yml"];
    }
    case "windows-x64-signed": {
      const stem = `Threadleaf-${version}-win-x64`;
      return [`${stem}.exe`, `${stem}.zip`, `${stem}.sha256`, "latest.yml"];
    }
    default:
      throw new Error(`Unknown fixture lane: ${lane}.`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function stage(argumentsList) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [stagingScript, ...argumentsList], {
      cwd: appRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stderr: stderr.join(""), stdout: stdout.join("") });
    });
  });
}

async function exists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function fixture(lane, version, commit, signatureStatus) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-release-assets-"));
  const inputPath = path.join(root, "input");
  const outputPath = path.join(root, "output");
  const receiptPath = path.join(root, "receipt.json");
  const names = filenamesFor(lane, version);
  await fs.mkdir(inputPath);
  const assets = [];
  for (const name of names) {
    const bytes = Buffer.from(`Threadleaf release fixture ${lane}/${name}\n`, "utf8");
    await fs.writeFile(path.join(inputPath, name), bytes, { mode: 0o644 });
    assets.push({ bytes: bytes.length, filename: name, sha256: sha256(bytes) });
  }
  await fs.writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        assets,
        lane,
        schemaVersion: 1,
        signature: { status: signatureStatus },
        sourceCommit: commit,
        version,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    assets,
    inputPath,
    names,
    outputPath,
    receiptPath,
    root,
  };
}

async function releaseFixture(fixtureRoot) {
  await fs.rm(fixtureRoot, { force: true, recursive: true });
}

async function runFixture(lane, fixtureData) {
  return await stage([
    "--lane",
    lane,
    "--input",
    fixtureData.inputPath,
    "--receipt",
    fixtureData.receiptPath,
    "--output",
    fixtureData.outputPath,
  ]);
}

async function reject(name, lane, fixtureData, expectedMessage) {
  const result = await runFixture(lane, fixtureData);
  assert(result.code !== 0, `${name} unexpectedly staged a release candidate.`);
  assert(
    result.stderr.includes(expectedMessage),
    `${name} did not report ${JSON.stringify(expectedMessage)}: ${result.stderr}`,
  );
  assert(
    !(await exists(fixtureData.outputPath)),
    `${name} created an output directory after rejection.`,
  );
}

async function receiptAt(receiptPath) {
  return JSON.parse(await fs.readFile(receiptPath, "utf8"));
}

async function writeReceipt(receiptPath, receipt) {
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

const packageData = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8"));
const version = packageData.version;
const { stdout } = await runFile("git", ["rev-parse", "HEAD"], { cwd: appRoot, encoding: "utf8" });
const commit = stdout.trim();
const checks = [];

try {
  const positive = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    const first = await runFixture("linux-x64-unsigned", positive);
    assert(first.code === 0, `Positive fixture failed: ${first.stderr}`);
    const manifestName = `Threadleaf-${version}-linux-x64-unsigned.release-manifest.json`;
    const firstManifestPath = path.join(positive.outputPath, manifestName);
    const firstManifest = JSON.parse(await fs.readFile(firstManifestPath, "utf8"));
    assert(firstManifest.schemaVersion === 1, "Staged manifest schema is wrong.");
    assert(firstManifest.product === "threadleaf", "Staged manifest product is wrong.");
    assert(firstManifest.version === version, "Staged manifest version is wrong.");
    assert(firstManifest.lane === "linux-x64-unsigned", "Staged manifest lane is wrong.");
    assert(firstManifest.sourceCommit === commit, "Staged manifest source commit is wrong.");
    assert(
      firstManifest.receiptSignatureStatus === "unsigned",
      "Staged manifest receipt signature status is wrong.",
    );
    assert(
      JSON.stringify(firstManifest.assets.map((asset) => asset.filename)) ===
        JSON.stringify(positive.names),
      "Staged manifest does not retain the exact asset order.",
    );
    for (const expected of positive.assets) {
      const actual = firstManifest.assets.find((asset) => asset.filename === expected.filename);
      assert(actual, `Staged manifest is missing ${expected.filename}.`);
      assert(
        actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
        `Staged manifest digest evidence is wrong for ${expected.filename}.`,
      );
    }
    assert(
      JSON.stringify((await fs.readdir(positive.outputPath)).sort()) ===
        JSON.stringify([...positive.names, manifestName].sort()),
      "Staged output contains an unexpected entry.",
    );
    for (const name of positive.names) {
      const [source, staged] = await Promise.all([
        fs.readFile(path.join(positive.inputPath, name)),
        fs.readFile(path.join(positive.outputPath, name)),
      ]);
      assert(source.equals(staged), `Staged ${name} differs from the verified input.`);
    }

    const secondOutputPath = path.join(positive.root, "output-second");
    const second = await stage([
      "--lane",
      "linux-x64-unsigned",
      "--input",
      positive.inputPath,
      "--receipt",
      positive.receiptPath,
      "--output",
      secondOutputPath,
    ]);
    assert(second.code === 0, `Second positive fixture failed: ${second.stderr}`);
    assert(
      (await fs.readFile(firstManifestPath, "utf8")) ===
        (await fs.readFile(path.join(secondOutputPath, manifestName), "utf8")),
      "Staging the same exact input produced a different manifest.",
    );
    checks.push("positive deterministic staging");

    const separatorOutputPath = path.join(positive.root, "output-separator");
    const separator = await stage([
      "--",
      "--lane",
      "linux-x64-unsigned",
      "--input",
      positive.inputPath,
      "--receipt",
      positive.receiptPath,
      "--output",
      separatorOutputPath,
    ]);
    assert(separator.code === 0, `Documented pnpm run separator form failed: ${separator.stderr}`);
    assert(
      (await fs.readFile(firstManifestPath, "utf8")) ===
        (await fs.readFile(path.join(separatorOutputPath, manifestName), "utf8")),
      "The pnpm run separator form produced a different manifest.",
    );
    checks.push("pnpm run separator form");
  } finally {
    await releaseFixture(positive.root);
  }

  const missing = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    await fs.rm(path.join(missing.inputPath, missing.names[0]));
    await reject("missing asset", "linux-x64-unsigned", missing, "must contain exactly");
    checks.push("missing asset");
  } finally {
    await releaseFixture(missing.root);
  }

  const extra = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    await fs.writeFile(path.join(extra.inputPath, "unexpected.txt"), "unexpected\n", "utf8");
    await reject("extra asset", "linux-x64-unsigned", extra, "must contain exactly");
    checks.push("extra asset");
  } finally {
    await releaseFixture(extra.root);
  }

  const stale = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    const staleName = stale.names[0].replace(version, "0.0.0-stale");
    await fs.rename(
      path.join(stale.inputPath, stale.names[0]),
      path.join(stale.inputPath, staleName),
    );
    await reject("stale-version asset", "linux-x64-unsigned", stale, "must contain exactly");
    checks.push("stale-version asset");
  } finally {
    await releaseFixture(stale.root);
  }

  const staleReceipt = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    const receipt = await receiptAt(staleReceipt.receiptPath);
    receipt.version = "0.0.0-stale";
    await writeReceipt(staleReceipt.receiptPath, receipt);
    await reject(
      "stale-version receipt",
      "linux-x64-unsigned",
      staleReceipt,
      "receipt version is stale",
    );
    checks.push("stale-version receipt");
  } finally {
    await releaseFixture(staleReceipt.root);
  }

  const directory = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    await fs.rm(path.join(directory.inputPath, directory.names[0]));
    await fs.mkdir(path.join(directory.inputPath, directory.names[0]));
    await reject("directory input", "linux-x64-unsigned", directory, "regular file");
    checks.push("directory input");
  } finally {
    await releaseFixture(directory.root);
  }

  const symlink = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    const linkPath = path.join(symlink.inputPath, symlink.names[0]);
    await fs.rm(linkPath);
    try {
      await fs.symlink(path.join(symlink.inputPath, symlink.names[1]), linkPath, "file");
      await reject("symlink input", "linux-x64-unsigned", symlink, "symlink");
      checks.push("symlink input");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) {
        throw error;
      }
      const source = await fs.readFile(stagingScript, "utf8");
      assert(source.includes("stat.isSymbolicLink()"), "Stager lacks its symlink rejection guard.");
      checks.push("symlink source guard (host lacks symlink permission)");
    }
  } finally {
    await releaseFixture(symlink.root);
  }

  const hashMismatch = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    const receipt = await receiptAt(hashMismatch.receiptPath);
    receipt.assets[0].sha256 = "0".repeat(64);
    await writeReceipt(hashMismatch.receiptPath, receipt);
    await reject("hash mismatch", "linux-x64-unsigned", hashMismatch, "SHA-256 differs");
    checks.push("hash mismatch");
  } finally {
    await releaseFixture(hashMismatch.root);
  }

  const sizeMismatch = await fixture("linux-x64-unsigned", version, commit, "unsigned");
  try {
    const receipt = await receiptAt(sizeMismatch.receiptPath);
    receipt.assets[0].bytes += 1;
    await writeReceipt(sizeMismatch.receiptPath, receipt);
    await reject("size mismatch", "linux-x64-unsigned", sizeMismatch, "size differs");
    checks.push("size mismatch");
  } finally {
    await releaseFixture(sizeMismatch.root);
  }

  const unsignedSignedLane = await fixture("macos-universal-signed", version, commit, "unsigned");
  try {
    await reject(
      "unsigned signed-lane input",
      "macos-universal-signed",
      unsignedSignedLane,
      "requires verified signature evidence",
    );
    checks.push("unsigned signed-lane input");
  } finally {
    await releaseFixture(unsignedSignedLane.root);
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  process.stdout.write(`${JSON.stringify({ verified: true, checks })}\n`);
}
