import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(projectRoot, "native", "state_lock.c");
const outputDirectory = path.join(projectRoot, "dist", "native");
const outputPath = path.join(outputDirectory, "threadleaf-state-lock.node");
const includeDirectory = path.join(projectRoot, "native");
const windowsBuildDirectory = path.join(includeDirectory, "windows");
const requestedPlatform = process.env.THREADLEAF_NATIVE_TARGET_PLATFORM ?? process.platform;
const requestedArchitecture = process.env.THREADLEAF_NATIVE_TARGET_ARCH ?? process.arch;
const THREADLEAF_NAPI_VERSION = 10;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, ...options.env },
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    const stdout = [];
    const stderr = [];
    if (options.capture) {
      child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    }
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

async function commandExists(command) {
  if (path.isAbsolute(command)) {
    try {
      await access(command);
      return true;
    } catch {
      return false;
    }
  }
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    try {
      await access(path.join(directory, command));
      return true;
    } catch {
      // Keep looking through toolchain candidates.
    }
  }
  return false;
}

function assertTargetHost() {
  assert(
    ["linux", "darwin", "win32"].includes(requestedPlatform),
    `Unsupported native state-lock target platform: ${requestedPlatform}.`,
  );
  assert(
    requestedPlatform === process.platform,
    `Refusing to build a ${requestedPlatform}/${requestedArchitecture} native addon on ${process.platform}/${process.arch}.`,
  );
  if (requestedArchitecture === "universal") {
    assert(
      requestedPlatform === "darwin",
      "Only macOS can produce a universal native state-lock addon.",
    );
    return;
  }
  assert(
    ["x64", "arm64"].includes(requestedArchitecture),
    `Unsupported native state-lock target architecture: ${requestedArchitecture}.`,
  );
  assert(
    requestedArchitecture === process.arch,
    `Refusing to build a ${requestedPlatform}/${requestedArchitecture} native addon on ${process.platform}/${process.arch}.`,
  );
  if (requestedPlatform === "linux" || requestedPlatform === "win32") {
    assert(
      requestedArchitecture === "x64",
      `${requestedPlatform} native state-lock packages are x64-only.`,
    );
  }
}

async function buildWindows(output) {
  const packageData = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const electronVersion = packageData.devDependencies?.electron;
  assert(
    typeof electronVersion === "string" && /^\d+\.\d+\.\d+$/u.test(electronVersion),
    "Windows native state-lock builds require an exact Electron development dependency.",
  );
  const nodeGyp = createRequire(import.meta.url).resolve("node-gyp/bin/node-gyp.js");
  const developmentDirectory = path.join(
    projectRoot,
    "node_modules",
    ".cache",
    "threadleaf-electron-gyp",
  );
  await run(process.execPath, [
    nodeGyp,
    "rebuild",
    `--target=${electronVersion}`,
    "--arch=x64",
    "--dist-url=https://electronjs.org/headers",
    `--devdir=${developmentDirectory}`,
    `--directory=${windowsBuildDirectory}`,
  ]);
  await copyFile(
    path.join(windowsBuildDirectory, "build", "Release", "threadleaf_state_lock.node"),
    output,
  );
}

async function buildMac(output, architecture) {
  const compiler = process.env.CC ?? "clang";
  assert(await commandExists(compiler), `Could not find the macOS C compiler ${compiler}.`);
  await run(compiler, [
    "-dynamiclib",
    "-arch",
    architecture,
    "-fPIC",
    "-O2",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fvisibility=hidden",
    `-I${includeDirectory}`,
    "-undefined",
    "dynamic_lookup",
    sourcePath,
    "-o",
    output,
  ]);
}

async function buildLinux(output) {
  const compiler = process.env.CC ?? "cc";
  assert(await commandExists(compiler), `Could not find the Linux C compiler ${compiler}.`);
  await run(compiler, [
    "-shared",
    "-fPIC",
    "-O2",
    "-std=c11",
    "-D_POSIX_C_SOURCE=200809L",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fvisibility=hidden",
    `-I${includeDirectory}`,
    sourcePath,
    "-o",
    output,
  ]);
}

async function verifyElfX64(output) {
  const bytes = await readFile(output);
  assert(
    bytes.length >= 20 &&
      bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      bytes[4] === 2 &&
      bytes.readUInt16LE(18) === 62,
    "Linux native state-lock output is not an ELF x64 addon.",
  );
}

async function verifyPeX64(output) {
  const bytes = await readFile(output);
  const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : -1;
  assert(
    bytes.length >= peOffset + 6 &&
      bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from("PE\0\0", "ascii")) &&
      bytes.readUInt16LE(peOffset + 4) === 0x8664,
    "Windows native state-lock output is not a PE x64 addon.",
  );
}

async function verifyMach(output, expectedArchitectures) {
  const lipo = process.env.LIPO ?? "lipo";
  assert(await commandExists(lipo), "macOS universal/native builds require lipo.");
  const result = await run(lipo, ["-archs", output], { capture: true });
  const actual = new Set(result.stdout.trim().split(/\s+/u).filter(Boolean));
  assert(
    actual.size === expectedArchitectures.size &&
      [...expectedArchitectures].every((architecture) => actual.has(architecture)),
    `macOS native state-lock output has architectures ${[...actual].join(", ")}; expected ${[
      ...expectedArchitectures,
    ].join(", ")}.`,
  );
}

await access(sourcePath);
await mkdir(outputDirectory, { recursive: true });
assert(THREADLEAF_NAPI_VERSION === 10, "The native addon ABI pin must remain N-API version 10.");
assertTargetHost();
await rm(outputPath, { force: true });

const temporaryOutputs = [];
try {
  if (requestedPlatform === "win32") {
    await buildWindows(outputPath);
    await verifyPeX64(outputPath);
  } else if (requestedPlatform === "darwin") {
    if (requestedArchitecture === "universal") {
      const temporaryDirectory = path.join(outputDirectory, `.universal-${process.pid}`);
      const armOutput = path.join(temporaryDirectory, "threadleaf-state-lock-arm64.node");
      const x64Output = path.join(temporaryDirectory, "threadleaf-state-lock-x64.node");
      temporaryOutputs.push(temporaryDirectory);
      await mkdir(temporaryDirectory, { recursive: true });
      await buildMac(armOutput, "arm64");
      await buildMac(x64Output, "x86_64");
      const lipo = process.env.LIPO ?? "lipo";
      assert(await commandExists(lipo), "macOS universal builds require lipo.");
      await run(lipo, ["-create", "-output", outputPath, armOutput, x64Output]);
      await verifyMach(outputPath, new Set(["arm64", "x86_64"]));
    } else {
      await buildMac(outputPath, requestedArchitecture === "x64" ? "x86_64" : "arm64");
      await verifyMach(
        outputPath,
        new Set([requestedArchitecture === "x64" ? "x86_64" : requestedArchitecture]),
      );
    }
  } else {
    await buildLinux(outputPath);
    await verifyElfX64(outputPath);
  }
} finally {
  for (const temporaryDirectory of temporaryOutputs) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await access(outputPath);
console.log(
  JSON.stringify({
    built: true,
    hostPlatform: process.platform,
    hostArchitecture: process.arch,
    targetPlatform: requestedPlatform,
    targetArchitecture: requestedArchitecture,
    output: path.relative(projectRoot, outputPath),
    abi: "Node-API",
    warningsAsErrors: true,
    npmRebuild: false,
  }),
);
