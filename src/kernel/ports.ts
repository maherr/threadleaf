export interface StateRootPort {
  getPath(): Promise<string>;
}

export interface VaultTextSnapshot {
  path: string;
  content: string;
  revision: string;
  size: number;
}

export interface VaultReadPort {
  getName(): string;
  listMarkdownPaths(relativeDirectory?: string): Promise<string[]>;
  readText(relativePath: string): Promise<VaultTextSnapshot>;
}

export class FixedStateRoot implements StateRootPort {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async getPath(): Promise<string> {
    return this.#path;
  }
}
