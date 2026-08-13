import { createRequire } from "node:module";
import path from "node:path";

const rootPath = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(rootPath, "package.json"));
const { acquireStateLock } = require(path.join(rootPath, "dist", "main", "private-state-lock.cjs"));

const [mode, lockPath] = process.argv.slice(2);
if (!mode || !lockPath) {
  process.stderr.write(
    "usage: state-lock-child.mjs <hold|probe|async-probe> <absolute-lock-path>\n",
  );
  process.exit(2);
}

if (mode === "probe") {
  try {
    const lock = acquireStateLock(lockPath);
    lock.close();
    process.stdout.write("ACQUIRED\n");
    process.exit(0);
  } catch (error) {
    if (error?.code === "busy") {
      process.stdout.write("BUSY\n");
      process.exit(0);
    }
    process.stderr.write(`${error?.code ?? "unknown"}: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}

if (mode === "async-probe") {
  const { acquireStateLockAsync } = require(
    path.join(rootPath, "dist", "main", "private-state-lock.cjs"),
  );
  try {
    const lock = await acquireStateLockAsync(lockPath, { timeoutMs: 80, pollIntervalMs: 10 });
    lock.close();
    process.stdout.write("ACQUIRED\n");
    process.exit(0);
  } catch (error) {
    if (error?.code === "busy") {
      process.stdout.write("BUSY\n");
      process.exit(0);
    }
    process.stderr.write(`${error?.code ?? "unknown"}: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}

if (mode !== "hold") {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}

let lock;
try {
  lock = acquireStateLock(lockPath);
  lock.assertPathIdentity();
  process.stdout.write("READY\n");
  process.stdin.resume();
  process.stdin.once("data", () => {
    try {
      lock.close();
      process.stdout.write("CLOSED\n");
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error?.code ?? "unknown"}: ${error?.message ?? error}\n`);
      process.exit(1);
    }
  });
} catch (error) {
  process.stderr.write(`${error?.code ?? "unknown"}: ${error?.message ?? error}\n`);
  process.exit(error?.code === "busy" ? 0 : 1);
}
