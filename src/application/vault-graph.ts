import type { MetadataIndexSnapshot } from "../kernel/metadata-index";
import { displayTitleFromVaultPath, normalizeMarkdownNotePath } from "../kernel/note-path";
import type {
  VaultGraphEdge,
  VaultGraphMode,
  VaultGraphNode,
  VaultGraphProjection,
} from "../shared/contracts";

export const MAX_GRAPH_NODES = 400;
export const MAX_GRAPH_EDGES = 1_200;

export interface VaultGraphProjectionOptions {
  mode: VaultGraphMode;
  rootPath: string | null;
  depth: number;
  query: string;
  includeOrphans: boolean;
  maxNodes?: number;
  maxEdges?: number;
}

export function parseVaultGraphRequest(value: unknown): VaultGraphProjectionOptions {
  if (typeof value !== "object" || value === null) {
    throw new Error("Vault graph requires an options object.");
  }
  const request = value as Record<string, unknown>;
  if (request.mode !== "global" && request.mode !== "local") {
    throw new Error("Vault graph mode must be global or local.");
  }
  if (
    !Number.isInteger(request.depth) ||
    (request.depth as number) < 1 ||
    (request.depth as number) > 4
  ) {
    throw new Error("Vault graph depth must be an integer between 1 and 4.");
  }
  if (
    typeof request.query !== "string" ||
    request.query.length > 200 ||
    request.query.includes("\0")
  ) {
    throw new Error("Vault graph queries must be strings of at most 200 characters.");
  }
  if (typeof request.includeOrphans !== "boolean") {
    throw new Error("Vault graph orphan visibility must be a boolean.");
  }
  if (request.mode === "local" && typeof request.rootPath !== "string") {
    throw new Error("A local vault graph requires a Markdown root path.");
  }
  if (request.mode === "global" && request.rootPath !== null) {
    throw new Error("A global vault graph cannot have a root path.");
  }
  return {
    mode: request.mode,
    rootPath:
      request.mode === "local" ? normalizeMarkdownNotePath(request.rootPath as string) : null,
    depth: request.depth as number,
    query: request.query.trim(),
    includeOrphans: request.includeOrphans,
  };
}

interface GraphCounts {
  incoming: number;
  outgoing: number;
}

function queryMatches(path: string, tags: readonly string[], query: string): boolean {
  const terms = query.normalize("NFC").toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const searchable = `${path} ${displayTitleFromVaultPath(path)} ${tags.join(" ")}`
    .normalize("NFC")
    .toLocaleLowerCase("en-US");
  return terms.every((term) => searchable.includes(term));
}

function edgeKey(source: string, target: string): string {
  return `${source}\0${target}`;
}

function graphEdges(index: MetadataIndexSnapshot): VaultGraphEdge[] {
  const paths = new Set(index.documents.map((document) => document.path));
  const occurrences = new Map<string, VaultGraphEdge>();
  for (const document of index.documents) {
    for (const link of document.links) {
      const target = link.resolution.status === "resolved" ? link.resolution.path : undefined;
      if (!target || !paths.has(target)) {
        continue;
      }
      const key = edgeKey(document.path, target);
      const existing = occurrences.get(key);
      if (existing) {
        existing.occurrences += 1;
      } else {
        occurrences.set(key, {
          source: document.path,
          target,
          occurrences: 1,
        });
      }
    }
  }
  return [...occurrences.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source, "en-US") ||
      left.target.localeCompare(right.target, "en-US"),
  );
}

