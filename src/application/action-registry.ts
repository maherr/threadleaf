export type ActionSource = "workspace" | "plugin" | "system";

export interface ActionSummary {
  id: string;
  name: string;
  source: ActionSource;
}

export interface ActionDefinition {
  id: string;
  name: string;
  source: ActionSource;
  execute: (payload: unknown) => unknown | Promise<unknown>;
}

interface RegisteredAction extends ActionDefinition {
  ownerId: string;
}

export class ActionRegistry {
  readonly #actions = new Map<string, RegisteredAction>();

  register(ownerId: string, action: ActionDefinition): () => void {
    if (this.#actions.has(action.id)) {
      throw new Error(`Action already registered: ${action.id}`);
    }
    this.#actions.set(action.id, { ...action, ownerId });
    return () => {
      const registered = this.#actions.get(action.id);
      if (registered?.ownerId === ownerId) {
        this.#actions.delete(action.id);
      }
    };
  }

  async dispatch<TResult = unknown>(actionId: string, payload?: unknown): Promise<TResult> {
    const action = this.#actions.get(actionId);
    if (!action) {
      throw new Error(`Action is not available: ${actionId}`);
    }
    return (await action.execute(payload)) as TResult;
  }

  list(source?: ActionSource): ActionSummary[] {
    return [...this.#actions.values()]
      .filter((action) => source === undefined || action.source === source)
      .map(({ id, name, source: actionSource }) => ({ id, name, source: actionSource }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
  }
}
