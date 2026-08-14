import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function cdpTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(500),
  });
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}.`);
  return response.json();
}

export async function waitForCdpTarget(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not listening";
  while (Date.now() < deadline) {
    try {
      const targets = await cdpTargets(port);
      const target = targets.find(
        (candidate) =>
          candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string",
      );
      if (target) return target;
      lastError = "no public page target";
    } catch (error) {
      lastError = String(error);
    }
    await delay(100);
  }
  throw new Error(`CDP target was unavailable: ${lastError}`);
}

export function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), {
      once: true,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("CDP WebSocket closed."));
    pending.clear();
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close() {
      socket.close();
    },
  };
}

export async function evaluate(cdp, expression) {
  assert(
    !/outerHTML|outerText|innerHTML|globalThis|window\.__|sourceMappingURL|document\.scripts/iu.test(
      expression,
    ),
    "CDP evaluator rejected a private or unbounded observation expression.",
  );
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response?.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "Renderer evaluation failed.",
    );
  }
  return response?.result?.value;
}

export async function waitForVisibleState(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const first = await visibleState(cdp);
      await delay(100);
      const second = await visibleState(cdp);
      last = second;
      if (
        first.readyState === "complete" &&
        second.readyState === "complete" &&
        first.visibleText === second.visibleText &&
        first.title === second.title &&
        first.viewport.width === second.viewport.width &&
        first.viewport.height === second.viewport.height &&
        second.visibleText.length > 20
      ) {
        return second;
      }
    } catch {
      // The app can replace its renderer while it starts.
    }
    await delay(100);
  }
  throw new Error(`Visible shell did not stabilize: ${JSON.stringify(last)}`);
}

export async function visibleState(cdp) {
  const state = await evaluate(
    cdp,
    `(() => {
      const root = document.documentElement;
      const body = document.body;
      const bodyRect = body?.getBoundingClientRect();
      const text = (body?.innerText ?? "").slice(0, 2400);
      const style = getComputedStyle(root);
      return {
        readyState: document.readyState,
        title: String(document.title ?? "").slice(0, 256),
        visibleText: text,
        visibleTextLength: text.length,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          deviceScaleFactor: devicePixelRatio,
          pageScale: visualViewport?.scale ?? 1,
        },
        surface: {
          width: bodyRect?.width ?? 0,
          height: bodyRect?.height ?? 0,
          overflowX: body ? body.scrollWidth - body.clientWidth : 0,
          overflowY: body ? body.scrollHeight - body.clientHeight : 0,
        },
        colorScheme: style.colorScheme,
      };
    })()`,
  );
  assert(state && typeof state === "object", "Visible state was not an object.");
  return state;
}

function truncateText(value, maximum = 256) {
  return typeof value === "string" ? value.slice(0, maximum) : undefined;
}

export async function normalizedAxTree(cdp, { maxNodes = 256 } = {}) {
  const response = await cdp.send("Accessibility.getFullAXTree");
  const nodes = Array.isArray(response?.nodes) ? response.nodes.slice(0, maxNodes) : [];
  return {
    schemaVersion: 1,
    nodeCount: response?.nodes?.length ?? 0,
    truncated: (response?.nodes?.length ?? 0) > maxNodes,
    nodes: nodes.map((node) => ({
      role: truncateText(node.role?.value),
      name: truncateText(node.name?.value),
      description: truncateText(node.description?.value),
      value: truncateText(node.value?.value),
      level: node.level?.value,
      orientation: node.orientation?.value,
      checked: node.checked?.value,
      selected: node.selected?.value,
      expanded: node.expanded?.value,
      disabled: node.disabled?.value,
      modal: node.modal?.value,
      childCount: Array.isArray(node.childIds) ? node.childIds.length : 0,
    })),
  };
}

export async function captureSurface(cdp, destination) {
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  assert(typeof result?.data === "string", "CDP returned no surface screenshot.");
  const bytes = Buffer.from(result.data, "base64");
  assert(bytes.length > 1_024, "Surface screenshot is unexpectedly small.");
  await fs.writeFile(destination, bytes, { mode: 0o600 });
  await fs.chmod(destination, 0o600);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function closeViaCdp(cdp) {
  try {
    await cdp.send("Browser.close");
  } catch {
    try {
      await evaluate(cdp, "window.close(); true");
    } catch {
      // The process supervisor remains responsible for cleanup.
    }
  }
}
