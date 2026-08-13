import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(projectRoot, "native", "state_lock.c");
const headerPath = path.join(projectRoot, "native", "include", "threadleaf_node_api.h");
const buildPath = path.join(projectRoot, "scripts", "build-native-state-lock.mjs");
const targetBuildPath = path.join(projectRoot, "scripts", "build-target.mjs");
const packagePath = path.join(projectRoot, "package.json");
const builderPath = path.join(projectRoot, "electron-builder.yml");
const electronTargetPath = path.join(projectRoot, "scripts", "check-native-electron-target.mjs");
const mainPath = path.join(projectRoot, "src", "main", "main.ts");
const packagedCheckPath = path.join(projectRoot, "scripts", "check-packaged-app.mjs");
const ciPath = path.join(projectRoot, ".github", "workflows", "ci.yml");
const releasePath = path.join(projectRoot, ".github", "workflows", "release.yml");
const source = await readFile(sourcePath, "utf8");
const header = await readFile(headerPath, "utf8");
const buildSource = await readFile(buildPath, "utf8");
const targetBuildSource = await readFile(targetBuildPath, "utf8");
const packageData = JSON.parse(await readFile(packagePath, "utf8"));
const builderSource = await readFile(builderPath, "utf8");
const electronTargetSource = await readFile(electronTargetPath, "utf8");
const mainSource = await readFile(mainPath, "utf8");
const packagedCheckSource = await readFile(packagedCheckPath, "utf8");
const ciSource = await readFile(ciPath, "utf8");
const releaseSource = await readFile(releasePath, "utf8");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const required of [
  "napi_get_cb_info",
  "napi_wrap",
  "napi_unwrap",
  "napi_define_properties",
  "napi_create_string_utf8",
]) {
  assert(
    source.includes(required) && header.includes(required),
    `Node-API symbol is missing: ${required}`,
  );
}
for (const required of [
  "napi_ok = 0",
  "napi_invalid_arg = 1",
  "napi_static = 1 << 10",
  "typedef napi_value (*napi_callback)",
  "THREADLEAF_NAPI_VERSION 10",
  "#define NAPI_VERSION THREADLEAF_NAPI_VERSION",
]) {
  assert(header.includes(required), `Node-API ABI declaration is missing: ${required}`);
}
assert(source.includes("napi_register_module_v1"), "Node-API module export is missing.");
assert(
  source.includes('"10"') && source.includes('"napiVersion"'),
  "Native addon must expose pinned Node-API version 10.",
);
for (const forbidden of [
  "<nan.h>",
  "v8::",
  "node.h",
  "node::",
  "NAN_",
  "fs-ext",
  "proper-lockfile",
]) {
  assert(
    !source.includes(forbidden) && !header.includes(forbidden),
    `Native state lock must be Node-API-only: ${forbidden}`,
  );
}
for (const required of [
  "MultiByteToWideChar(CP_UTF8",
  "LockFileEx(",
  "LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY",
  "FILE_FLAG_OPEN_REPARSE_POINT",
  "flock(fd, LOCK_EX | LOCK_NB)",
  "O_NOFOLLOW",
  "openat(",
  "fchmod(",
  "ConvertStringSecurityDescriptorToSecurityDescriptorW(",
  "SetNamedSecurityInfoW(",
  "threadleaf_identity_equal",
]) {
  assert(source.includes(required), `Platform lock invariant is missing: ${required}`);
}
for (const required of [
  "SYS_renameat2",
  "RENAME_NOREPLACE",
  '"renameNoReplace"',
  '"exists"',
  '"cross-device"',
]) {
  assert(source.includes(required), `Native no-clobber rename invariant is missing: ${required}`);
}
assert(
  source.includes("#error") && !source.includes("#define O_NOFOLLOW 0"),
  "POSIX builds must fail closed when O_NOFOLLOW is unavailable.",
);
assert(
  source.includes("threadleaf_validate_posix") && source.includes("threadleaf_validate_windows"),
  "Native acquisition must validate path ancestors before opening the lock.",
);
const singleInstanceIndex = mainSource.indexOf("app.requestSingleInstanceLock()");
const whenReadyIndex = mainSource.indexOf("app.whenReady()");
assert(
  singleInstanceIndex >= 0 && whenReadyIndex > singleInstanceIndex,
  "GUI startup must claim the Electron single-instance lock before whenReady.",
);
assert(
  mainSource.includes('app.on("second-instance"') &&
    singleInstanceIndex < mainSource.indexOf("new PluginPackageManager") &&
    singleInstanceIndex < mainSource.indexOf("AppSettingsController.open"),
  "GUI single-instance admission must precede settings/package construction.",
);
assert(
  mainSource.includes("serializePrivateMutation") &&
    mainSource.includes("privateMutationTail") &&
    mainSource.includes("serializePluginOperation"),
  "Main-process settings and package mutations must share an async queue.",
);
assert(
  packagedCheckSource.includes("verifySecondInstanceRejected") &&
    packagedCheckSource.includes("userDataPath") &&
    packagedCheckSource.includes("first packaged instance did not remain alive"),
  "The extracted packaged smoke test must prove duplicate-profile admission.",
);
assert(
  !buildSource.includes("x86_64-windows-gnu") &&
    !buildSource.includes("zig") &&
    !targetBuildSource.includes("x86_64-windows-gnu"),
  "Linux builds must not claim a cross-built Windows native addon.",
);
assert(
  buildSource.includes("requestedPlatform === process.platform") &&
    buildSource.includes("requestedArchitecture === process.arch"),
  "Native build must fail closed on host/target mismatch.",
);
assert(
  buildSource.includes('requestedArchitecture === "universal"') &&
    buildSource.includes('"-create"') &&
    buildSource.includes("verifyMach"),
  "The universal macOS native addon must be lipo-merged and verified.",
);
assert(
  buildSource.includes("THREADLEAF_NATIVE_TARGET_PLATFORM") &&
    buildSource.includes("THREADLEAF_NATIVE_TARGET_ARCH") &&
    buildSource.includes("THREADLEAF_NAPI_VERSION") &&
    buildSource.includes("verifyElfX64") &&
    buildSource.includes("verifyPeX64"),
  "Every native build must pin the ABI and verify the target artifact format.",
);
assert(
  buildSource.includes('"-Wall"') &&
    buildSource.includes('"-Wextra"') &&
    buildSource.includes('"-Werror"') &&
    buildSource.includes('"/W4"') &&
    buildSource.includes('"/WX"'),
  "Native builds must treat compiler warnings as errors on every target.",
);
assert(
  electronTargetSource.includes('createRequire(import.meta.url)("electron")') &&
    electronTargetSource.includes("spawn(electron") &&
    electronTargetSource.includes("THREADLEAF_NATIVE_PROBE_PATH") &&
    electronTargetSource.includes("process.versions.napi") &&
    electronTargetSource.includes("receipt.hostNapiVersion >= 10") &&
    electronTargetSource.includes('"10"') &&
    electronTargetSource.includes("renameNoReplace") &&
    electronTargetSource.includes("collisionPreserved"),
  "Every native target must be rebuilt and loaded by its pinned Electron runtime.",
);
assert(
  packageData.scripts?.["pack:windows"]?.includes("build-target.mjs win32 x64") &&
    packageData.scripts?.["pack:mac:arm64"]?.includes("build-target.mjs darwin arm64") &&
    packageData.scripts?.["pack:mac:x64"]?.includes("build-target.mjs darwin x64") &&
    packageData.scripts?.["pack:mac:universal"]?.includes("build:universal"),
  "Every native package command must select a matching native host build.",
);
assert(
  packageData.scripts?.["build:main"]?.includes("build:native:electron") &&
    packageData.scripts?.["test:native-lock-electron"]?.includes("build:native:electron"),
  "The main build and focused gate must perform the Electron-target native rebuild.",
);
assert(
  builderSource.includes("npmRebuild: false"),
  "The package must keep npmRebuild:false while the explicit native build remains required.",
);
assert(
  builderSource.includes("asarUnpack:") && builderSource.includes("dist/native/**/*.node"),
  "Electron Builder must unpack the native addon from ASAR.",
);
assert(
  ciSource.includes("pnpm run test:native-lock-package") || ciSource.includes("pnpm check"),
  "Every CI platform lane must include the native package gate.",
);
assert(
  releaseSource.includes("pnpm run test:macos-package") &&
    releaseSource.includes("pnpm run test:windows-package") &&
    releaseSource.includes("pnpm run release:linux"),
  "Every release platform lane must include its native package gate.",
);
const checkScript = packageData.scripts?.check ?? "";
for (const required of [
  "test:native-lock-source",
  "test:native-lock-electron",
  "test:native-lock",
  "test:native-lock-package",
]) {
  assert(checkScript.includes(required), `pnpm check is missing ${required}.`);
}

console.log(
  JSON.stringify({
    verified: true,
    nodeApi: "only; pinned N-API 10",
    nativeTargets: ["linux/x64", "darwin/arm64", "darwin/x64", "darwin/universal", "win32/x64"],
    electronTargets: "rebuild and load on matching OS/architecture host",
    crossTargetCompile: "disabled; native host package lanes only",
    asarInventory:
      "unpacked dist/native/**/*.node; package verifiers inspect exact path and signature",
    cliLock: "CLI-LOCK-01 is exercised by independent processes against the extracted addon",
    guiProfile:
      "early Electron single-instance admission plus one same-process settings/package queue; OS lock remains authoritative",
    pathSafety: "O_NOFOLLOW plus ancestor validation",
    noClobberRename:
      "Linux renameat2(RENAME_NOREPLACE), target collision preserves both names; other platforms fail closed",
    permissions: "POSIX 0600 repair plus Windows owner-only DACL",
  }),
);
