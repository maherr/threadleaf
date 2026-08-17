import type {
  AdapterStat,
  DataWriteOptions,
  FileSystemAdapter,
  ListedFiles,
} from "./obsidian-compat";

/**
 * Mobile-only adapter boundary from Obsidian's public API.
 *
 * Threadleaf is a desktop Electron application, so the default instance is deliberately
 * unbound. Tests and future mobile work may provide the existing vault adapter as a delegate;
 * no desktop path is silently presented as Capacitor support.
 */
export class CapacitorAdapter {
  private readonly delegate: FileSystemAdapter | null;

  constructor(delegate: FileSystemAdapter | null = null) {
    this.delegate = delegate;
  }

  getName(): string {
    return this.delegate?.getName() ?? "Threadleaf desktop (Capacitor unavailable)";
  }

  async mkdir(normalizedPath: string): Promise<void> {
    await this.requireDelegate().mkdir(normalizedPath);
  }

  trashSystem(_normalizedPath: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    await this.requireDelegate().trashLocal(normalizedPath);
  }

  rmdir(_normalizedPath: string, _recursive: boolean): Promise<void> {
    return this.unavailable("rmdir");
  }

  async read(normalizedPath: string): Promise<string> {
    return this.requireDelegate().read(normalizedPath);
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    return this.requireDelegate().readBinary(normalizedPath);
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    await this.requireDelegate().write(normalizedPath, data, options);
  }

  async writeBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    await this.requireDelegate().writeBinary(normalizedPath, data, options);
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    await this.requireDelegate().append(normalizedPath, data, options);
  }

  async appendBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    await this.requireDelegate().appendBinary(normalizedPath, data, options);
  }

  async process(
    normalizedPath: string,
    callback: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    return this.requireDelegate().process(normalizedPath, callback, options);
  }

  getResourcePath(normalizedPath: string): string {
    return this.requireDelegate().getResourcePath(normalizedPath);
  }

  remove(_normalizedPath: string): Promise<void> {
    return this.unavailable("remove");
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    await this.requireDelegate().rename(normalizedPath, normalizedNewPath);
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    await this.requireDelegate().copy(normalizedPath, normalizedNewPath);
  }

  async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
    return this.requireDelegate().exists(normalizedPath, sensitive);
  }

  async stat(normalizedPath: string): Promise<AdapterStat | null> {
    return this.requireDelegate().stat(normalizedPath);
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    return this.requireDelegate().list(normalizedPath);
  }

  getFullPath(normalizedPath: string): string {
    return this.requireDelegate().getFullPath(normalizedPath);
  }

  private requireDelegate(): FileSystemAdapter {
    if (!this.delegate) {
      throw new Error("CapacitorAdapter is unsupported in Threadleaf's desktop renderer.");
    }
    return this.delegate;
  }

  private unavailable(operation: string): Promise<never> {
    return Promise.reject(
      new Error(`CapacitorAdapter.${operation} is unsupported in Threadleaf's desktop renderer.`),
    );
  }
}
