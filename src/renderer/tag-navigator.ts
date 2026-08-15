import type { WorkspaceTagSummary } from "../shared/contracts";

export interface TagNavigatorRow {
  tag: WorkspaceTagSummary;
  depth: number;
  siblingIndex: number;
  siblingCount: number;
  hasChildren: boolean;
  expanded: boolean;
  label: string;
}

export interface TagNavigatorProjection {
  rows: TagNavigatorRow[];
  indexByKey: ReadonlyMap<string, number>;
  childKeys: ReadonlyMap<string, readonly string[]>;
}

function compareTags(left: WorkspaceTagSummary, right: WorkspaceTagSummary): number {
  return (
    left.tag.localeCompare(right.tag, "en-US", { sensitivity: "base", numeric: true }) ||
    left.tag.localeCompare(right.tag, "en-US")
  );
}

export function buildTagNavigatorProjection(
  tags: readonly WorkspaceTagSummary[],
  expandedKeys: ReadonlySet<string>,
): TagNavigatorProjection {
  const tagsByKey = new Map(tags.map((tag) => [tag.key, tag]));
  const childTags = new Map<string | null, WorkspaceTagSummary[]>();
  for (const tag of tags) {
    const parentKey = tag.parentKey && tagsByKey.has(tag.parentKey) ? tag.parentKey : null;
    const siblings = childTags.get(parentKey) ?? [];
    siblings.push(tag);
    childTags.set(parentKey, siblings);
  }
  for (const siblings of childTags.values()) siblings.sort(compareTags);

  const rows: TagNavigatorRow[] = [];
  const visited = new Set<string>();
  const walk = (parentKey: string | null, depth: number): void => {
    const siblings = childTags.get(parentKey) ?? [];
    for (const [siblingIndex, tag] of siblings.entries()) {
      if (visited.has(tag.key)) continue;
      visited.add(tag.key);
      const children = childTags.get(tag.key) ?? [];
      const expanded = children.length > 0 && expandedKeys.has(tag.key);
      rows.push({
        tag,
        depth,
        siblingIndex,
        siblingCount: siblings.length,
        hasChildren: children.length > 0,
        expanded,
        label: parentKey ? (tag.tag.split("/").at(-1) ?? tag.tag) : tag.tag,
      });
      if (expanded) walk(tag.key, depth + 1);
    }
  };
  walk(null, 1);

  return {
    rows,
    indexByKey: new Map(rows.map((row, index) => [row.tag.key, index])),
    childKeys: new Map(
      [...childTags.entries()]
        .filter((entry): entry is [string, WorkspaceTagSummary[]] => entry[0] !== null)
        .map(([key, children]) => [key, children.map((tag) => tag.key)]),
    ),
  };
}

export function expandableTagKeys(tags: readonly WorkspaceTagSummary[]): Set<string> {
  const parentKeys = new Set(tags.flatMap((tag) => (tag.parentKey ? [tag.parentKey] : [])));
  return new Set(tags.filter((tag) => parentKeys.has(tag.key)).map((tag) => tag.key));
}
