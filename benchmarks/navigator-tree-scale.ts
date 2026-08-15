import { performance } from "node:perf_hooks";
import {
  applyNavigatorTreePage,
  buildNavigatorTreeProjection,
  claimNavigatorTreePageRequests,
  createNavigatorTreeState,
} from "../src/renderer/navigator-tree";
import {
  maximumWorkspaceFilePageSize,
  type WorkspaceFileSummary,
  type WorkspaceTreeEntry,
} from "../src/shared/contracts";
import { buildWorkspaceTreeIndex } from "../src/shared/workspace-tree";

const noteCount = 200_000;
const libraryChildCount = 1_001;
const rootNoteCount = noteCount - libraryChildCount - 2;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syntheticNote(path: string, title: string): WorkspaceFileSummary {
  return {
    path,
    title,
    tags: [],
    backlinkCount: 0,
    outgoingCount: 0,
    unresolvedCount: 0,
  };
}

function createCorpus(): WorkspaceFileSummary[] {
  const files: WorkspaceFileSummary[] = [];
  for (let index = 0; index < rootNoteCount; index += 1) {
    const title = `Root note ${String(index).padStart(6, "0")}`;
    files.push(syntheticNote(`${title}.md`, title));
  }
  for (let index = 0; index < libraryChildCount; index += 1) {
    const title = `Child ${String(index).padStart(4, "0")}`;
    files.push(syntheticNote(`Library/${title}.md`, title));
  }
  files.push(syntheticNote("Projects/Deep/Active.md", "Active"));
  files.push(syntheticNote("Reference/Read me.md", "Read me"));
  assert(files.length === noteCount, `Expected ${noteCount} synthetic notes.`);
  return files;
}

function firstPage(entries: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry[] {
  return entries.slice(0, maximumWorkspaceFilePageSize);
}

function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

const started = performance.now();
const files = createCorpus();
const indexed = buildWorkspaceTreeIndex(files);
const treeBuildMs = performance.now() - started;
const rootEntries = indexed.childrenByParent.get(null) ?? [];
const libraryEntries = indexed.childrenByParent.get("Library") ?? [];
assert(libraryEntries.length === libraryChildCount, "Library children did not index exactly.");

const treeState = createNavigatorTreeState("synthetic-200k", "generation-1");
applyNavigatorTreePage(
  treeState,
  {
    generation: treeState.generation,
    parentPath: null,
    offset: 0,
    limit: maximumWorkspaceFilePageSize,
    total: rootEntries.length,
    complete: true,
  },
  firstPage(rootEntries),
);
applyNavigatorTreePage(
  treeState,
  {
    generation: treeState.generation,
    parentPath: "Library",
    offset: 0,
    limit: maximumWorkspaceFilePageSize,
    total: libraryEntries.length,
    complete: true,
  },
  firstPage(libraryEntries),
);

const projectionStarted = performance.now();
const projection = buildNavigatorTreeProjection(treeState, new Set(["Library"]));
const projectionBuildMs = performance.now() - projectionStarted;
const requestWindow = claimNavigatorTreePageRequests(treeState, projection, 256, 288);
const materializedEntries = [...treeState.pages.values()].reduce(
  (total, page) => total + page.entries.size,
  0,
);
const maximumViewportRows = Math.ceil(840 / 40) + 2 * 8;

assert(projection.length > noteCount, "Expanded folders should add structural rows to the tree.");
assert(materializedEntries === maximumWorkspaceFilePageSize * 2, "Tree pages exceeded the cap.");
assert(
  projection.segmentCount <= materializedEntries + 2,
  "Projection materialized one segment per note.",
);
assert(
  requestWindow.length === 1 &&
    requestWindow[0]?.parentPath === "Library" &&
    requestWindow[0].offset === 256,
  `The expanded child virtual range requested an unexpected page: ${JSON.stringify(requestWindow)}`,
);

const memory = process.memoryUsage();
process.stdout.write(
  `${JSON.stringify(
    {
      noteCount,
      indexedRootEntries: rootEntries.length,
      libraryChildCount,
      treeBuildMs: Math.round(treeBuildMs * 100) / 100,
      projectionBuildMs: Math.round(projectionBuildMs * 100) / 100,
      projectedRows: projection.length,
      projectionSegments: projection.segmentCount,
      materializedEntries,
      maximumViewportRows,
      nextVirtualRequest: requestWindow[0],
      rssMiB: megabytes(memory.rss),
      heapUsedMiB: megabytes(memory.heapUsed),
    },
    null,
    2,
  )}\n`,
);
