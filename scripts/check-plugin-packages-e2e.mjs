import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-plugin-packages-e2e-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const screenshotDirectory = process.env.THREADLEAF_PLUGIN_PACKAGE_SCREENSHOT_DIR;
const pluginId = "obsidian-excalidraw-plugin";
const pluginPath = path.join(vaultPath, ".obsidian", "plugins", pluginId);
const output = [];
let child;
let exited;
let cdp;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback debugging port.");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForMainTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const main = targets.find(
          (target) =>
            target.type === "page" &&
            typeof target.url === "string" &&
            target.url.endsWith("/dist/renderer/index.html"),
        );
        if (main?.webSocketDebuggerUrl) {
          return main;
        }
      }
    } catch {
      // The debugging endpoint is not ready yet.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its renderer within 10 seconds.");
}

function connectCdp(webSocketUrl) {
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
    if (!request) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result);
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      request.reject(new Error("CDP WebSocket closed."));
    }
    pending.clear();
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "Renderer evaluation failed.",
    );
  }
  return response.result?.value;
}

async function waitFor(expression, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(expression);
    if (lastValue) {
      return lastValue;
    }
    await delay(50);
  }
  throw new Error(`${message} Last value: ${JSON.stringify(lastValue)}`);
}

async function click(selector) {
  await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) {
      throw new Error("Button is missing or disabled: " + ${JSON.stringify(selector)});
    }
    element.click();
    return true;
  })()`);
}

async function clickRowAction(containerSelector, label) {
  await evaluate(`(() => {
    const container = document.querySelector(${JSON.stringify(containerSelector)});
    const button = [...(container?.querySelectorAll("button") ?? [])].find(
      (candidate) => candidate.textContent?.trim() === ${JSON.stringify(label)},
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error("Row action is missing or disabled: " + ${JSON.stringify(label)});
    }
    button.click();
    return true;
  })()`);
}

async function setInput(selector, value) {
  await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement) || input.disabled) {
      throw new Error("Input is missing or disabled: " + ${JSON.stringify(selector)});
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
}

async function setTheme(theme) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await evaluate("document.documentElement.dataset.theme")) === theme) {
      return;
    }
    await click("#theme-toggle");
    await delay(100);
  }
  throw new Error(`Threadleaf did not switch to ${theme} mode.`);
}

async function readLiveThemeColors(theme) {
  await setTheme(theme);
  return evaluate(`(() => {
    const probe = document.createElement("div");
    probe.hidden = true;
    document.body.append(probe);
    const resolveColor = (token, property) => {
      probe.style.removeProperty("color");
      probe.style.removeProperty("background-color");
      probe.style.setProperty(property, "var(" + token + ")");
      return getComputedStyle(probe).getPropertyValue(property);
    };
    const colors = {
      accent: resolveColor("--accent", "color"),
      accentStrong: resolveColor("--accent-strong", "color"),
      accentSoft: resolveColor("--accent-soft", "background-color"),
      signal: resolveColor("--signal", "color"),
      signalSoft: resolveColor("--signal-soft", "background-color"),
      surface: resolveColor("--surface", "background-color"),
    };
    probe.remove();
    return colors;
  })()`);
}

async function reveal(selector) {
  await evaluate(`(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) {
      throw new Error("Element is missing: " + ${JSON.stringify(selector)});
    }
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    const settingsContent = element.closest(".settings-content");
    if (settingsContent instanceof HTMLElement) {
      const contentRect = settingsContent.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      settingsContent.scrollTo({
        top:
          settingsContent.scrollTop +
          elementRect.top -
          contentRect.top -
          Math.max(0, (contentRect.height - elementRect.height) / 2),
        left: 0,
        behavior: "auto",
      });
    } else {
      element.scrollIntoView({ block: "center", inline: "nearest" });
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
}

async function screenshot(name, theme) {
  if (!screenshotDirectory) {
    return null;
  }
  await setTheme(theme);
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const capture = await cdp.send("Page.captureScreenshot", { format: "png" });
  const outputPath = path.join(screenshotDirectory, `${name}-${theme}.png`);
  await fs.writeFile(outputPath, Buffer.from(capture.data, "base64"));
  return outputPath;
}

async function openReviewFrom(containerSelector, label) {
  await clickRowAction(containerSelector, label);
  await waitFor(
    'document.querySelector("#plugin-package-review-dialog")?.open === true',
    `The ${label} review dialog did not open.`,
  );
}

