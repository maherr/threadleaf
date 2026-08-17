import { Events } from "./obsidian-events";

export class WorkspaceItem extends Events {
  parent: WorkspaceParent | null = null;

  getRoot(): WorkspaceItem {
    let current: WorkspaceItem = this;
    const visited = new Set<WorkspaceItem>();
    while (current.parent && !visited.has(current)) {
      visited.add(current);
      current = current.parent;
    }
    return current;
  }

  getContainer(): WorkspaceItem {
    return this.getRoot();
  }
}

export class WorkspaceParent extends WorkspaceItem {}
