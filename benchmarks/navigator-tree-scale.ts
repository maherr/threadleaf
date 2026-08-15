import { performance } from "node:perf_hooks";
import {
  applyNavigatorTreePage,
  buildNavigatorTreeProjection,
  claimNavigatorTreePageRequest,
  claimNavigatorTreePageRequests,
  completeNavigatorTreePageRequest,
  createNavigatorTreeState,
  maximumNavigatorTreeLruPages,
  type NavigatorTreePageRequest,
  type NavigatorTreeState,
  navigatorTreePageRequestsForRange,
  navigatorTreeRetentionCounts,
  retainNavigatorTreePages,
} from "../src/renderer/navigator-tree";
import {
  maximumWorkspaceFilePageSize,
  type WorkspaceFileSummary,
  type WorkspaceTreeEntry,
  type WorkspaceTreePageDescriptor,
} from "../src/shared/contracts";
import { buildWorkspaceTreeIndex } from "../src/shared/workspace-tree";

const noteCount = 200_000;
const libraryChildCount = 1_001;
const rootNoteCount = noteCount - libraryChildCount - 2;
const pageLimit = maximumWorkspaceFilePageSize;

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

function syntheticTreeNote(path: string): WorkspaceTreeEntry {
  return {
    kind: "note",
    path,
    title: path.slice(path.lastIndexOf("/") + 1, -3),
    tags: [],
    backlinkCount: 0,
    outgoingCount: 0,
    unresolvedCount: 0,
  };
}

