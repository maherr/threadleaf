import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(root);

function fail(message) {
  throw new Error(`[native-extension-build-artifact] ${message}`);
}

async function read(relativePath) {
  try {
    return await fs.readFile(path.join(appRoot, relativePath), "utf8");
  } catch (error) {
    fail(
      `missing build input or artifact ${relativePath}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

const tsup = await read("tsup.config.ts");
for (const forbiddenEntry of [
  "src/native-extension/test-access.ts",
  "src/native-extension/test-support.ts",
]) {
  if (tsup.includes(forbiddenEntry)) {
    fail(`test-only source is configured as a build entry: ${forbiddenEntry}`);
  }
}

const packageJson = JSON.parse(await read("package.json"));
const serializedExports = JSON.stringify(packageJson.exports ?? {});
for (const forbiddenExport of ["test-support", "test-access", "defineNativeExtensionForTest"]) {
  if (serializedExports.includes(forbiddenExport)) {
    fail(`test-only symbol is package-exported: ${forbiddenExport}`);
  }
}

const publicNativeExtensionIndex = await read("src/native-extension/index.ts");
for (const forbiddenPublicReference of [
  "./test-support",
  "./test-access",
  "defineNativeExtensionForTest",
  "nativeExtensionTestAccess",
]) {
  if (publicNativeExtensionIndex.includes(forbiddenPublicReference)) {
    fail(
      `the public native-extension index references test-only material: ${forbiddenPublicReference}`,
    );
  }
}

for (const productionSourcePath of [
  "src/native-extension/digest.ts",
  "src/native-extension/errors.ts",
  "src/native-extension/host.ts",
  "src/native-extension/index.ts",
  "src/native-extension/manifest.ts",
  "src/native-extension/marketplace-trust.ts",
  "src/native-extension/ports.ts",
  "src/native-extension/sdk.ts",
]) {
  const source = await read(productionSourcePath);
  for (const forbiddenReference of [
    "./test-support",
    "./test-access",
    "defineNativeExtensionForTest",
    "nativeExtensionTestAccess",
  ]) {
    if (source.includes(forbiddenReference)) {
      fail(`${productionSourcePath} references test-only source: ${forbiddenReference}`);
    }
  }
}

const distFiles = [
  "dist/main/native-extension.cjs",
  "dist/main/native-extension-sdk.cjs",
  "dist/main/main.cjs",
  "dist/main/cli.cjs",
  "dist/main/native-extension.cjs.map",
  "dist/main/native-extension-sdk.cjs.map",
  "dist/main/main.cjs.map",
  "dist/main/cli.cjs.map",
];
const artifacts = await Promise.all(
  distFiles.map(async (relativePath) => [relativePath, await read(relativePath)]),
);
const forbiddenArtifactText = [
  "native-extension/test-access",
  "native-extension/test-support",
  "nativeExtensionTestAccess",
  "defineNativeExtensionForTest",
  "NativeExtensionConformanceHost",
  "Function-injected native extension registration",
];
for (const [relativePath, source] of artifacts) {
  for (const marker of forbiddenArtifactText) {
    if (source.includes(marker)) {
      fail(`${relativePath} contains test-only build material: ${marker}`);
    }
  }
}

const productionSdk =
  artifacts.find(([relativePath]) => relativePath.endsWith("native-extension-sdk.cjs"))?.[1] ?? "";
if (productionSdk.includes("options.entrypoint") || productionSdk.includes("entrypoint: bundle")) {
  fail("the byte-only production SDK artifact contains a callable entrypoint field");
}

console.log("native-extension build artifact gate passed");
