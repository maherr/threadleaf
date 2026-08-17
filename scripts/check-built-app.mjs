import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.once("uncaughtException", (error) => {
  process.exitCode = 1;
  console.error(`[built-app] ${error instanceof Error ? error.message : String(error)}`);
});

const projectRoot = path.resolve(import.meta.dirname, "..");
const rendererDirectory = path.join(projectRoot, "dist", "renderer");
const indexPath = path.join(rendererDirectory, "index.html");
const html = await readFile(indexPath, "utf8");

if (html.includes('="/assets/')) {
  throw new Error("Renderer assets must be relative so Electron can load them over file://.");
}

const assetPaths = [...html.matchAll(/(?:href|src)="(\.\/assets\/[^"]+)"/g)].map(
  ([, assetPath]) => assetPath,
);

if (assetPaths.length < 2) {
  throw new Error("Built renderer must reference its JavaScript and CSS assets.");
}

await Promise.all([
  access(path.join(projectRoot, "dist", "main", "cli.cjs")),
  access(path.join(projectRoot, "dist", "main", "main.cjs")),
  access(path.join(projectRoot, "dist", "main", "plugin-renderer.cjs")),
  access(path.join(projectRoot, "dist", "main", "preload.cjs")),
  access(path.join(projectRoot, "dist", "native", "threadleaf-state-lock.node")),
  access(path.join(projectRoot, "dist", "renderer", "plugin-host.html")),
  access(path.join(projectRoot, "dist", "renderer", "index-trusted.html")),
  ...assetPaths.map((assetPath) => access(path.resolve(rendererDirectory, assetPath))),
]);

const cliPath = path.join(projectRoot, "dist", "main", "cli.cjs");
const cliSource = await readFile(cliPath, "utf8");
if (!cliSource.startsWith("#!/usr/bin/env node")) {
  throw new Error("Built CLI must retain its portable Node.js shebang.");
}
const cliResult = spawnSync(
  process.execPath,
  [
    cliPath,
    "--vault",
    path.join(projectRoot, "fixtures", "vaults", "basic"),
    "--json",
    "vault",
    "info",
  ],
  { encoding: "utf8" },
);
if (cliResult.status !== 0 || cliResult.stderr !== "") {
  throw new Error(`Built CLI smoke test failed: ${cliResult.stderr || `exit ${cliResult.status}`}`);
}
const cliEnvelope = JSON.parse(cliResult.stdout);
if (
  cliEnvelope.schemaVersion !== 1 ||
  cliEnvelope.ok !== true ||
  cliEnvelope.command !== "vault.info" ||
  cliEnvelope.data?.markdownFiles !== 2
) {
  throw new Error("Built CLI returned an unexpected vault info envelope.");
}
const cliGraphResult = spawnSync(
  process.execPath,
  [
    cliPath,
    "--vault",
    path.join(projectRoot, "fixtures", "vaults", "basic"),
    "--json",
    "links",
    "file=welcome",
  ],
  { encoding: "utf8" },
);
if (cliGraphResult.status !== 0 || cliGraphResult.stderr !== "") {
  throw new Error(
    `Built CLI graph smoke test failed: ${cliGraphResult.stderr || `exit ${cliGraphResult.status}`}`,
  );
}
const cliGraphEnvelope = JSON.parse(cliGraphResult.stdout);
if (
  cliGraphEnvelope.schemaVersion !== 1 ||
  cliGraphEnvelope.ok !== true ||
  cliGraphEnvelope.command !== "links" ||
  cliGraphEnvelope.data?.path !== "Welcome.md" ||
  cliGraphEnvelope.data?.total !== 2 ||
  cliGraphEnvelope.data?.links?.[0]?.resolution?.path !== "Linked Note.md" ||
  cliGraphEnvelope.data?.links?.[1]?.resolution?.path !== "Linked Note.md" ||
  cliGraphEnvelope.data?.links?.[1]?.embed !== true ||
  cliGraphEnvelope.data?.links?.[1]?.subpath !== "#Project brief"
) {
  throw new Error("Built CLI returned an unexpected graph envelope.");
}
const cliSearchResult = spawnSync(
  process.execPath,
  [
    cliPath,
    "--vault",
    path.join(projectRoot, "fixtures", "vaults", "basic"),
    "search",
    "query=Threadleaf",
    "format=json",
  ],
  { encoding: "utf8" },
);
if (
  cliSearchResult.status !== 0 ||
  cliSearchResult.stderr !== "" ||
  JSON.stringify(JSON.parse(cliSearchResult.stdout)) !==
    JSON.stringify(["Welcome.md", "Linked Note.md"])
) {
  throw new Error(
    `Built CLI filtered search smoke test failed: ${cliSearchResult.stderr || `exit ${cliSearchResult.status}`}`,
  );
}
const cliBacklinksResult = spawnSync(
  process.execPath,
  [
    cliPath,
    "--vault",
    path.join(projectRoot, "fixtures", "vaults", "basic"),
    "backlinks",
    "file=Linked Note",
    "counts",
    "format=csv",
  ],
  { encoding: "utf8" },
);
if (
  cliBacklinksResult.status !== 0 ||
  cliBacklinksResult.stderr !== "" ||
  cliBacklinksResult.stdout !== "Welcome.md,2\n"
) {
  throw new Error(
    `Built CLI backlink format smoke test failed: ${cliBacklinksResult.stderr || `exit ${cliBacklinksResult.status}`}`,
  );
}

