import { spawn } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const targetPlatform = process.env.THREADLEAF_NATIVE_TARGET_PLATFORM ?? process.platform;
const targetArchitecture = process.env.THREADLEAF_NATIVE_TARGET_ARCH ?? process.arch;

function run(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} exited ${code ?? signal}.`));
      }
    });
  });
}

await run(path.join(projectRoot, "scripts", "build-native-state-lock.mjs"), {
  THREADLEAF_NATIVE_TARGET_PLATFORM: targetPlatform,
  THREADLEAF_NATIVE_TARGET_ARCH: targetArchitecture,
});
await run(path.join(projectRoot, "scripts", "check-native-electron-target.mjs"), {
  THREADLEAF_NATIVE_TARGET_PLATFORM: targetPlatform,
  THREADLEAF_NATIVE_TARGET_ARCH: targetArchitecture,
});
