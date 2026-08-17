import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const forbiddenControllerImport =
  /(?:from\s*["'][^"']*level4-(?:controller|verifier|operator|receipt-boundary|receipts)|import\s*\(\s*["'][^"']*level4-(?:controller|verifier|operator|receipt-boundary|receipts)|require\s*\(\s*["'][^"']*level4-(?:controller|verifier|operator|receipt-boundary|receipts))/u;
const forbiddenPromotion =
  /(?:compatibilityLevel\s*[:=]\s*4|level4Receipt\s*[:=]|terminalState\s*[:=]\s*["'](?:completed|canceled|failed|timed-out)["'])/u;

function fail(message) {
  throw new Error(`Level 4 structural boundary: ${message}`);
}

async function filesUnder(rootPath) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (
        entry.isFile() &&
        !/\.test\./u.test(entry.name) &&
        /\.(?:ts|tsx|js|mjs|cjs)$/u.test(entry.name)
      )
        result.push(child);
    }
  }
  await visit(rootPath);
  return result;
}

export async function checkLevel4Boundary({ sourceRoots, builtRoots = [] }) {
  const files = [];
  for (const root of [...sourceRoots, ...builtRoots]) {
    try {
      files.push(...(await filesUnder(root)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const relative = path.relative(repositoryRoot, filePath);
    if (forbiddenControllerImport.test(source))
      fail(`${relative} imports a controller, verifier, or operator module.`);
    if (forbiddenPromotion.test(source))
      fail(`${relative} can author a Level 4 terminal or registry state.`);
  }
  return { files: files.length };
}

async function main() {
  const productionRoots = [
    path.join(repositoryRoot, "src", "runtime"),
    path.join(repositoryRoot, "src", "application"),
    path.join(repositoryRoot, "src", "main"),
    path.join(repositoryRoot, "src", "renderer"),
    path.join(repositoryRoot, "src", "plugin-renderer"),
  ];
  const builtRoots = [path.join(repositoryRoot, "dist")];
  const production = await checkLevel4Boundary({ sourceRoots: productionRoots, builtRoots });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-level4-boundary-"));
  await fs.chmod(temporaryRoot, 0o700);
  try {
    const safePath = path.join(temporaryRoot, "safe.ts");
    await fs.writeFile(safePath, "export const observed = true;\n", { mode: 0o600 });
    await checkLevel4Boundary({ sourceRoots: [temporaryRoot] });
    for (const [name, source] of [
      [
        "mutated-import.ts",
        "import { finalizeLevel4Receipt } from '../scripts/compatibility/level4-controller.mjs';\n",
      ],
      [
        "mutated-require.cjs",
        "const { finalizeLevel4Receipt } = require('../scripts/compatibility/level4-controller.mjs');\n",
      ],
      [
        "mutated-boundary.ts",
        "import { createLevel4ReceiptEnvelopeV2 } from '../src/shared/level4-receipt-boundary.mjs';\n",
      ],
    ]) {
      const mutationPath = path.join(temporaryRoot, name);
      await fs.writeFile(mutationPath, source, { mode: 0o600 });
      let rejected = false;
      try {
        await checkLevel4Boundary({ sourceRoots: [temporaryRoot] });
      } catch {
        rejected = true;
      }
      if (!rejected) fail(`positive ${name} mutation control was not rejected.`);
      await fs.unlink(mutationPath);
    }
    process.stdout.write(
      `LEVEL4_BOUNDARY PASS: production_files=${production.files} positive_mutation=true\n`,
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("check-level4-boundary.mjs")
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
