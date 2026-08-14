import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(root);
const require = createRequire(import.meta.url);

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

/**
 * Every production module in the native-extension directory, checked against the directory itself
 * so a new production file cannot quietly escape the scan by not being listed here.
 */
const productionSources = [
  "src/native-extension/digest.ts",
  "src/native-extension/errors.ts",
  "src/native-extension/grants.ts",
  "src/native-extension/host.ts",
  "src/native-extension/index.ts",
  "src/native-extension/internal-registry.ts",
  "src/native-extension/manifest.ts",
  "src/native-extension/marketplace-trust.ts",
  "src/native-extension/ports.ts",
  "src/native-extension/sdk.ts",
];
const testOnlySources = new Set(["test-access.ts", "test-support.ts"]);
const discoveredSources = (await fs.readdir(path.join(appRoot, "src", "native-extension")))
  .filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !testOnlySources.has(name),
  )
  .map((name) => `src/native-extension/${name}`)
  .sort();
if (discoveredSources.join("\n") !== [...productionSources].sort().join("\n")) {
  fail(
    `the production source scan list is stale; expected exactly:\n${discoveredSources.join("\n")}`,
  );
}

for (const productionSourcePath of productionSources) {
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

/**
 * Every shipped bundle, not only the two named for native extensions. Native-extension code can
 * reach any of them through an ordinary import, and the leak this gate exists to catch would then
 * ship in a bundle nobody was looking at.
 */
const productionBundles = [
  "cli",
  "corpus",
  "main",
  "native-extension",
  "native-extension-sdk",
  "plugin-inspection",
  "plugin-renderer",
  "preload",
  "private-state-lock",
];
const entryBlock = tsup.slice(tsup.indexOf("entry:"), tsup.indexOf("outDir:"));
const declaredEntries = [...entryBlock.matchAll(/^\s*"?([A-Za-z0-9-]+)"?:\s*"/gm)]
  .map(([, name]) => name)
  .sort();
if (declaredEntries.length === 0) {
  fail("could not read the tsup entry list, so bundle coverage cannot be verified");
}
if (declaredEntries.join(",") !== [...productionBundles].sort().join(",")) {
  fail(
    `tsup builds bundles this gate does not scan; tsup declares [${declaredEntries.join(", ")}] and the gate scans [${[...productionBundles].sort().join(", ")}]`,
  );
}

const distFiles = productionBundles.flatMap((name) => [
  `dist/main/${name}.cjs`,
  `dist/main/${name}.cjs.map`,
]);
const rendererAssetDirectory = path.join(appRoot, "dist", "renderer", "assets");
let rendererAssets = [];
try {
  rendererAssets = (await fs.readdir(rendererAssetDirectory))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `dist/renderer/assets/${name}`)
    .sort();
} catch (error) {
  fail(
    `missing renderer asset directory dist/renderer/assets: ${error instanceof Error ? error.message : error}`,
  );
}
if (rendererAssets.length === 0) {
  fail("the built renderer has no JavaScript asset to scan");
}

const artifacts = await Promise.all(
  [...distFiles, ...rendererAssets].map(async (relativePath) => [
    relativePath,
    await read(relativePath),
  ]),
);

/**
 * Each marker is a string that really appears when the matching leak happens; every one of them is
 * proven by mutating a production source and rebuilding. A marker that matches nothing is worse
 * than no marker, because the gate then reports a pass it never tested.
 */
const forbiddenArtifactText = [
  "native-extension/test-access",
  "native-extension/test-support",
  "nativeExtensionTestAccess",
  "defineNativeExtensionForTest",
  "NativeExtensionConformanceHost",
  "Native extension test entrypoint is not callable.",
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

/**
 * String markers cannot see a reachable method, so assert reachability on the built module itself.
 * TypeScript `private` is erased, which is exactly how the registration seam used to survive into
 * `dist` as a callable prototype method.
 */
let builtNativeExtension;
try {
  builtNativeExtension = require(path.join(appRoot, "dist", "main", "native-extension.cjs"));
} catch (error) {
  fail(
    `cannot load the built native-extension bundle: ${error instanceof Error ? error.message : error}`,
  );
}
const BuiltHost = builtNativeExtension.NativeExtensionHost;
if (typeof BuiltHost !== "function") {
  fail("the built native-extension bundle does not export NativeExtensionHost");
}
for (const exportName of Object.keys(builtNativeExtension)) {
  if (/testAccess|TestAccess|ForTest|ConformanceHost|HostInternals/.test(exportName)) {
    fail(`the built native-extension bundle exports test-only material: ${exportName}`);
  }
}
const builtHost = new BuiltHost({ ports: { vault: {} } });
for (const forbiddenMember of ["replaceRegistration"]) {
  if (forbiddenMember in BuiltHost.prototype || forbiddenMember in builtHost) {
    fail(
      `the built native-extension host exposes ${forbiddenMember} to any JavaScript consumer, bypassing the install mode gate`,
    );
  }
}
try {
  builtHost.register({ manifest: {}, bundleBytes: new Uint8Array() });
  fail("the built native-extension host accepted a callable registration");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("[native-extension-build-artifact]")) {
    throw error;
  }
  if (!(error && typeof error === "object" && error.code === "distribution-untrusted")) {
    fail(
      `the built native-extension host refused registration for the wrong reason: ${error instanceof Error ? error.message : error}`,
    );
  }
}
await builtHost.close();

console.log(
  `native extension build artifact gate passed over ${artifacts.length} shipped files, ${productionSources.length} production sources, and the built host surface`,
);
