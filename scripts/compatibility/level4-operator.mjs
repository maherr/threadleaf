import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLevel4TrustPolicyV1 } from "../../src/shared/level4-receipt-boundary.mjs";
import { readJsonFile } from "./level4-artifacts.mjs";
import { verifyLevel4Receipt } from "./level4-verifier.mjs";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultPolicyPath = path.join(
  rootPath,
  "scripts",
  "compatibility",
  "trust",
  "level4-trust-policy.v1.json",
);

function fail(message, code = 1) {
  process.stderr.write(`Level 4 operator: ${message}\n`);
  process.exitCode = code;
}

function usage() {
  process.stdout.write(
    "Usage: node scripts/compatibility/level4-operator.mjs status [--policy PATH]\n" +
      "       node scripts/compatibility/level4-operator.mjs verify --config PATH\n",
  );
}

async function status(policyPath) {
  const policy = parseLevel4TrustPolicyV1(await readJsonFile(policyPath, "Level 4 trust policy"));
  const activeIssuerCount = policy.issuerKeys.filter((key) => key.status === "active").length;
  const result = {
    configured: activeIssuerCount === 1,
    productionIssuer: activeIssuerCount === 1 ? "configured" : "absent",
    activeIssuerCount,
    trustStoreVersion: policy.trustStoreVersion,
    trustedControllerManifestId: policy.trustedControllerManifest.manifestId,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (activeIssuerCount === 0) process.exitCode = 2;
  if (activeIssuerCount > 1) process.exitCode = 3;
}

async function verify(configPath) {
  const config = await readJsonFile(configPath, "Level 4 verifier config");
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    typeof config.receiptPath !== "string" ||
    !config.artifactPaths ||
    !config.expected
  ) {
    fail(
      "verify config must contain explicit receiptPath, artifactPaths, and expected current inputs.",
    );
    return;
  }
  const result = await verifyLevel4Receipt(config);
  process.stdout.write(
    `${JSON.stringify({
      verified: true,
      receiptFileSha256: result.receiptFileSha256,
      verificationTupleDigest: result.verificationTupleDigest,
      replay: result.replay,
    })}\n`,
  );
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "status") {
    const policyFlag = args.indexOf("--policy");
    await status(policyFlag >= 0 ? path.resolve(args[policyFlag + 1]) : defaultPolicyPath);
  } else if (command === "verify") {
    const configFlag = args.indexOf("--config");
    if (configFlag < 0 || !args[configFlag + 1]) {
      fail("verify requires --config PATH.");
    } else {
      await verify(path.resolve(args[configFlag + 1]));
    }
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
