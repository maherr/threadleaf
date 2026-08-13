export interface MainWindowNavigationGuardHost {
  on(
    event: "will-navigate",
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): unknown;
}

/** Keep the primary renderer on its local application document. */
export function installMainWindowNavigationGuards(
  webContents: MainWindowNavigationGuardHost,
): void {
  webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
