import { spawn } from "node:child_process";

const [targetPlatform, targetArchitecture] = process.argv.slice(2);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  (targetPlatform === "linux" && targetArchitecture === "x64") ||
    (targetPlatform === "win32" && targetArchitecture === "x64") ||
    (targetPlatform === "darwin" && ["arm64", "x64", "universal"].includes(targetArchitecture)),
  "Usage: build-target.mjs <linux|win32|darwin> <x64|arm64|universal>.",
);
assert(
  process.platform === targetPlatform,
  `Refusing to build a ${targetPlatform}/${targetArchitecture} package on ${process.platform}/${process.arch}. Native package builds require the target operating system host.`,
);
if (targetArchitecture !== "universal") {
  assert(
    process.arch === targetArchitecture,
    `Refusing to build a ${targetPlatform}/${targetArchitecture} package on ${process.platform}/${process.arch}. Native package builds require the target architecture host.`,
  );
}
if (targetArchitecture === "universal") {
  assert(targetPlatform === "darwin", "Only macOS can produce a universal native addon package.");
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpm, ["run", "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    THREADLEAF_NATIVE_TARGET_PLATFORM: targetPlatform,
    THREADLEAF_NATIVE_TARGET_ARCH: targetArchitecture,
  },
});

const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
process.exitCode = exit;