async function applyReview() {
  await click("#plugin-package-review-apply");
  await waitFor(
    'document.querySelector("#plugin-package-review-dialog")?.open === false',
    "The reviewed package operation did not finish.",
    45_000,
  );
}

async function openAuthorityReview(containerSelector) {
  await clickRowAction(containerSelector, "Review authority");
  await waitFor(
    'document.querySelector("#plugin-authority-review-dialog")?.open === true',
    "The exact-bundle authority review did not open.",
  );
}

try {
  if (process.platform !== "linux") {
    throw new Error("The plugin package E2E check currently requires Linux and Xvfb.");
  }
  await fs.access(electronPath);
  await fs.mkdir(vaultPath, { recursive: true });
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(path.join(vaultPath, "Welcome.md"), "# Package manager fixture\n", "utf8");
  const rendererHtml = await fs.readFile(
    path.join(appRoot, "dist", "renderer", "index.html"),
    "utf8",
  );
  const builtScript = rendererHtml.match(/assets\/index-[^"']+\.js/u)?.[0];
  assert(builtScript, "The built renderer did not declare its hashed JavaScript asset.");

  const port = await availablePort();
  child = spawn(
    "xvfb-run",
    [
      "-a",
      electronPath,
      "--ozone-platform=x11",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataPath}`,
      "--disable-gpu",
      ".",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_VAULT_PATH: vaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const started = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output.push(String(chunk));
      if (output.length > 100) {
        output.shift();
      }
    });
  }
  await started;
  const target = await waitForMainTarget(port, Date.now() + 10_000);
  cdp = connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await waitFor(
    `(() => ({
      ready: document.querySelector("#runtime-state")?.textContent === "Ready",
      script: [...document.scripts].some((script) => script.src.endsWith(${JSON.stringify(builtScript)})),
    }))().ready && (() => [...document.scripts].some((script) => script.src.endsWith(${JSON.stringify(builtScript)})))()`,
    "The rebuilt renderer and disposable vault were not ready.",
  );

  await click("#settings-trigger");
  await click("#settings-nav-plugins");
  await waitFor(
    'document.querySelector("#plugin-status")?.textContent?.includes("discovered") && document.querySelector("#plugin-index-query")?.disabled === false',
    "Community plugin settings did not finish loading.",
  );
  await setInput("#plugin-index-query", "Excalidraw");
  await click("#plugin-index-search");
  const indexRow = `.plugin-index-row[data-plugin-id="${pluginId}"]`;
  await waitFor(
    `Boolean(document.querySelector(${JSON.stringify(indexRow)}))`,
    "The public index did not expose Excalidraw.",
  );
  await reveal(indexRow);
  const screenshots = [
    await screenshot("package-index", "dark"),
    await screenshot("package-index", "light"),
  ].filter(Boolean);
  const liveThemeColors = {
    dark: await readLiveThemeColors("dark"),
    light: await readLiveThemeColors("light"),
  };
  assert(
    (await evaluate(
      `document.querySelector(${JSON.stringify(`${indexRow} button`)})?.textContent?.trim()`,
    )) === "Review install",
    "The package-index review action lacks a stable accessible name.",
  );
  await openReviewFrom(indexRow, "Review install");
  const review = await evaluate(`(() => ({
    title: document.querySelector("#plugin-package-review-title")?.textContent,
    facts: Object.fromEntries(
      [...document.querySelectorAll("#plugin-package-facts dt")].map((term) => [
        term.textContent,
        term.nextElementSibling?.textContent ?? "",
      ]),
    ),
    assets: [...document.querySelectorAll("#plugin-package-assets code")].map((node) => node.textContent),
    license: document.querySelector("#plugin-package-license")?.textContent,
    summary: document.querySelector("#plugin-package-review-summary")?.textContent,
    actions: [...document.querySelectorAll("#plugin-package-review-dialog button")].map((button) =>
      button.getAttribute("aria-label") || button.textContent?.trim() || ""
    ),
    overflow: [...document.querySelectorAll("#plugin-package-facts, #plugin-package-assets, #plugin-package-license")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.id),
  }))()`);
  assert(review.title === "Excalidraw", "The review did not name the selected plugin.");
  const reviewedVersion = review.facts.Target;
  assert(
    typeof reviewedVersion === "string" && reviewedVersion.length > 0,
    "The review omitted the exact target version.",
  );
  assert(review.assets.length === 3, "The review did not list all three release assets.");
  assert(
    review.assets.every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
    "The review did not expose full SHA-256 asset hashes.",
  );
  assert(review.license.includes("AGPL-3.0"), "The review omitted the retained AGPL license.");
  assert(
    review.actions.includes("Apply reviewed change") && review.actions.includes("Cancel"),
    "The package review actions lack stable accessible names.",
  );
  assert(review.overflow.length === 0, `Package review overflowed: ${review.overflow.join(", ")}`);
  screenshots.push(
    ...[
      await screenshot("package-review", "dark"),
      await screenshot("package-review", "light"),
    ].filter(Boolean),
  );

  await applyReview();
  const installedRow = `.plugin-row[data-plugin-id="${pluginId}"]`;
  await waitFor(
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes("SHA-256 verified")`,
    "The installed package did not report verified managed bytes.",
  );
  const installedState = await evaluate(`(async () => {
    const row = document.querySelector(${JSON.stringify(installedRow)});
    const snapshot = await window.threadleaf.getSnapshot();
    return {
      text: row?.textContent ?? "",
      checked: row?.querySelector('input[type="checkbox"]')?.checked ?? null,
      runtimeState: row?.querySelector(".plugin-runtime-state")?.textContent ?? "",
      authorityState: row?.querySelector(".plugin-authority-summary strong")?.textContent ?? "",
      authorityAction: [...(row?.querySelectorAll("button") ?? [])].find((button) =>
        button.textContent?.trim() === "Review authority"
      )?.textContent?.trim() ?? "",
      preflightBadges: [...(row?.querySelectorAll(".plugin-preflight-badge") ?? [])].map(
        (badge) => badge.textContent?.trim() ?? "",
      ),
      toggleDisabled: row?.querySelector('input[type="checkbox"]')?.disabled ?? null,
      loaded: (snapshot.plugins ?? []).some((plugin) => plugin.id === ${JSON.stringify(pluginId)} && plugin.state === "loaded"),
    };
  })()`);
  assert(installedState.checked === false, "A newly installed plugin was silently enabled.");
  assert(
    installedState.runtimeState === "Review required",
    "The installed plugin did not visibly require authority review.",
  );
  assert(
    installedState.authorityState.includes("Authority review required") &&
      installedState.authorityAction === "Review authority" &&
      installedState.toggleDisabled === true,
    "The exact-bundle review gate relied on color or left the enable toggle reachable.",
  );
  assert(
    installedState.preflightBadges.some((badge) =>
      badge.startsWith("Declared minimum Obsidian "),
    ) && !installedState.preflightBadges.some((badge) => badge.includes("Obsidian API")),
    "The installed package did not render its declared minimum Obsidian provenance.",
  );
  assert(installedState.loaded === false, "A newly installed bundle executed without enablement.");
  const receipt = JSON.parse(
    await fs.readFile(path.join(pluginPath, ".threadleaf-package.json"), "utf8"),
  );
  assert(
    receipt.pluginVersion === reviewedVersion,
    "The installed receipt differs from the reviewed exact version.",
  );
  assert(
    receipt.inspection &&
      Number.isInteger(receipt.inspection.compatibilityLevel) &&
      receipt.inspection.compatibilityLevel <= 3 &&
      receipt.inspection.staticAuthority?.staticOnly === true,
    "The installed receipt did not retain one bounded static inspection authority.",
  );
  assert(
    receipt.inspection.limitations?.some((limitation) => limitation.includes("not a sandbox")),
    "The installed inspection receipt omitted its non-sandbox limitation.",
  );
  assert(
    (await fs.readFile(path.join(pluginPath, "LICENSE.threadleaf.txt"), "utf8")).includes(
      "GNU AFFERO GENERAL PUBLIC LICENSE",
    ),
    "The installed package did not retain its license text.",
  );
  await reveal(installedRow);
  screenshots.push(
    ...[
      await screenshot("package-installed", "dark"),
      await screenshot("package-installed", "light"),
    ].filter(Boolean),
  );

  await click("#plugin-mode-toggle");
  await waitFor(
    'document.querySelector("#plugin-mode-state")?.textContent === "Enabled"',
    "Compatibility mode did not enable for the authority probe.",
  );
  const rejectedWithoutGrant = await evaluate(`window.threadleaf
    .setPluginEnabled(${JSON.stringify(await evaluate("window.threadleaf.getSnapshot().then((snapshot) => snapshot.vault.id)"))}, ${JSON.stringify(pluginId)}, true)
    .then(() => "unexpected-success", (error) => String(error))`);
  assert(
    rejectedWithoutGrant.includes("requires a current exact-bundle authority grant"),
    "Direct renderer IPC bypassed the main-process exact-bundle grant gate.",
  );
  await openAuthorityReview(installedRow);
  const authorityReview = await evaluate(`(() => ({
    title: document.querySelector("#plugin-authority-review-title")?.textContent ?? "",
    summary: document.querySelector("#plugin-authority-review-summary")?.textContent ?? "",
    hash: [...document.querySelectorAll("#plugin-authority-review-facts dt")].find(
      (term) => term.textContent === "main.js SHA-256"
    )?.nextElementSibling?.textContent ?? "",
    items: [...document.querySelectorAll("#plugin-authority-review-list .plugin-authority-review-item")].map(
      (item) => item.textContent ?? ""
    ),
    warnings: [...document.querySelectorAll("#plugin-authority-review-warnings li")].map(
      (item) => item.textContent ?? ""
    ),
    action: document.querySelector("#plugin-authority-review-grant")?.textContent?.trim() ?? "",
    overflow: [...document.querySelectorAll("#plugin-authority-review-facts, #plugin-authority-review-list")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.id),
  }))()`);
  assert(authorityReview.title === "Excalidraw", "Authority review omitted the plugin name.");
  assert(
    /^[a-f0-9]{64}$/u.test(authorityReview.hash),
    "Authority review omitted the exact bundle hash.",
  );
  assert(
    authorityReview.items.length > 0,
    "Authority review omitted observed authority references.",
  );
  assert(
    authorityReview.warnings.some((warning) => warning.includes("not a sandbox")) &&
      authorityReview.warnings.some((warning) => warning.includes("blocks the plugin")),
    "Authority review omitted its static-scan and byte-change limits.",
  );
  assert(authorityReview.action === "Grant exact bundle", "Authority grant action was ambiguous.");
  assert(
    authorityReview.overflow.length === 0,
    `Authority review overflowed: ${authorityReview.overflow.join(", ")}`,
  );
  screenshots.push(
    ...[
      await screenshot("plugin-authority-review", "dark"),
      await screenshot("plugin-authority-review", "light"),
    ].filter(Boolean),
  );
  const minimumViewport = await evaluate("({ width: innerWidth, height: innerHeight })");
  assert(
    minimumViewport.width === 860 && minimumViewport.height === 640,
    `Authority review was not exercised at the supported 860x640 minimum: ${JSON.stringify(minimumViewport)}`,
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1180,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor("innerWidth === 1180 && innerHeight === 820", "The wide viewport did not apply.");
  const wideOverflow = await evaluate(`[
    ...document.querySelectorAll("#plugin-authority-review-facts, #plugin-authority-review-list"),
  ].some((element) => element.scrollWidth > element.clientWidth + 1)`);
  assert(wideOverflow === false, "Authority review overflowed at the standard desktop viewport.");
  screenshots.push(
    ...[
      await screenshot("plugin-authority-review-wide", "dark"),
      await screenshot("plugin-authority-review-wide", "light"),
    ].filter(Boolean),
  );
  if (screenshotDirectory) {
    const positiveControl = await evaluate(`(() => {
      const target = document.querySelector("#plugin-authority-review-list .plugin-authority-review-item");
      if (!(target instanceof HTMLElement)) {
        throw new Error("Authority positive-control target is missing.");
      }
      target.dataset.visualPositiveControl = "true";
      target.style.outline = "8px solid rgb(255, 0, 255)";
      target.style.outlineOffset = "-8px";
      return {
        marked: document.querySelectorAll('[data-visual-positive-control="true"]').length,
        outline: getComputedStyle(target).outlineColor,
      };
    })()`);
    assert(
      positiveControl.marked === 1 && positiveControl.outline === "rgb(255, 0, 255)",
      `Authority visual positive control did not reach exactly one target: ${JSON.stringify(positiveControl)}`,
    );
    screenshots.push(await screenshot("plugin-authority-positive-control", "dark"));
    const positiveControlCleared = await evaluate(`(() => {
      const target = document.querySelector('[data-visual-positive-control="true"]');
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      target.style.removeProperty("outline");
      target.style.removeProperty("outline-offset");
      delete target.dataset.visualPositiveControl;
      return document.querySelectorAll('[data-visual-positive-control="true"]').length === 0;
    })()`);
    assert(positiveControlCleared, "Authority visual positive control did not cleanly revert.");
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await waitFor(
    "innerWidth === 860 && innerHeight === 640",
    "The minimum viewport did not restore.",
  );
  await click("#plugin-authority-review-grant");
  await waitFor(
    'document.querySelector("#plugin-authority-review-dialog")?.open === false',
    "The exact-bundle authority grant did not finish.",
  );
  await waitFor(
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes("Exact bundle granted")`,
    "The installed row did not expose its granted exact bundle.",
  );
  const enabledAfterGrant = await evaluate(`(async () => {
    const row = document.querySelector(${JSON.stringify(installedRow)});
    const toggle = row?.querySelector('input[type="checkbox"]');
    if (!(toggle instanceof HTMLInputElement) || toggle.disabled) {
      throw new Error("The plugin toggle remained unreachable after an exact-bundle grant.");
    }
    toggle.click();
    const deadline = Date.now() + 60000;
    let snapshot = await window.threadleaf.getSnapshot();
    while (Date.now() < deadline) {
      snapshot = await window.threadleaf.getSnapshot();
      if ((snapshot.plugins ?? []).some((plugin) =>
        plugin.id === ${JSON.stringify(pluginId)} &&
        plugin.state === "loaded" &&
        plugin.compatibilityLevel >= 2
      )) {
        return { loaded: true, snapshot };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      loaded: false,
      snapshot,
      rowText: document.querySelector(${JSON.stringify(installedRow)})?.textContent ?? "",
      status: document.querySelector("#plugin-status")?.textContent ?? "",
    };
  })()`);
  assert(
    enabledAfterGrant.loaded === true,
    `A granted exact bundle did not load through the real runtime: ${JSON.stringify(enabledAfterGrant)}`,
  );
  await waitFor(
    `(() => {
      const row = document.querySelector(${JSON.stringify(installedRow)});
      const action = [...(row?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent?.trim() === "Revoke grant",
      );
      return action instanceof HTMLButtonElement && !action.disabled;
    })()`,
    "The authority controls did not settle after plugin activation.",
  );
  await clickRowAction(installedRow, "Revoke grant");
  await waitFor(
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes("Authority review required")`,
    "Revoking authority did not return the plugin to review-required state.",
  );
  const revokedState = await evaluate(`(async () => {
    const row = document.querySelector(${JSON.stringify(installedRow)});
    const snapshot = await window.threadleaf.getSnapshot();
    return {
      checked: row?.querySelector('input[type="checkbox"]')?.checked ?? null,
      disabled: row?.querySelector('input[type="checkbox"]')?.disabled ?? null,
      loaded: (snapshot.plugins ?? []).some((plugin) => plugin.id === ${JSON.stringify(pluginId)} && plugin.state === "loaded"),
    };
  })()`);
  assert(
    revokedState.checked === false &&
      revokedState.disabled === true &&
      revokedState.loaded === false,
    "Revoking the grant did not disable, unload, and lock the plugin.",
  );

  await openReviewFrom(installedRow, "Review update");
  await fs.writeFile(path.join(pluginPath, "data.json"), '{"changedAfterReview":true}\n', "utf8");
  await click("#plugin-package-review-apply");
  await waitFor(
    'document.querySelector("#plugin-package-review-error")?.textContent?.includes("changed after review")',
    "A changed installed tree was not rejected after package review.",
  );
  const reviewRaceState = await evaluate(`(() => ({
    open: document.querySelector("#plugin-package-review-dialog")?.open,
    applyDisabled: document.querySelector("#plugin-package-review-apply")?.disabled,
    cancelDisabled: document.querySelector("#plugin-package-review-cancel")?.disabled,
    message: document.querySelector("#plugin-package-review-error")?.textContent ?? "",
  }))()`);
  assert(reviewRaceState.open === true, "The failed review did not preserve its error dialog.");
  assert(reviewRaceState.applyDisabled === true, "A consumed review could be applied twice.");
  assert(reviewRaceState.cancelDisabled === false, "The failed review could not be dismissed.");
  assert(
    reviewRaceState.message.includes("Review the exact package again"),
    "The failed review did not explain that a new review is required.",
  );
  assert(
    (await fs.readFile(path.join(pluginPath, "data.json"), "utf8")).includes("changedAfterReview"),
    "The changed installed tree was not preserved after review rejection.",
  );
  await reveal("#plugin-package-review-error");
  screenshots.push(
    ...[
      await screenshot("package-review-stale", "dark"),
      await screenshot("package-review-stale", "light"),
    ].filter(Boolean),
  );
  await click("#plugin-package-review-cancel");
  await waitFor(
    'document.querySelector("#plugin-package-review-dialog")?.open === false',
    "The failed package review could not be closed.",
  );

  await fs.appendFile(
    path.join(pluginPath, "main.js"),
    "\n/* external integrity probe */\n",
    "utf8",
  );
  await click("#plugin-reload-all");
  await waitFor(
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes("Managed bytes changed")`,
    "The visible package row did not block externally changed managed bytes.",
  );
  const changedState = await evaluate(`(() => {
    const row = document.querySelector(${JSON.stringify(installedRow)});
    return {
      invalid: row?.getAttribute("data-invalid"),
      disabled: row?.querySelector('input[type="checkbox"]')?.disabled,
      text: row?.textContent ?? "",
    };
  })()`);
  assert(changedState.invalid === "true", "Changed managed bytes lacked invalid-package shape.");
  assert(changedState.disabled === true, "Changed managed bytes could still be enabled.");
  const changedText = changedState.text.toLowerCase();
  assert(
    changedText.includes("package invalid") && changedText.includes("managed bytes changed"),
    "Integrity failure relied on color without explicit state labels.",
  );
  await reveal(installedRow);
  screenshots.push(
    ...[
      await screenshot("package-integrity-changed", "dark"),
      await screenshot("package-integrity-changed", "light"),
    ].filter(Boolean),
  );

  await openReviewFrom(installedRow, "Review reinstall");
  await applyReview();
  await waitFor(
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes("SHA-256 verified")`,
    "Reviewed reinstall did not restore verified bytes.",
  );

  await openReviewFrom(installedRow, "Uninstall");
  await applyReview();
  const removedRow = `#plugin-removed-list .plugin-row[data-plugin-id="${pluginId}"]`;
  await waitFor(
    `Boolean(document.querySelector(${JSON.stringify(removedRow)}))`,
    "Recoverable removed-package UI did not appear.",
  );
  await fs.stat(pluginPath).then(
    () => {
      throw new Error("Uninstall left the package directory in the vault.");
    },
    (error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    },
  );
  await reveal(removedRow);
  screenshots.push(
    ...[
      await screenshot("package-removed", "dark"),
      await screenshot("package-removed", "light"),
    ].filter(Boolean),
  );

  await openReviewFrom(removedRow, "Review restore");
  await applyReview();
  await waitFor(
    `document.querySelector(${JSON.stringify(installedRow)})?.textContent?.includes("SHA-256 verified")`,
    "Restored package did not return to verified state.",
  );
  const finalSnapshot = await evaluate("window.threadleaf.getSnapshot()");
  assert(
    !(finalSnapshot.plugins ?? []).some(
      (plugin) => plugin.id === pluginId && plugin.state === "loaded",
    ),
    "Restored package executed without separate enablement.",
  );

  console.log(
    JSON.stringify({
      builtScript,
      pluginId,
      version: reviewedVersion,
      reviewAssets: review.assets.length,
      integrityRaceBlocked: true,
      authorityGateVerified: true,
      installedDisabled: true,
      uninstallRestored: true,
      liveThemeColors,
      screenshots,
    }),
  );
  await evaluate("setTimeout(() => window.close(), 1000); true");
  const exit = await Promise.race([
    exited,
    delay(10_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const logs = output.join("").trim();
  throw new Error(logs ? `${detail}\nElectron output:\n${logs}` : detail, { cause: error });
} finally {
  cdp?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (exited) {
      await Promise.race([exited, delay(2_000)]);
    }
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    if (exited) {
      await Promise.race([exited, delay(2_000)]);
    }
  }
  await fs.rm(testRoot, { recursive: true, force: true });
}
