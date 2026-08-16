import { spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

const projectRoot = path.resolve(import.meta.dirname, "..");
const nativePath = path.join(projectRoot, "dist", "native", "threadleaf-state-lock.node");
const builderPath = path.join(projectRoot, "electron-builder.yml");
const packagePath = path.join(projectRoot, "package.json");
const platformPackageChecks = [
  path.join(projectRoot, "scripts", "check-linux-packages.mjs"),
  path.join(projectRoot, "scripts", "check-macos-package.mjs"),
  path.join(projectRoot, "scripts", "check-windows-package.mjs"),
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await access(nativePath);
const builder = parse(await readFile(builderPath, "utf8"));
const packageData = JSON.parse(await readFile(packagePath, "utf8"));
const platformPackageCheckSources = await Promise.all(
  platformPackageChecks.map((filePath) => readFile(filePath, "utf8")),
);
const unpacked = builder.asarUnpack ?? [];
assert(
  unpacked.includes("dist/native/**/*.node"),
  "Electron packaging must unpack the Node-API state-lock addon.",
);
assert(
  packageData.exports?.["./private-state-lock"]?.default === "./dist/main/private-state-lock.cjs",
  "The reusable state-lock package export is missing.",
);
assert(
  packageData.scripts?.["test:native-lock"]?.includes("check-state-lock.mjs"),
  "The separate-child-process native lock smoke hook is missing.",
);
assert(
  packageData.scripts?.["test:native-lock-source"]?.includes("check-native-lock-source.mjs"),
  "The native source/ABI smoke hook is missing.",
);
assert(
  platformPackageCheckSources.every((source) => source.includes("threadleaf-state-lock.node")),
  "Every platform package smoke check must assert the unpacked native state-lock addon.",
);
assert(
  platformPackageCheckSources.every(
    (source) =>
      source.includes("check-extracted-native-lock.mjs") && source.includes("--native-lock-probe"),
  ),
  "Every platform package verifier must load and exercise the extracted native addon in an independent process.",
);
assert(
  platformPackageCheckSources.some((source) => source.includes("codesign")) &&
    platformPackageCheckSources.some((source) => source.includes("Get-AuthenticodeSignature")),
  "macOS and Windows package verifiers must retain signed native-artifact inventory checks.",
);

const packageRoot = await realpath(
  await mkdtemp(path.join(os.tmpdir(), "threadleaf-native-package-")),
);
try {
  const resourcesPath = path.join(packageRoot, "resources");
  const packagedNativePath = path.join(
    resourcesPath,
    "app.asar.unpacked",
    "dist",
    "native",
    "threadleaf-state-lock.node",
  );
  await mkdir(path.dirname(packagedNativePath), { recursive: true });
  await cp(nativePath, packagedNativePath);
  await writeFile(path.join(resourcesPath, "app.asar"), "packaged marker\n", "utf8");
  const hostileOverride = path.join(packageRoot, "hostile-override.js");
  await writeFile(hostileOverride, 'throw new Error("packaged override was loaded");\n', "utf8");
  const lockPath = path.join(packageRoot, "state.lock");
  const modulePath = path.join(projectRoot, "dist", "main", "private-state-lock.cjs");
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(resourcesPath)} }); Object.defineProperty(process, "defaultApp", { value: false }); const api = require(${JSON.stringify(modulePath)}); const lock = api.acquireStateLock(${JSON.stringify(lockPath)}); lock.assertPathIdentity(); lock.close();`,
    ],
    {
      cwd: os.tmpdir(),
      encoding: "utf8",
      env: { ...process.env, THREADLEAF_STATE_LOCK_NATIVE: hostileOverride },
    },
  );
  assert(
    probe.status === 0,
    `The simulated ASAR-unpacked native addon did not load: ${probe.stdout}${probe.stderr}`,
  );
  assert(
    (await stat(lockPath)).isFile(),
    "The packaged native lock smoke did not create a regular file.",
  );
  const extractedProbe = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "scripts", "check-extracted-native-lock.mjs"),
      packagedNativePath,
      process.platform,
      process.arch,
    ],
    { cwd: projectRoot, encoding: "utf8" },
  );
  assert(
    extractedProbe.status === 0,
    `CLI-LOCK-01 extracted package proof failed: ${extractedProbe.stdout}${extractedProbe.stderr}`,
  );
  const extractedReceipt = JSON.parse(extractedProbe.stdout.trim());
  assert(
    extractedReceipt.anonymousExactBytes &&
      extractedReceipt.anonymousCollisionPreserved &&
      extractedReceipt.anonymousNoStage,
    "The extracted package did not prove anonymous exact-byte no-clobber publication.",
  );
  console.log(
    JSON.stringify({
      verified: true,
      nativeAddon: "dist/native/threadleaf-state-lock.node",
      asarUnpack: "dist/native/**/*.node",
      runtimeResolution: "simulated resources/app.asar.unpacked from unrelated cwd",
      packagedOverride: "ignored",
      cliLock01: "independent-process extracted addon proof",
      anonymousPublication: extractedReceipt.anonymousPublish,
      runtimePlatforms: "Linux focused locally; macOS and Windows require native CI",
    }),
  );
} finally {
  await rm(packageRoot, { recursive: true, force: true });
}
