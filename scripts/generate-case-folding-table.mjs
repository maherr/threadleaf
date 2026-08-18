import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Pinned, offline source. Never fetched over the network. Regeneration uses a
// matching host Unicode Character Database when one is installed; source-less
// hosts still verify the exact committed output against its pinned digest.
const sourceCandidates = [
  "/usr/share/unicode/ucd/CaseFolding.txt",
  "/usr/share/unicode/CaseFolding.txt",
];
const pinnedUnicodeVersion = "17.0.0";
const pinnedSourceSha256 = "ff8d8fefbf123574205085d6714c36149eb946d717a0c585c27f0f4ef58c4183";
const pinnedOutputSha256 = "b9f957a40a74270c79374e1d4f9907676e8c24d0e4820f496690d369e9b02cea";
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(rootPath, "src", "generated", "case-folding-table.ts");
const checkOnly = process.argv.includes("--check");

// <code>; <status>; <mapping>; # <name>
const entryPattern = /^([0-9A-F]+); ([A-Z]); ([0-9A-F]+(?: [0-9A-F]+)*); # .*$/u;
const versionPattern = /^# CaseFolding-(\d+\.\d+\.\d+)\.txt\s*$/u;
const datePattern = /^# Date: (\d{4}-\d{2}-\d{2}),/u;

function fail(message) {
  throw new Error(`Case folding table: ${message}`);
}

