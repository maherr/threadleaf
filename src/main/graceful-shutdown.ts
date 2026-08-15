export interface QuitEventLike {
  preventDefault(): void;
}

export interface GracefulShutdownOptions {
  preflight?: () => Promise<void> | void;
  prepare?: () => void;
  close: () => Promise<void> | void;
  finalize?: () => void;
  quit: () => void;
  reportError?: (error: unknown) => void;
}

export function createGracefulShutdownHandler(
  options: GracefulShutdownOptions,
): (event: QuitEventLike) => void {
  let state: "idle" | "preflighting" | "closing" | "complete" = "idle";

  const reportError = (error: unknown): void => {
    options.reportError?.(error);
  };

  const closeAndQuit = (): void => {
    state = "closing";
    try {
      options.prepare?.();
    } catch (error) {
      reportError(error);
    }

    let closeResult: Promise<void> | void;
    try {
      closeResult = options.close();
    } catch (error) {
      reportError(error);
      closeResult = undefined;
    }

    void Promise.resolve(closeResult)
      .catch(reportError)
      .finally(() => {
        try {
          options.finalize?.();
        } catch (error) {
          reportError(error);
        } finally {
          state = "complete";
          options.quit();
        }
      });
  };

  return (event) => {
    if (state === "complete") {
      return;
    }
    event.preventDefault();
    if (state === "preflighting" || state === "closing") {
      return;
    }
    if (!options.preflight) {
      closeAndQuit();
      return;
    }
    state = "preflighting";
    void Promise.resolve()
      .then(options.preflight)
      .then(closeAndQuit)
      .catch((error) => {
        reportError(error);
        state = "idle";
      });
  };
}