function adjacencyFor(
  paths: Iterable<string>,
  edges: readonly VaultGraphEdge[],
): Map<string, Set<string>> {
  const adjacency = new Map([...paths].map((path) => [path, new Set<string>()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

function countsFor(
  paths: Iterable<string>,
  edges: readonly VaultGraphEdge[],
): Map<string, GraphCounts> {
  const counts = new Map([...paths].map((path) => [path, { incoming: 0, outgoing: 0 }]));
  for (const edge of edges) {
    const source = counts.get(edge.source);
    const target = counts.get(edge.target);
    if (source) {
      source.outgoing += edge.occurrences;
    }
    if (target) {
      target.incoming += edge.occurrences;
    }
  }
  return counts;
}

function localDistances(
  rootPath: string,
  depth: number,
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  if (!adjacency.has(rootPath)) {
    throw new Error(`The local graph root is not indexed: ${rootPath}`);
  }
  const distances = new Map([[rootPath, 0]]);
  const queue = [rootPath];
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    if (path === undefined) {
      continue;
    }
    const distance = distances.get(path);
    if (distance === undefined || distance >= depth) {
      continue;
    }
    for (const neighbor of adjacency.get(path) ?? []) {
      if (distances.has(neighbor)) {
        continue;
      }
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

export function projectVaultGraph(
  index: MetadataIndexSnapshot,
  options: VaultGraphProjectionOptions,
): VaultGraphProjection {
  const maxNodes = Math.max(1, Math.min(MAX_GRAPH_NODES, options.maxNodes ?? MAX_GRAPH_NODES));
  const maxEdges = Math.max(1, Math.min(MAX_GRAPH_EDGES, options.maxEdges ?? MAX_GRAPH_EDGES));
  const documents = new Map(index.documents.map((document) => [document.path, document]));
  const allEdges = graphEdges(index);
  const adjacency = adjacencyFor(documents.keys(), allEdges);
  const counts = countsFor(documents.keys(), allEdges);
  const distances =
    options.mode === "local"
      ? localDistances(options.rootPath ?? "", options.depth, adjacency)
      : new Map<string, number>();

  const eligible = index.documents.filter((document) => {
    if (options.mode === "local" && !distances.has(document.path)) {
      return false;
    }
    if (
      options.mode === "global" &&
      !options.includeOrphans &&
      (adjacency.get(document.path)?.size ?? 0) === 0
    ) {
      return false;
    }
    if (options.mode === "local" && document.path === options.rootPath) {
      return true;
    }
    return queryMatches(document.path, document.tags, options.query);
  });

  eligible.sort((left, right) => {
    if (options.mode === "local") {
      const distanceDifference =
        (distances.get(left.path) ?? Number.MAX_SAFE_INTEGER) -
        (distances.get(right.path) ?? Number.MAX_SAFE_INTEGER);
      if (distanceDifference !== 0) {
        return distanceDifference;
      }
    }
    const leftDegree = adjacency.get(left.path)?.size ?? 0;
    const rightDegree = adjacency.get(right.path)?.size ?? 0;
    return rightDegree - leftDegree || left.path.localeCompare(right.path, "en-US");
  });

  const selectedDocuments = eligible.slice(0, maxNodes);
  const selectedPaths = new Set(selectedDocuments.map((document) => document.path));
  const eligiblePaths = new Set(eligible.map((document) => document.path));
  const eligibleEdges = allEdges.filter(
    (edge) => eligiblePaths.has(edge.source) && eligiblePaths.has(edge.target),
  );
  const selectedEdges = eligibleEdges
    .filter((edge) => selectedPaths.has(edge.source) && selectedPaths.has(edge.target))
    .sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.source.localeCompare(right.source, "en-US") ||
        left.target.localeCompare(right.target, "en-US"),
    )
    .slice(0, maxEdges);
  const nodes: VaultGraphNode[] = selectedDocuments
    .map((document) => {
      const nodeCounts = counts.get(document.path) ?? { incoming: 0, outgoing: 0 };
      return {
        path: document.path,
        title: displayTitleFromVaultPath(document.path),
        tags: [...document.tags],
        incomingCount: nodeCounts.incoming,
        outgoingCount: nodeCounts.outgoing,
        neighborCount: adjacency.get(document.path)?.size ?? 0,
        distance: options.mode === "local" ? (distances.get(document.path) ?? null) : null,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en-US"));

  return {
    mode: options.mode,
    rootPath: options.mode === "local" ? options.rootPath : null,
    depth: options.depth,
    query: options.query,
    includeOrphans: options.includeOrphans,
    totalNodes: eligible.length,
    totalEdges: eligibleEdges.length,
    truncated: eligible.length > nodes.length || eligibleEdges.length > selectedEdges.length,
    nodes,
    edges: selectedEdges,
  };
}