async function verifyBuiltCliMutations() {
  const scratchPath = await mkdtemp(path.join(os.tmpdir(), "threadleaf-built-cli-"));
  try {
    const vaultPath = path.join(scratchPath, "vault");
    await cp(path.join(projectRoot, "fixtures", "vaults", "basic"), vaultPath, {
      recursive: true,
    });
    const statePath = path.join(scratchPath, "state");
    const originalPath = path.join(vaultPath, "Linked Note.md");
    const trashPath = path.join(vaultPath, ".trash", "Linked Note.md");
    const original = await readFile(originalPath);
    const propertyPath = path.join(vaultPath, "Welcome.md");
    const propertyOriginal = await readFile(propertyPath);
    const taskPath = path.join(vaultPath, "Tasks.md");
    const taskOriginal = Buffer.from("\ufeff# Tasks\r\n\r\n- [ ] built smoke\r\n", "utf8");
    await writeFile(taskPath, taskOriginal);
    await writeFile(
      path.join(vaultPath, "Metadata.md"),
      "---\naliases: [Built alias]\ntags: [built, smoke]\n---\n# Metadata\n",
      "utf8",
    );
    await mkdir(path.join(vaultPath, "Assets"));
    await writeFile(path.join(vaultPath, "Assets", "Asset.canvas"), "{}", "utf8");
    const pluginDirectory = path.join(vaultPath, ".obsidian", "plugins", "built-catalog");
    const executionMarker = path.join(scratchPath, "plugin-code-executed");
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(
      path.join(pluginDirectory, "manifest.json"),
      JSON.stringify({ id: "built-catalog", name: "Built catalog", version: "1.2.3" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginDirectory, "main.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(executionMarker)}, "executed");`,
      "utf8",
    );
    await writeFile(
      path.join(pluginDirectory, "styles.css"),
      "body { --built-catalog: 1; }",
      "utf8",
    );
    const themeDirectory = path.join(vaultPath, ".obsidian", "themes", "Built Theme");
    await mkdir(themeDirectory, { recursive: true });
    await writeFile(path.join(themeDirectory, "theme.css"), "body { --built-theme: 1; }", "utf8");
    await writeFile(
      path.join(themeDirectory, "manifest.json"),
      JSON.stringify({ name: "Built Theme", version: "2.0.0" }),
      "utf8",
    );
    await mkdir(path.join(vaultPath, ".obsidian", "snippets"), { recursive: true });
    await writeFile(
      path.join(vaultPath, ".obsidian", "snippets", "built-snippet.css"),
      "body { --built-snippet: 1; }",
      "utf8",
    );
    const environment = { ...process.env, XDG_STATE_HOME: statePath };

    const catalogPlugins = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "plugins", "filter=community", "versions", "format=json"],
      { encoding: "utf8", env: environment },
    );
    const catalogPluginsData =
      catalogPlugins.status === 0 ? JSON.parse(catalogPlugins.stdout) : null;
    if (
      catalogPlugins.stderr !== "" ||
      catalogPluginsData?.sourceState !== "present" ||
      catalogPluginsData?.plugins?.[0]?.id !== "built-catalog" ||
      catalogPluginsData.plugins[0]?.version !== "1.2.3"
    ) {
      throw new Error(
        `Built CLI plugin catalog smoke test failed: ${catalogPlugins.stderr || `exit ${catalogPlugins.status}`}`,
      );
    }

    const catalogPlugin = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "plugin", "id=built-catalog"],
      { encoding: "utf8", env: environment },
    );
    const catalogPluginEnvelope =
      catalogPlugin.status === 0 ? JSON.parse(catalogPlugin.stdout) : null;
    if (
      catalogPlugin.stderr !== "" ||
      catalogPluginEnvelope?.command !== "plugin" ||
      catalogPluginEnvelope.data?.plugin?.name !== "Built catalog" ||
      catalogPluginEnvelope.data?.plugin?.stylesheetDiscovered !== true
    ) {
      throw new Error(
        `Built CLI plugin detail smoke test failed: ${catalogPlugin.stderr || `exit ${catalogPlugin.status}`}`,
      );
    }

    const catalogThemes = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "themes", "versions"],
      { encoding: "utf8", env: environment },
    );
    if (
      catalogThemes.status !== 0 ||
      catalogThemes.stderr !== "" ||
      catalogThemes.stdout !== "Built Theme\t2.0.0\nThreadleaf Fixture\t0.1.0\n"
    ) {
      throw new Error(
        `Built CLI theme catalog smoke test failed: ${catalogThemes.stderr || `exit ${catalogThemes.status}`}`,
      );
    }

    const catalogTheme = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "theme", "name=Built Theme"],
      { encoding: "utf8", env: environment },
    );
    const catalogThemeEnvelope = catalogTheme.status === 0 ? JSON.parse(catalogTheme.stdout) : null;
    if (
      catalogTheme.stderr !== "" ||
      catalogThemeEnvelope?.command !== "theme" ||
      catalogThemeEnvelope.data?.theme?.id !== "obsidian-theme:Built%20Theme"
    ) {
      throw new Error(
        `Built CLI theme detail smoke test failed: ${catalogTheme.stderr || `exit ${catalogTheme.status}`}`,
      );
    }

    const catalogSnippets = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "snippets"],
      { encoding: "utf8", env: environment },
    );
    const catalogSnippetsEnvelope =
      catalogSnippets.status === 0 ? JSON.parse(catalogSnippets.stdout) : null;
    if (
      catalogSnippets.stderr !== "" ||
      catalogSnippetsEnvelope?.command !== "snippets" ||
      catalogSnippetsEnvelope.data?.snippets?.[0]?.name !== "built-snippet"
    ) {
      throw new Error(
        `Built CLI snippet catalog smoke test failed: ${catalogSnippets.stderr || `exit ${catalogSnippets.status}`}`,
      );
    }
    for (const output of [
      catalogPlugins.stdout,
      catalogPlugin.stdout,
      catalogThemes.stdout,
      catalogTheme.stdout,
      catalogSnippets.stdout,
    ]) {
      if (
        output.includes(vaultPath) ||
        output.includes(executionMarker) ||
        output.includes("--built-")
      ) {
        throw new Error("Built CLI catalog output exposed private source details.");
      }
    }
    for (const missingPath of [executionMarker, statePath]) {
      try {
        await access(missingPath);
        throw new Error(
          `Built CLI catalog inspection unexpectedly wrote ${path.basename(missingPath)}.`,
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }

    const fileInfo = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "file", "file=asset.canvas"],
      { encoding: "utf8", env: environment },
    );
    const fileInfoEnvelope = fileInfo.status === 0 ? JSON.parse(fileInfo.stdout) : null;
    if (
      fileInfo.stderr !== "" ||
      fileInfoEnvelope?.command !== "file" ||
      fileInfoEnvelope.data?.path !== "Assets/Asset.canvas" ||
      fileInfoEnvelope.data?.extension !== "canvas" ||
      fileInfoEnvelope.data?.size !== 2
    ) {
      throw new Error(
        `Built CLI file inventory smoke test failed: ${fileInfo.stderr || `exit ${fileInfo.status}`}`,
      );
    }

    const wordcount = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "wordcount", "file=tasks", "words"],
      { encoding: "utf8", env: environment },
    );
    if (wordcount.status !== 0 || wordcount.stderr !== "" || wordcount.stdout !== "3\n") {
      throw new Error(
        `Built CLI wordcount smoke test failed: ${wordcount.stderr || `exit ${wordcount.status}`}`,
      );
    }

    const propertySet = spawnSync(
      process.execPath,
      [
        cliPath,
        "--vault",
        vaultPath,
        "--json",
        "property:set",
        "path=Welcome.md",
        "name=status",
        "value=built-smoke",
      ],
      { encoding: "utf8", env: environment },
    );
    const propertySetEnvelope = propertySet.status === 0 ? JSON.parse(propertySet.stdout) : null;
    if (
      propertySet.stderr !== "" ||
      propertySetEnvelope?.command !== "property.set" ||
      propertySetEnvelope.data?.name !== "status" ||
      propertySetEnvelope.data?.value !== "built-smoke"
    ) {
      throw new Error(
        `Built CLI property-set smoke test failed: ${propertySet.stderr || `exit ${propertySet.status}`}`,
      );
    }

    const propertyRead = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "property:read", "path=Welcome.md", "name=status"],
      { encoding: "utf8", env: environment },
    );
    const propertyReadEnvelope = propertyRead.status === 0 ? JSON.parse(propertyRead.stdout) : null;
    if (
      propertyRead.stderr !== "" ||
      propertyReadEnvelope?.data?.exists !== true ||
      propertyReadEnvelope.data?.value !== "built-smoke"
    ) {
      throw new Error(
        `Built CLI property-read smoke test failed: ${propertyRead.stderr || `exit ${propertyRead.status}`}`,
      );
    }

    const propertyRemove = spawnSync(
      process.execPath,
      [
        cliPath,
        "--vault",
        vaultPath,
        "--json",
        "property:remove",
        "path=Welcome.md",
        "name=status",
      ],
      { encoding: "utf8", env: environment },
    );
    if (
      propertyRemove.status !== 0 ||
      propertyRemove.stderr !== "" ||
      !propertyOriginal.equals(await readFile(propertyPath))
    ) {
      throw new Error(
        `Built CLI property-remove smoke test failed: ${propertyRemove.stderr || `exit ${propertyRemove.status}`}`,
      );
    }

    const aliases = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "aliases", "path=Metadata.md", "verbose"],
      { encoding: "utf8", env: environment },
    );
    const aliasesEnvelope = aliases.status === 0 ? JSON.parse(aliases.stdout) : null;
    if (
      aliases.stderr !== "" ||
      aliasesEnvelope?.command !== "aliases" ||
      aliasesEnvelope.data?.total !== 1 ||
      aliasesEnvelope.data?.aliases?.[0]?.alias !== "Built alias" ||
      aliasesEnvelope.data?.aliases?.[0]?.path !== "Metadata.md"
    ) {
      throw new Error(
        `Built CLI aliases smoke test failed: ${aliases.stderr || `exit ${aliases.status}`}`,
      );
    }

    const tags = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "tags", "path=Metadata.md", "counts"],
      { encoding: "utf8", env: environment },
    );
    const tagsEnvelope = tags.status === 0 ? JSON.parse(tags.stdout) : null;
    if (
      tags.stderr !== "" ||
      tagsEnvelope?.command !== "tags" ||
      tagsEnvelope.data?.total !== 2 ||
      tagsEnvelope.data?.tags?.[0]?.name !== "built" ||
      tagsEnvelope.data?.tags?.[0]?.count !== 1
    ) {
      throw new Error(`Built CLI tags smoke test failed: ${tags.stderr || `exit ${tags.status}`}`);
    }

    const tag = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "tag", "name=built", "verbose"],
      { encoding: "utf8", env: environment },
    );
    const tagEnvelope = tag.status === 0 ? JSON.parse(tag.stdout) : null;
    if (
      tag.stderr !== "" ||
      tagEnvelope?.command !== "tag" ||
      tagEnvelope.data?.count !== 1 ||
      tagEnvelope.data?.files?.[0] !== "Metadata.md"
    ) {
      throw new Error(`Built CLI tag smoke test failed: ${tag.stderr || `exit ${tag.status}`}`);
    }

    const tasks = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "tasks", "path=Tasks.md", "todo", "verbose"],
      { encoding: "utf8", env: environment },
    );
    const tasksEnvelope = tasks.status === 0 ? JSON.parse(tasks.stdout) : null;
    if (
      tasks.stderr !== "" ||
      tasksEnvelope?.command !== "tasks" ||
      tasksEnvelope.data?.total !== 1 ||
      tasksEnvelope.data?.tasks?.[0]?.line !== 3 ||
      tasksEnvelope.data?.tasks?.[0]?.status !== " "
    ) {
      throw new Error(
        `Built CLI task-list smoke test failed: ${tasks.stderr || `exit ${tasks.status}`}`,
      );
    }

    const taskDone = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "task", "ref=Tasks.md:3", "done"],
      { encoding: "utf8", env: environment },
    );
    const taskDoneEnvelope = taskDone.status === 0 ? JSON.parse(taskDone.stdout) : null;
    if (
      taskDone.stderr !== "" ||
      taskDoneEnvelope?.command !== "task" ||
      taskDoneEnvelope.data?.status !== "committed" ||
      taskDoneEnvelope.data?.task?.status !== "x"
    ) {
      throw new Error(
        `Built CLI task-done smoke test failed: ${taskDone.stderr || `exit ${taskDone.status}`}`,
      );
    }

    const taskRead = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "task", "path=Tasks.md", "line=3"],
      { encoding: "utf8", env: environment },
    );
    const taskReadEnvelope = taskRead.status === 0 ? JSON.parse(taskRead.stdout) : null;
    if (
      taskRead.stderr !== "" ||
      taskReadEnvelope?.data?.task?.line !== 3 ||
      taskReadEnvelope.data?.task?.status !== "x" ||
      taskReadEnvelope.data?.task?.text !== "built smoke"
    ) {
      throw new Error(
        `Built CLI task-read smoke test failed: ${taskRead.stderr || `exit ${taskRead.status}`}`,
      );
    }

    const taskToggle = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "task", "ref=Tasks.md:3", "toggle"],
      { encoding: "utf8", env: environment },
    );
    if (
      taskToggle.status !== 0 ||
      taskToggle.stderr !== "" ||
      !taskOriginal.equals(await readFile(taskPath))
    ) {
      throw new Error(
        `Built CLI task-toggle smoke test failed: ${taskToggle.stderr || `exit ${taskToggle.status}`}`,
      );
    }

    const deleted = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "delete", "path=Linked Note.md"],
      { encoding: "utf8", env: environment },
    );
    if (deleted.status !== 0 || deleted.stderr !== "") {
      throw new Error(
        `Built CLI delete smoke test failed: ${deleted.stderr || `exit ${deleted.status}`}`,
      );
    }
    const deleteEnvelope = JSON.parse(deleted.stdout);
    if (
      deleteEnvelope.command !== "delete" ||
      deleteEnvelope.data?.from !== "Linked Note.md" ||
      deleteEnvelope.data?.to !== ".trash/Linked Note.md" ||
      !original.equals(await readFile(trashPath))
    ) {
      throw new Error("Built CLI did not preserve exact bytes in recoverable trash.");
    }

    const listed = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "trash:list"],
      { encoding: "utf8", env: environment },
    );
    const listEnvelope = listed.status === 0 ? JSON.parse(listed.stdout) : null;
    if (
      listed.stderr !== "" ||
      listEnvelope?.command !== "trash.list" ||
      listEnvelope.data?.entries?.[0]?.path !== "Linked Note.md"
    ) {
      throw new Error(
        `Built CLI trash-list smoke test failed: ${listed.stderr || `exit ${listed.status}`}`,
      );
    }

    const restored = spawnSync(
      process.execPath,
      [cliPath, "--vault", vaultPath, "--json", "restore", "Linked Note.md"],
      { encoding: "utf8", env: environment },
    );
    if (restored.status !== 0 || restored.stderr !== "") {
      throw new Error(
        `Built CLI restore smoke test failed: ${restored.stderr || `exit ${restored.status}`}`,
      );
    }
    const restoreEnvelope = JSON.parse(restored.stdout);
    if (
      restoreEnvelope.command !== "restore" ||
      restoreEnvelope.data?.to !== "Linked Note.md" ||
      !original.equals(await readFile(originalPath))
    ) {
      throw new Error("Built CLI did not restore exact bytes to the original path.");
    }
    try {
      await access(trashPath);
      throw new Error("Built CLI restore left the trash entry behind.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  } finally {
    await rm(scratchPath, { recursive: true, force: true });
  }
}

await verifyBuiltCliMutations();
try {
  await access(path.join(projectRoot, "fixtures", "vaults", ".threadleaf-cli-read-only-state"));
  throw new Error("Built read-only CLI created a state directory.");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

console.log(
  `Verified Electron entry points, headless CLI inventory, compatibility catalogs, wordcount, search and graph formats, property, alias, tag, task, and recovery behavior, and ${assetPaths.length} relative renderer assets.`,
);
