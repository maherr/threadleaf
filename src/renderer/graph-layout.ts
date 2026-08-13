import type { VaultGraphNode, VaultGraphProjection } from "../shared/contracts";

export const GRAPH_VIEWBOX_WIDTH = 1_000;
export const GRAPH_VIEWBOX_HEIGHT = 700;

export interface PositionedGraphNode extends VaultGraphNode {
  x: number;
  y: number;
  radius: number;
}

function nodeWeight(node: VaultGraphNode): number {
  return node.incomingCount + node.outgoingCount + node.neighborCount;
}

function nodeRadius(node: VaultGraphNode): number {
  return Math.min(17, 6 + Math.sqrt(nodeWeight(node)) * 1.7);
}

function byWeightThenPath(left: VaultGraphNode, right: VaultGraphNode): number {
  return nodeWeight(right) - nodeWeight(left) || left.path.localeCompare(right.path, "en-US");
}

function onRing(
  nodes: readonly VaultGraphNode[],
  radius: number,
  centerX: number,
  centerY: number,
  phase = -Math.PI / 2,
): PositionedGraphNode[] {
  return nodes.map((node, index) => {
    const angle = phase + (index * Math.PI * 2) / Math.max(1, nodes.length);
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      radius: nodeRadius(node),
    };
  });
}

function layoutLocalGraph(projection: VaultGraphProjection): PositionedGraphNode[] {
  const centerX = GRAPH_VIEWBOX_WIDTH / 2;
  const centerY = GRAPH_VIEWBOX_HEIGHT / 2;
  const byDistance = new Map<number, VaultGraphNode[]>();
  for (const node of projection.nodes) {
    const distance = node.distance ?? 0;
    const nodes = byDistance.get(distance) ?? [];
    nodes.push(node);
    byDistance.set(distance, nodes);
  }
  const positioned: PositionedGraphNode[] = [];
  for (const [distance, nodes] of [...byDistance.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    nodes.sort(byWeightThenPath);
    if (distance === 0) {
      positioned.push(
        ...nodes.map((node) => ({
          ...node,
          x: centerX,
          y: centerY,
          radius: nodeRadius(node) + 2,
        })),
      );
      continue;
    }
    const radius = Math.min(310, 140 + (distance - 1) * 78);
    positioned.push(...onRing(nodes, radius, centerX, centerY, distance * 0.37 - Math.PI / 2));
  }
  return positioned;
}

function layoutGlobalGraph(projection: VaultGraphProjection): PositionedGraphNode[] {
  const nodes = [...projection.nodes].sort(byWeightThenPath);
  const centerX = GRAPH_VIEWBOX_WIDTH / 2;
  const centerY = GRAPH_VIEWBOX_HEIGHT / 2;
  const first = nodes.shift();
  if (!first) {
    return [];
  }
  const positioned: PositionedGraphNode[] = [
    {
      ...first,
      x: centerX,
      y: centerY,
      radius: nodeRadius(first) + 2,
    },
  ];
  let ring = 1;
  while (nodes.length > 0) {
    const capacity = ring * 10;
    const group = nodes.splice(0, capacity);
    const radius = Math.min(310, 135 + ring * 70);
    positioned.push(...onRing(group, radius, centerX, centerY, ring * 0.41 - Math.PI / 2));
    ring += 1;
  }
  return positioned;
}

export function layoutVaultGraph(projection: VaultGraphProjection): PositionedGraphNode[] {
  return projection.mode === "local" ? layoutLocalGraph(projection) : layoutGlobalGraph(projection);
}