function syntheticTreeFolder(path: string, childCount: number): WorkspaceTreeEntry {
  return { kind: "folder", path, title: path.slice(path.lastIndexOf("/") + 1), childCount };
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

function pageEntries(entries: readonly WorkspaceTreeEntry[], offset: number): WorkspaceTreeEntry[] {
  return entries.slice(offset, offset + pageLimit);
}

function pageDescriptor(
  state: NavigatorTreeState,
  parentPath: string | null,
  offset: number,
  total: number,
  entries: readonly WorkspaceTreeEntry[],
): WorkspaceTreePageDescriptor {
  return {
    generation: state.generation,
    parentPath,
    offset,
    limit: pageLimit,
    total,
    complete: offset + entries.length >= total,
  };
}

function encodedTreePageResponseBytes(
  vaultId: string,
  page: WorkspaceTreePageDescriptor,
  entries: readonly WorkspaceTreeEntry[],
): number {
  return new TextEncoder().encode(JSON.stringify({ status: "ready", vaultId, page, entries }))
    .byteLength;
}

function megabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function requestFor(parentPath: string | null, offset: number): NavigatorTreePageRequest {
  return { parentPath, offset, limit: pageLimit };
}

function applyPage(
  state: NavigatorTreeState,
  request: NavigatorTreePageRequest,
  source: readonly WorkspaceTreeEntry[],
): WorkspaceTreePageDescriptor {
  const entries = pageEntries(source, request.offset);
  const page = pageDescriptor(state, request.parentPath, request.offset, source.length, entries);
  assert(
    applyNavigatorTreePage(state, page, entries),
    `Rejected synthetic tree page ${request.parentPath ?? "<root>"}:${request.offset}.`,
  );
  completeNavigatorTreePageRequest(state, request.parentPath, request.offset);
  return page;
}

function assertHonestRetentionBound(
  state: NavigatorTreeState,
): ReturnType<typeof navigatorTreeRetentionCounts> {
  const counts = navigatorTreeRetentionCounts(state);
  assert(
    counts.parentDescriptors <= counts.pages,
    `Retained ${counts.parentDescriptors} parent descriptors for ${counts.pages} cached pages.`,
  );
  assert(
    counts.lruPages <= maximumNavigatorTreeLruPages,
    `Retained ${counts.lruPages} LRU pages, above the ${maximumNavigatorTreeLruPages}-page allowance.`,
  );
  assert(
    counts.pages <= counts.mandatoryPages + maximumNavigatorTreeLruPages,
    `Retained ${counts.pages} pages beyond ${counts.mandatoryPages} mandatory pages and the ${maximumNavigatorTreeLruPages}-page LRU allowance.`,
  );
  assert(
    counts.entries <= (counts.mandatoryPages + maximumNavigatorTreeLruPages) * pageLimit,
    `Retained ${counts.entries} entries beyond the mandatory-page plus LRU bound.`,
  );
  return counts;
}

function hasHonestRetentionBound(counts: ReturnType<typeof navigatorTreeRetentionCounts>): boolean {
  return (
    counts.parentDescriptors <= counts.pages &&
    counts.lruPages <= maximumNavigatorTreeLruPages &&
    counts.pages <= counts.mandatoryPages + maximumNavigatorTreeLruPages &&
    counts.entries <= (counts.mandatoryPages + maximumNavigatorTreeLruPages) * pageLimit
  );
}

function runUniqueParentChurn(): {
  parentsVisited: number;
  retained: ReturnType<typeof navigatorTreeRetentionCounts>;
  bounded: boolean;
} {
  const state = createNavigatorTreeState("synthetic-parent-churn", "generation-1");
  const parentsVisited = 20_000;
  for (let index = 0; index < parentsVisited; index += 1) {
    const parentPath = `Parent ${String(index).padStart(5, "0")}`;
    const request = requestFor(parentPath, 0);
    retainNavigatorTreePages(state, [request]);
    applyPage(state, request, [syntheticTreeNote(`${parentPath}/Child.md`)]);
  }
  const retained = navigatorTreeRetentionCounts(state);
  return { parentsVisited, retained, bounded: hasHonestRetentionBound(retained) };
}

function runMultiParentDeepViewport(): {
  depth: number;
  viewportRows: number;
  distinctViewportPages: number;
  activeRevealTargetIndex: number | null;
  activeRevealPagesMandatory: boolean;
  currentViewportIntact: boolean;
  retained: ReturnType<typeof navigatorTreeRetentionCounts>;
  bounded: boolean;
} {
  const state = createNavigatorTreeState("synthetic-deep-viewport", "generation-1");
  const depth = 40;
  const viewportRows = 37;
  const chain = Array.from(
    { length: depth },
    (_, index) => `Depth ${String(index).padStart(2, "0")}`,
  );
  const entriesByParent = new Map<string | null, WorkspaceTreeEntry[]>();
  let parentPath: string | null = null;
  for (const [level, segment] of chain.entries()) {
    const folderPath: string = parentPath ? `${parentPath}/${segment}` : segment;
    entriesByParent.set(parentPath, [
      syntheticTreeFolder(folderPath, pageLimit),
      ...Array.from({ length: pageLimit - 1 }, (_, sibling) =>
        syntheticTreeNote(`${parentPath ? `${parentPath}/` : ""}Sibling ${level}-${sibling}.md`),
      ),
    ]);
    parentPath = folderPath;
  }
  const activePath = `${parentPath}/Active.md`;
  entriesByParent.set(parentPath, [
    syntheticTreeNote(activePath),
    ...Array.from({ length: pageLimit - 1 }, (_, sibling) =>
      syntheticTreeNote(`${parentPath}/Sibling active-${sibling}.md`),
    ),
  ]);
  const revealLocations = [...entriesByParent.keys()].map((parent) => ({
    parentPath: parent,
    offset: 0,
  }));

  retainNavigatorTreePages(state, [], revealLocations);
  for (const [parent, entries] of entriesByParent) {
    const request = requestFor(parent, 0);
    assert(
      claimNavigatorTreePageRequest(state, request),
      `Deep viewport did not claim ${JSON.stringify(request)}.`,
    );
    applyPage(state, request, entries);
  }
  const expandedPaths = new Set(chain.map((_, index) => chain.slice(0, index + 1).join("/")));
  const projection = buildNavigatorTreeProjection(state, expandedPaths);
  const viewportRequests = navigatorTreePageRequestsForRange(state, projection, 0, viewportRows);
  assert(
    viewportRequests.length === viewportRows,
    `Expected ${viewportRows} distinct viewport pages, got ${viewportRequests.length}.`,
  );
  retainNavigatorTreePages(state, viewportRequests, revealLocations);
  for (const request of viewportRequests) {
    const entries = entriesByParent.get(request.parentPath);
    assert(entries, `Missing synthetic source for ${request.parentPath ?? "<root>"}.`);
    applyPage(state, request, entries);
  }
  const retained = navigatorTreeRetentionCounts(state);
  const currentViewportIntact = Array.from(
    { length: viewportRows },
    (_, index) => projection.rowAt(index)?.kind === "entry",
  ).every(Boolean);
  return {
    depth,
    viewportRows,
    distinctViewportPages: viewportRequests.length,
    activeRevealTargetIndex: projection.indexOfPath(activePath),
    activeRevealPagesMandatory: retained.mandatoryPages === revealLocations.length,
    currentViewportIntact,
    retained,
    bounded: hasHonestRetentionBound(retained),
  };
}

const started = performance.now();
const files = createCorpus();
const indexed = buildWorkspaceTreeIndex(files);
const treeBuildMs = performance.now() - started;
const rootEntries = indexed.childrenByParent.get(null) ?? [];
const libraryEntries = indexed.childrenByParent.get("Library") ?? [];
assert(libraryEntries.length === libraryChildCount, "Library children did not index exactly.");

const treeState = createNavigatorTreeState("synthetic-200k", "generation-1");
const initialRootEntries = pageEntries(rootEntries, 0);
const initialRootPage = pageDescriptor(treeState, null, 0, rootEntries.length, initialRootEntries);
const initialLibraryEntries = pageEntries(libraryEntries, 0);
const initialLibraryPage = pageDescriptor(
  treeState,
  "Library",
  0,
  libraryEntries.length,
  initialLibraryEntries,
);
assert(!initialRootPage.complete, "A partial root response must not claim completion.");
assert(!initialLibraryPage.complete, "A partial Library response must not claim completion.");
applyNavigatorTreePage(treeState, initialRootPage, initialRootEntries);
applyNavigatorTreePage(treeState, initialLibraryPage, initialLibraryEntries);

const projectionStarted = performance.now();
const projection = buildNavigatorTreeProjection(treeState, new Set(["Library"]));
const projectionBuildMs = performance.now() - projectionStarted;
const requestWindow = claimNavigatorTreePageRequests(treeState, projection, 256, 288);
for (const request of requestWindow) {
  completeNavigatorTreePageRequest(treeState, request.parentPath, request.offset);
}
const materializedInitialEntries = navigatorTreeRetentionCounts(treeState).entries;
const theoreticalViewportRows = Math.ceil(840 / 40) + 2 * 8;

assert(projection.length > noteCount, "Expanded folders should add structural rows to the tree.");
assert(
  materializedInitialEntries === pageLimit * 2,
  "The initial tree pages exceeded the two-page fixture cap.",
);
assert(
  projection.segmentCount <= materializedInitialEntries + 2,
  "Projection materialized one segment per note.",
);
assert(
  requestWindow.length === 1 &&
    requestWindow[0]?.parentPath === "Library" &&
    requestWindow[0].offset === pageLimit,
  `The expanded child virtual range requested an unexpected page: ${JSON.stringify(requestWindow)}`,
);

const traversalState = createNavigatorTreeState("synthetic-200k", "generation-1");
let traversalMaximumPages = 0;
let traversalMaximumEntries = 0;
let traversalMaximumSegments = 0;
let pagesApplied = 0;
const traversalStarted = performance.now();

function loadRootTraversalPage(offset: number, alreadyClaimed = false): void {
  const request = requestFor(null, offset);
  if (!alreadyClaimed) {
    if (offset === 0 && !traversalState.pages.has(null)) {
      assert(
        claimNavigatorTreePageRequest(traversalState, request),
        "Root page zero was not claimed.",
      );
    } else {
      const traversalProjection = buildNavigatorTreeProjection(traversalState, new Set());
      const claimed = claimNavigatorTreePageRequests(
        traversalState,
        traversalProjection,
        offset,
        offset + 1,
      );
      assert(
        JSON.stringify(claimed) === JSON.stringify([request]),
        `Traversal did not claim ${JSON.stringify(request)}: ${JSON.stringify(claimed)}`,
      );
    }
  }
  retainNavigatorTreePages(traversalState, [request]);
  applyPage(traversalState, request, rootEntries);
  pagesApplied += 1;
  const counts = assertHonestRetentionBound(traversalState);
  traversalMaximumPages = Math.max(traversalMaximumPages, counts.pages);
  traversalMaximumEntries = Math.max(traversalMaximumEntries, counts.entries);
  traversalMaximumSegments = Math.max(
    traversalMaximumSegments,
    buildNavigatorTreeProjection(traversalState, new Set()).segmentCount,
  );
}

for (let offset = 0; offset < rootEntries.length; offset += pageLimit) {
  loadRootTraversalPage(offset);
}
const fullTraversalMs = performance.now() - traversalStarted;
const afterFullTraversal = buildNavigatorTreeProjection(traversalState, new Set());
const homeRefetch = claimNavigatorTreePageRequests(traversalState, afterFullTraversal, 0, 1);
assert(
  JSON.stringify(homeRefetch) === JSON.stringify([requestFor(null, 0)]),
  `Home did not safely refetch an evicted root page: ${JSON.stringify(homeRefetch)}`,
);
loadRootTraversalPage(0, true);

for (
  let offset = pageLimit;
  offset <= (maximumNavigatorTreeLruPages + 1) * pageLimit;
  offset += pageLimit
) {
  loadRootTraversalPage(offset);
}
const beforeEndRefetch = buildNavigatorTreeProjection(traversalState, new Set());
const lastRootOffset = Math.floor((rootEntries.length - 1) / pageLimit) * pageLimit;
const endRefetch = claimNavigatorTreePageRequests(
  traversalState,
  beforeEndRefetch,
  rootEntries.length - 1,
  rootEntries.length,
);
assert(
  JSON.stringify(endRefetch) === JSON.stringify([requestFor(null, lastRootOffset)]),
  `End did not safely refetch an evicted root page: ${JSON.stringify(endRefetch)}`,
);
loadRootTraversalPage(lastRootOffset, true);

const focusIndex = Math.floor(rootEntries.length / 2);
const focusOffset = Math.floor(focusIndex / pageLimit) * pageLimit;
const beforeFocusRefetch = buildNavigatorTreeProjection(traversalState, new Set());
const focusRefetch = claimNavigatorTreePageRequests(
  traversalState,
  beforeFocusRefetch,
  focusIndex,
  focusIndex + 1,
);
assert(
  JSON.stringify(focusRefetch) === JSON.stringify([requestFor(null, focusOffset)]),
  `Focus did not safely refetch an evicted root page: ${JSON.stringify(focusRefetch)}`,
);
loadRootTraversalPage(focusOffset, true);

const deepSegments = Array.from(
  { length: 128 },
  (_, index) => `Depth-${String(index).padStart(3, "0")}`,
);
const deepActivePath = `${deepSegments.join("/")}/Active.md`;
const deepIndex = buildWorkspaceTreeIndex([syntheticNote(deepActivePath, "Active")]);
const deepLocation = deepIndex.pathLocations.get(deepActivePath);
assert(deepLocation, "The deep active note has no tree location.");
const deepState = createNavigatorTreeState("synthetic-deep", "generation-1");
retainNavigatorTreePages(deepState, [], deepLocation.pages);
const deepStarted = performance.now();
let deepResponseBytes = 0;
let deepestResponseBytes = 0;
for (const location of deepLocation.pages) {
  const entries = deepIndex.childrenByParent.get(location.parentPath) ?? [];
  const request = requestFor(location.parentPath, location.offset);
  assert(
    claimNavigatorTreePageRequest(deepState, request),
    `Deep reveal did not claim ${JSON.stringify(request)}.`,
  );
  const responseEntries = pageEntries(entries, request.offset);
  const responsePage = pageDescriptor(
    deepState,
    request.parentPath,
    request.offset,
    entries.length,
    responseEntries,
  );
  const encodedBytes = encodedTreePageResponseBytes(
    deepState.vaultId,
    responsePage,
    responseEntries,
  );
  deepResponseBytes += encodedBytes;
  deepestResponseBytes = Math.max(deepestResponseBytes, encodedBytes);
  applyPage(deepState, request, entries);
  assertHonestRetentionBound(deepState);
}
const deepRevealApplyMs = performance.now() - deepStarted;
const deepExpandedPaths = new Set(
  deepSegments.map((_, index) => deepSegments.slice(0, index + 1).join("/")),
);
const deepProjection = buildNavigatorTreeProjection(deepState, deepExpandedPaths);
assert(
  deepProjection.indexOfPath(deepActivePath) === deepSegments.length,
  "The pinned deep active path was not reconstructable after cache eviction.",
);

const uniqueParentChurn = runUniqueParentChurn();
const multiParentDeepViewport = runMultiParentDeepViewport();

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
      materializedInitialEntries,
      theoreticalViewportRows,
      liveMountedDomRows: null,
      liveMountedDomRowsEvidence: "Reported independently by scripts/check-navigator-tree.mjs.",
      encodedInitialTreeResponseBytes: {
        root: encodedTreePageResponseBytes(treeState.vaultId, initialRootPage, initialRootEntries),
        library: encodedTreePageResponseBytes(
          treeState.vaultId,
          initialLibraryPage,
          initialLibraryEntries,
        ),
      },
      nextVirtualRequest: requestWindow[0],
      fullRootTraversal: {
        pagesApplied,
        elapsedMs: Math.round(fullTraversalMs * 100) / 100,
        maximumRetainedPages: traversalMaximumPages,
        maximumRetainedEntries: traversalMaximumEntries,
        maximumProjectionSegments: traversalMaximumSegments,
        homeRefetch: homeRefetch[0],
        endRefetch: endRefetch[0],
        focusRefetch: focusRefetch[0],
      },
      deepReveal: {
        depth: deepSegments.length,
        parallelPageRequests: deepLocation.pages.length,
        applyMs: Math.round(deepRevealApplyMs * 100) / 100,
        encodedResponseBytes: deepResponseBytes,
        largestPageResponseBytes: deepestResponseBytes,
        retained: navigatorTreeRetentionCounts(deepState),
        activeIndex: deepProjection.indexOfPath(deepActivePath),
      },
      cacheAdversarial: {
        uniqueParentChurn,
        multiParentDeepViewport,
      },
      rssMiB: megabytes(memory.rss),
      heapUsedMiB: megabytes(memory.heapUsed),
    },
    null,
    2,
  )}\n`,
);

assert(
  uniqueParentChurn.bounded,
  `Unique-parent churn exceeded the cache bound: ${JSON.stringify(uniqueParentChurn)}.`,
);
assert(
  multiParentDeepViewport.currentViewportIntact,
  `The current multi-parent viewport was not materialized: ${JSON.stringify(multiParentDeepViewport)}.`,
);
assert(
  multiParentDeepViewport.activeRevealTargetIndex === multiParentDeepViewport.depth,
  `The active reveal target was not addressable: ${JSON.stringify(multiParentDeepViewport)}.`,
);
assert(
  multiParentDeepViewport.activeRevealPagesMandatory,
  `The active reveal pages were not mandatory: ${JSON.stringify(multiParentDeepViewport)}.`,
);
assert(
  multiParentDeepViewport.bounded,
  `The multi-parent viewport exceeded the cache bound: ${JSON.stringify(multiParentDeepViewport)}.`,
);
