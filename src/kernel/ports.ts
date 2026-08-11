export interface StateRootPort {
  getPath(): Promise<string>;
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
