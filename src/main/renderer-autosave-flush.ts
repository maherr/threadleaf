import type {
  AutosaveFlushReason,
  AutosaveFlushRequest,
  AutosaveFlushResult,
} from "../shared/autosave";

interface PendingFlush {
  senderId: number;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RendererAutosaveFlushCoordinatorOptions {
  send(senderId: number, request: AutosaveFlushRequest): void;
  timeoutMs?: number;
}

export class RendererAutosaveFlushCoordinator {
  readonly #send: RendererAutosaveFlushCoordinatorOptions["send"];
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingFlush>();

  constructor(options: RendererAutosaveFlushCoordinatorOptions) {
    this.#send = options.send;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  request(senderId: number, reason: AutosaveFlushReason): Promise<void> {
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Renderer autosave flush timed out during ${reason}.`));
      }, this.#timeoutMs);
      this.#pending.set(requestId, { senderId, resolve, reject, timer });
      try {
        this.#send(senderId, { requestId, reason });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  complete(senderId: number, result: AutosaveFlushResult): boolean {
    const pending = this.#pending.get(result.requestId);
    if (!pending || pending.senderId !== senderId) {
      return false;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(result.requestId);
    if (result.status === "flushed") {
      pending.resolve();
    } else {
      pending.reject(new Error(result.message));
    }
    return true;
  }

  cancelSender(senderId: number, message = "Renderer closed before autosave completed."): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.senderId !== senderId) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.reject(new Error(message));
    }
  }
}
