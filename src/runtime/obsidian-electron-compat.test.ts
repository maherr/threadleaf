import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createElectronCompatibilityModule,
  ElectronCompatibilityActivity,
  LegacyRemoteBrowserWindow,
} from "./obsidian-electron-compat";

const servers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  servers.clear();
});

async function fixtureUrl(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind.");
  return `http://127.0.0.1:${address.port}/article`;
}

describe("legacy Electron compatibility", () => {
  it("preserves native exports and supplies the removed remote BrowserWindow", () => {
    const native = { ipcRenderer: { send() {} } };
    const compatible = createElectronCompatibilityModule(native) as {
      ipcRenderer: unknown;
      remote: { BrowserWindow: unknown };
    };
    expect(compatible.ipcRenderer).toBe(native.ipcRenderer);
    expect(compatible.remote.BrowserWindow).toBe(LegacyRemoteBrowserWindow);
  });

  it("loads a bounded HTTP page and exposes its decoded title through load events", async () => {
    const url = await fixtureUrl((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Threadleaf &amp; Open Notes</title>");
    });
    const window = new LegacyRemoteBrowserWindow({ show: false });
    const loaded = new Promise<void>((resolve, reject) => {
      window.webContents.on("did-finish-load", () => resolve());
      window.webContents.on("did-fail-load", reject);
    });
    await window.loadURL(url);
    await loaded;
    expect(window.webContents.getTitle()).toBe("Threadleaf & Open Notes");
    window.destroy();
  });

  it("fails closed for non-network schemes", async () => {
    const window = new LegacyRemoteBrowserWindow();
    const failed = new Promise<unknown>((resolve) => {
      window.webContents.on("did-fail-load", resolve);
    });
    await window.loadURL("file:///tmp/private.html");
    await expect(failed).resolves.toBeInstanceOf(Error);
  });

  it("lets the host await a fire-and-forget legacy window load", async () => {
    const url = await fixtureUrl((_request, response) => {
      setTimeout(() => response.end("<title>Settled title</title>"), 25);
    });
    const activity = new ElectronCompatibilityActivity();
    const compatible = createElectronCompatibilityModule({}, activity) as {
      remote: { BrowserWindow: new () => LegacyRemoteBrowserWindow };
    };
    const window = new compatible.remote.BrowserWindow();
    void window.loadURL(url);
    await activity.waitForIdle();
    expect(window.webContents.getTitle()).toBe("Settled title");
  });
});