async function readSource() {
  for (const sourcePath of sourceCandidates) {
    try {
      const bytes = await fs.readFile(sourcePath);
      return {
        sourcePath,
        text: bytes.toString("utf8"),
        sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        fail(
          `could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return null;
}

function parseSource(text, sourceSha256) {
  const lines = text.split("\n");
  let unicodeVersion = null;
  let unicodeDate = null;
  /** @type {Map<number, number>} */
  const byCodePoint = new Map();
  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine.trimEnd();
    if (unicodeVersion === null) {
      const versionMatch = versionPattern.exec(line);
      if (versionMatch?.[1]) {
        unicodeVersion = versionMatch[1];
      }
    }
    if (unicodeDate === null) {
      const dateMatch = datePattern.exec(line);
      if (dateMatch?.[1]) {
        unicodeDate = dateMatch[1];
      }
    }
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = entryPattern.exec(line);
    if (!match) {
      fail(`unrecognized line ${lineIndex + 1}: ${JSON.stringify(rawLine)}`);
    }
    const [, codeHex, status, mappingHex] = match;
    if (status !== "C" && status !== "S") {
      // Full (F) and Turkic (T) mappings are intentionally excluded. Per the
      // file's own usage note: "To do a simple case folding, use the
      // mappings with status C + S."
      continue;
    }
    const mappingParts = mappingHex.split(" ");
    if (mappingParts.length !== 1) {
      // Common and Simple case-fold mappings are single code points by
      // definition (only Full mappings grow in length); a multi-code-point
      // C/S mapping would mean this file no longer matches the pinned
      // Unicode 17 shape this generator was written against.
      fail(
        `status ${status} mapping for U+${codeHex} has ${mappingParts.length} code points; ` +
          "expected exactly one.",
      );
    }
    const codePoint = Number.parseInt(codeHex, 16);
    const mappedCodePoint = Number.parseInt(mappingParts[0], 16);
    if (byCodePoint.has(codePoint)) {
      fail(`duplicate C/S entry for U+${codeHex}.`);
    }
    byCodePoint.set(codePoint, mappedCodePoint);
  }
  if (!unicodeVersion) {
    fail("could not find a '# CaseFolding-X.Y.Z.txt' version header.");
  }
  if (unicodeVersion !== pinnedUnicodeVersion) {
    fail(`expected Unicode ${pinnedUnicodeVersion}, received Unicode ${unicodeVersion}.`);
  }
  if (sourceSha256 !== pinnedSourceSha256) {
    fail(`expected source SHA-256 ${pinnedSourceSha256}, received ${sourceSha256}.`);
  }
  if (!unicodeDate) {
    fail("could not find a '# Date: YYYY-MM-DD' header.");
  }
  if (byCodePoint.size === 0) {
    fail("parsed zero Common/Simple entries.");
  }
  // Sort explicitly by code point. The generated output must not depend on
  // Map or Set iteration order, so every consumer of `byCodePoint` below
  // walks this sorted array rather than the map itself.
  const sortedEntries = [...byCodePoint.entries()].sort(([left], [right]) => left - right);
  return { unicodeVersion, unicodeDate, sourceSha256, sortedEntries };
}

function hex(codePoint) {
  return `0x${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function typeScriptFor({ unicodeVersion, unicodeDate, sourceSha256, sortedEntries }) {
  const codePoints = sortedEntries.map(([codePoint]) => hex(codePoint)).join(", ");
  const mappedCodePoints = sortedEntries.map(([, mapped]) => hex(mapped)).join(", ");
  return `// Generated by scripts/generate-case-folding-table.mjs. Do not edit by hand.
// Source: local Unicode Character Database (CaseFolding-${unicodeVersion}.txt, ${unicodeDate}).
// Source SHA-256: ${sourceSha256}.
// Regenerate with: node scripts/generate-case-folding-table.mjs
//
// Common (C) + Simple (S) status entries only: "To do a simple case
// folding, use the mappings with status C + S" (CaseFolding.txt usage
// note). Full (F) mappings that grow a string in length (for example sharp
// s to "ss") and Turkic (T) dotted/dotless I remapping are intentionally
// excluded, so every entry here maps exactly one code point to exactly one
// code point and a code point not present here folds to itself.

/** Unicode Character Database version this table was generated from. */
export const caseFoldingUnicodeVersion = "${unicodeVersion}" as const;

/** SHA-256 of the exact local CaseFolding.txt source bytes. */
export const caseFoldingSourceSha256 = "${sourceSha256}" as const;

/**
 * Source code points with a Common or Simple case-fold mapping, strictly
 * ascending. Index-aligned with {@link caseFoldingTargets}.
 */
export const caseFoldingCodePoints: readonly number[] = [${codePoints}];

/**
 * Folded code point for the source code point at the same index in
 * {@link caseFoldingCodePoints}.
 */
export const caseFoldingTargets: readonly number[] = [${mappedCodePoints}];
`;
}

async function assertCurrent(expected) {
  let actual;
  try {
    actual = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    fail(
      `${path.relative(rootPath, outputPath)} is missing: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actual !== expected) {
    fail(
      `${path.relative(rootPath, outputPath)} is stale. Run node scripts/generate-case-folding-table.mjs.`,
    );
  }
}

const source = await readSource();
if (source === null) {
  if (!checkOnly) {
    fail(
      `could not find CaseFolding.txt in ${sourceCandidates.join(" or ")}. ` +
        "Generation requires a local Unicode Character Database and never fetches it over the network.",
    );
  }
  const output = await fs.readFile(outputPath);
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  if (outputSha256 !== pinnedOutputSha256) {
    fail(
      `${path.relative(rootPath, outputPath)} digest is stale; expected ${pinnedOutputSha256}, ` +
        `received ${outputSha256}. Verify it on a host with Unicode ${pinnedUnicodeVersion} data.`,
    );
  }
  process.stdout.write(
    `Verified the pinned Unicode ${pinnedUnicodeVersion} case folding artifact without host UCD data.\n`,
  );
} else {
  const parsed = parseSource(source.text, source.sourceSha256);
  const output = typeScriptFor(parsed);
  const outputSha256 = createHash("sha256").update(output).digest("hex");
  if (outputSha256 !== pinnedOutputSha256) {
    fail(
      `generated output digest is stale; expected ${pinnedOutputSha256}, received ${outputSha256}.`,
    );
  }
  if (checkOnly) {
    await assertCurrent(output);
  } else {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, output, "utf8");
  }
  process.stdout.write(
    `${checkOnly ? "Verified" : "Generated"} ${parsed.sortedEntries.length} Common/Simple case folding ` +
      `entries from Unicode ${parsed.unicodeVersion} at ${source.sourcePath}.\n`,
  );
}
