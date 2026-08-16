import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicSpecPath = path.join(rootPath, "public-spec");
const dataPath = path.join(publicSpecPath, "data");
const schemaPath = path.join(publicSpecPath, "schemas");
const sitePath = path.join(publicSpecPath, "site");
const sourcePath = path.join(publicSpecPath, "v1");
const packageJsonPath = path.join(rootPath, "package.json");

function fail(message) {
  throw new Error(`Public specification check: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    fail(
      `cannot read ${path.relative(rootPath, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(
      `cannot parse ${path.relative(rootPath, filePath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function isFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isPath(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativePath(filePath) {
  return path.relative(rootPath, filePath).replaceAll(path.sep, "/");
}

function localTarget(filePath, href) {
  const withoutHash = href.split("#", 1)[0].split("?", 1)[0];
  if (!withoutHash || /^[a-z][a-z0-9+.-]*:/iu.test(withoutHash) || withoutHash.startsWith("//"))
    return null;
  return path.resolve(path.dirname(filePath), withoutHash);
}

function anchorFor(heading) {
  return heading
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

async function headingsFor(filePath) {
  const source = await readText(filePath);
  return new Set(
    [...source.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((match) => anchorFor(match[1])),
  );
}

function assertNoPublicDashes(content, label) {
  assert(!/[\u2013\u2014]/u.test(content), `${label} contains U+2013/U+2014`);
}

async function checkLocalLinks(filePath) {
  const source = await readText(filePath);
  const linkPattern = /(?:href|src)=["']([^"']+)["']|\]\(([^)]+)\)/gu;
  for (const match of source.matchAll(linkPattern)) {
    const href = match[1] ?? match[2];
    const targetPath = localTarget(filePath, href);
    if (!targetPath) continue;
    assert(await isPath(targetPath), `${relativePath(filePath)} points to missing ${href}`);
    const hash = href.split("#")[1];
    if (hash) {
      assert(
        await isFile(targetPath),
        `${relativePath(filePath)} anchor target is not a file ${href}`,
      );
      const headings = await headingsFor(targetPath).catch(() => new Set());
      assert(
        headings.has(decodeURIComponent(hash)),
        `${relativePath(filePath)} points to missing anchor ${href}`,
      );
    }
  }
}

async function walk(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(root, child)));
    else if (entry.isFile()) files.push(path.join(root, child));
  }
  return files;
}

function assertSchemaEnvelope(schema, fileName) {
  assert(
    schema.$schema === "https://json-schema.org/draft/2020-12/schema",
    `${fileName} has the wrong JSON Schema draft`,
  );
  assert(
    typeof schema.$id === "string" && schema.$id.startsWith("urn:threadleaf:spec:v1:"),
    `${fileName} has no local v1 schema ID`,
  );
  assert(schema.type === "object", `${fileName} root must be an object schema`);
  assert(schema.additionalProperties === false, `${fileName} must reject unknown root fields`);
}

async function check() {
  const packageJson = await readJson(packageJsonPath);
  const index = await readJson(path.join(dataPath, "index.v1.json"));
  assert(
    index.schemaVersion === 1 && index.uri === "urn:threadleaf:spec:v1",
    "index envelope is stale",
  );
  assert(index.threadleafVersion === packageJson.version, "index app version is stale");
  assert(
    index.generatedBy === "scripts/generate-public-spec.mjs",
    "index generator identity is stale",
  );

  for (const name of index.datasets) {
    assert(name.endsWith(".json"), `dataset reference is not JSON: ${name}`);
    assert(await isFile(path.join(dataPath, name)), `index references missing dataset ${name}`);
    const data = await readJson(path.join(dataPath, name));
    assert(data.schemaVersion === 1, `${name} has unsupported schemaVersion`);
    if (name !== "registry.v1.json") {
      assert(
        typeof data.uri === "string" && data.uri.startsWith("urn:threadleaf:spec:v1:"),
        `${name} has no v1 URI`,
      );
    }
    if (data.threadleafVersion)
      assert(data.threadleafVersion === packageJson.version, `${name} app version is stale`);
  }
  for (const name of index.schemas) {
    assert(name.endsWith(".schema.json"), `schema reference is not a schema: ${name}`);
    const schema = await readJson(path.join(schemaPath, name));
    assertSchemaEnvelope(schema, name);
  }
  assert(
    index.datasets.length === 6,
    `expected six generated datasets, found ${index.datasets.length}`,
  );
  assert(index.schemas.length === 8, `expected eight schemas, found ${index.schemas.length}`);

  const registry = await readJson(path.join(dataPath, "registry.v1.json"));
  const sourceRegistry = await readJson(path.join(rootPath, "compatibility", "registry.v1.json"));
  assert(
    JSON.stringify(registry) === JSON.stringify(sourceRegistry),
    "generated registry differs from compatibility registry",
  );
  const fixtures = await readJson(path.join(dataPath, "fixtures.v1.json"));
  assert(
    fixtures.fixtures.length === 2,
    `expected two generated corpora, found ${fixtures.fixtures.length}`,
  );
  assert(
    fixtures.fixtures.some((fixture) => fixture.id === "threadleaf.same-vault.v1") &&
      fixtures.fixtures.some((fixture) => fixture.id === "threadleaf.excalidraw-roundtrip.v1"),
    "same-vault and Excalidraw corpora are both required",
  );
  for (const fixture of fixtures.fixtures) {
    assert(
      fixture.license && fixture.licensePath && fixture.licenseSha256,
      `${fixture.id} lacks license provenance`,
    );
    assert(fixture.provenancePath && fixture.provenanceSha256, `${fixture.id} lacks provenance`);
    assert(fixture.files.length > 0 && fixture.cases.length > 0, `${fixture.id} is empty`);
    for (const file of fixture.files) {
      assert(/^[a-f0-9]{64}$/u.test(file.sha256), `${fixture.id} has an invalid fixture digest`);
    }
    if (fixture.id === "threadleaf.excalidraw-roundtrip.v1") {
      assert(
        fixture.observation?.status === "observed",
        "official Obsidian observation is not recorded",
      );
      assert(
        /^[a-f0-9]{64}$/u.test(fixture.observation.sha256),
        "Excalidraw observation digest is invalid",
      );
    }
  }
  const conformance = await readJson(path.join(dataPath, "conformance.v1.json"));
  assert(
    conformance.claims.length > 0 && conformance.gaps.length > 0,
    "conformance report hides claims or gaps",
  );
  const requiredClaims = [
    "native-cli",
    "same-vault-corpus",
    "excalidraw-roundtrip-corpus",
    "migration-preview-and-apply",
    "live-preview-source-mapping",
    "json-canvas",
    "workspace-docks-settings",
    "markdown-processors",
    "plugin-package-inspection",
    "native-extension-foundation",
  ];
  for (const id of requiredClaims)
    assert(
      conformance.claims.some((claim) => claim.id === id),
      `missing required claim ${id}`,
    );
  assert(
    !conformance.gaps.some((gap) => gap.id === "official-obsidian-roundtrip"),
    "observed official Obsidian roundtrip is still published as a gap",
  );
  for (const claim of conformance.claims) {
    assert(claim.label === "normative", `${claim.id} claim is not labeled normative`);
    assert(claim.threadleafVersion === packageJson.version, `${claim.id} claim version is stale`);
    for (const gate of claim.gates) {
      assert(
        !path.isAbsolute(gate.path) && !gate.path.split("/").includes(".."),
        `${claim.id} gate escapes repository`,
      );
      assert(
        await isFile(path.join(rootPath, gate.path)),
        `${claim.id} gate is missing: ${gate.path}`,
      );
    }
  }
  for (const gap of conformance.gaps)
    assert(gap.label === "informative", `${gap.id} gap is incorrectly normative`);

  const htmlPath = path.join(sitePath, "index.html");
  const html = await readText(htmlPath);
  const style = await readText(path.join(sitePath, "styles.css"));
  const script = await readText(path.join(sitePath, "site.js"));
  assert(!/<script[^>]+src=["']https?:/iu.test(html), "site loads a remote script");
  assert(!/<link[^>]+href=["']https?:/iu.test(html), "site loads a remote stylesheet");
  assert(!/url\(\s*["']?https?:/iu.test(style), "site CSS loads a remote asset");
  assert(!/fetch\(\s*["']https?:/iu.test(script), "site JavaScript performs a remote fetch");
  assertNoPublicDashes(html, "site HTML");
  assertNoPublicDashes(style, "site CSS");
  assertNoPublicDashes(script, "site JavaScript");
  assert(
    html.includes("Threadleaf") && !/@@[A-Z0-9_]+@@/u.test(html),
    "site HTML is not fully generated",
  );
  for (const filePath of [...(await walk(sourcePath)), ...(await walk(sitePath))]) {
    const extension = path.extname(filePath).toLocaleLowerCase("en-US");
    if ([".md", ".html"].includes(extension)) await checkLocalLinks(filePath);
    assertNoPublicDashes(await readText(filePath), relativePath(filePath));
  }
  for (const filePath of await walk(publicSpecPath)) {
    const extension = path.extname(filePath).toLocaleLowerCase("en-US");
    if (extension === ".md") await checkLocalLinks(filePath);
    if ([".json", ".md", ".html", ".css", ".js"].includes(extension))
      assertNoPublicDashes(await readText(filePath), relativePath(filePath));
  }

  const generation = spawnSync(
    process.execPath,
    [path.join(rootPath, "scripts", "generate-public-spec.mjs"), "--check"],
    { cwd: rootPath, encoding: "utf8" },
  );
  assert(
    generation.status === 0,
    `generated outputs are stale:\n${generation.stdout}\n${generation.stderr}`,
  );
  process.stdout.write(
    `Verified public specification v1, ${conformance.claims.length} claims, ${conformance.gaps.length} gaps, and offline site links.\n`,
  );
}

try {
  await check();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
