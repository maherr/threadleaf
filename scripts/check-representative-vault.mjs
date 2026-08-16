import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const sourceFlag = process.argv.indexOf("--source");
if (sourceFlag < 0 || !process.argv[sourceFlag + 1]) {
  throw new Error("Usage: check-representative-vault.mjs --source /path/to/read-only-source");
}

const appRoot = process.cwd();
const electronPath = path.join(appRoot, "node_modules", ".bin", "electron");
const sourceRoot = await fs.realpath(process.argv[sourceFlag + 1]);
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-representative-vault-"));
const vaultPath = path.join(testRoot, "vault");
const userDataPath = path.join(testRoot, "user-data");
const processMarker = randomUUID();
const keepTrial = process.env.THREADLEAF_KEEP_REPRESENTATIVE_TRIAL === "1";
const maximumImageBytes = 10 * 1024 * 1024;
const trialDirectory = "_threadleaf_trial_7f2c9e";
const attachmentNotePath = `${trialDirectory}/Attachment Probe.md`;
const externalNotePath = `${trialDirectory}/External Probe.md`;
const renameSourcePath = `${trialDirectory}/Rename Source.md`;
const renameTargetPath = `${trialDirectory}/Rename Target 7f2c9e.md`;
const renamedTargetPath = `${trialDirectory}/Renamed Target 7f2c9e.md`;
const burstDirectory = `${trialDirectory}/Event Burst`;
let phase = "source inventory";
let succeeded = false;
let activeProbe = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sanitize(message) {
  return String(message).replaceAll(sourceRoot, "<source>").replaceAll(testRoot, "<trial>");
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function mapLimit(items, concurrency, operation) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      await operation(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker()),
  );
}

async function stableRead(filePath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await fs.stat(filePath, { bigint: true });
    const bytes = await fs.readFile(filePath);
    const after = await fs.stat(filePath, { bigint: true });
    if (
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      BigInt(bytes.length) === after.size
    ) {
      return bytes;
    }
  }
  throw new Error("A source file changed during a stable read.");
}

async function collectSourceFiles() {
  const notes = [];
  const imageCandidates = [];

  async function visit(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }

      let sourcePath = absolutePath;
      if (entry.isSymbolicLink()) {
        try {
          sourcePath = await fs.realpath(absolutePath);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            continue;
          }
          throw error;
        }
        if (!isInside(sourceRoot, sourcePath) || !(await fs.stat(sourcePath)).isFile()) {
          continue;
        }
      } else if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLocaleLowerCase("en-US");
      const stat = await fs.stat(sourcePath);
      const descriptor = { relativePath, sourcePath, size: stat.size };
      if (extension === ".md") {
        notes.push(descriptor);
      } else if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) {
        imageCandidates.push(descriptor);
      }
    }
  }

  await visit(sourceRoot, "");
  return { notes, imageCandidates };
}

function sniffImage(bytes) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { extension: "png", mime: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mime: "image/jpeg" };
  }
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { extension: "gif", mime: "image/gif" };
    }
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return { extension: "webp", mime: "image/webp" };
  }
  return null;
}

async function writePrivateFile(relativePath, bytes) {
  const destination = path.join(vaultPath, ...relativePath.split("/"));
  assert(isInside(vaultPath, destination), "A copied path left the trial vault.");
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
}

async function copyRepresentativeVault(inventory) {
  await fs.mkdir(vaultPath, { recursive: true, mode: 0o700 });
  const manifest = new Map();
  let noteBytes = 0;
  let maximumNoteBytes = 0;
  await mapLimit(inventory.notes, 24, async (note) => {
    const bytes = await stableRead(note.sourcePath);
    await writePrivateFile(note.relativePath, bytes);
    manifest.set(note.relativePath, digest(bytes));
    noteBytes += bytes.length;
    maximumNoteBytes = Math.max(maximumNoteBytes, bytes.length);
  });

  const selectedImages = [];
  const selectedMimes = new Set();
  const candidates = inventory.imageCandidates
    .filter(({ size }) => size > 0 && size <= maximumImageBytes)
    .sort(
      (left, right) =>
        right.size - left.size || left.relativePath.localeCompare(right.relativePath),
    );
  for (const candidate of candidates) {
    if (selectedMimes.size >= 4) {
      break;
    }
    const bytes = await stableRead(candidate.sourcePath);
    const image = sniffImage(bytes);
    if (!image || selectedMimes.has(image.mime)) {
      continue;
    }
    const relativePath = `${trialDirectory}/assets/sample-${selectedImages.length + 1}.${image.extension}`;
    await writePrivateFile(relativePath, bytes);
    selectedImages.push({
      sourcePath: candidate.sourcePath,
      relativePath,
      digest: digest(bytes),
      bytes: bytes.length,
    });
    selectedMimes.add(image.mime);
  }
  assert(selectedImages.length > 0, "The source contained no readable supported image sample.");
  return { manifest, noteBytes, maximumNoteBytes, selectedImages };
}

async function addTrialNotes(selectedImages) {
  const attachments = selectedImages
    .map(({ relativePath }) => `![[${path.posix.relative(trialDirectory, relativePath)}]]`)
    .join("\n\n");
  await writePrivateFile(
    attachmentNotePath,
    Buffer.from(`# Attachment probe\n\n${attachments}\n`, "utf8"),
  );
  await writePrivateFile(externalNotePath, Buffer.from("# External probe\n\nversion one", "utf8"));
  await writePrivateFile(
    renameSourcePath,
    Buffer.from("# Rename source\n\n[[Rename Target 7f2c9e]]\n", "utf8"),
  );
  await writePrivateFile(renameTargetPath, Buffer.from("# Rename target 7f2c9e\n", "utf8"));
}

async function verifySourceUnchanged(inventory, manifest, selectedImages) {
  const current = await collectSourceFiles();
  assert(
    current.notes.length === inventory.notes.length,
    "The source note inventory changed during the trial.",
  );
  const currentByPath = new Map(current.notes.map((note) => [note.relativePath, note]));
  await mapLimit(inventory.notes, 24, async (note) => {
    const currentNote = currentByPath.get(note.relativePath);
    assert(currentNote, "The source note inventory changed during the trial.");
    const bytes = await stableRead(currentNote.sourcePath);
    assert(
      digest(bytes) === manifest.get(note.relativePath),
      "A source note changed during the trial.",
    );
  });
  for (const image of selectedImages) {
    assert(
      digest(await stableRead(image.sourcePath)) === image.digest,
      "A sampled source attachment changed during the trial.",
    );
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not reserve a debugging port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let sequence = 0;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed to open.")), {
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
      request.reject(new Error("CDP socket closed."));
    }
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

async function waitForMainTarget(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (candidate) =>
            candidate.type === "page" &&
            typeof candidate.url === "string" &&
            candidate.url.endsWith("/dist/renderer/index.html"),
        );
        if (target?.webSocketDebuggerUrl) {
          return target;
        }
      }
    } catch {
      // Electron is still starting.
    }
    await delay(50);
  }
  throw new Error("Threadleaf did not expose its main renderer in time.");
}

async function evaluate(probe, expression, timeoutMs = 10_000) {
  const response = await Promise.race([
    probe.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }),
    delay(timeoutMs).then(() => {
      throw new Error("The renderer did not answer a bounded evaluation.");
    }),
  ]);
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "Renderer evaluation failed.",
    );
  }
  return response.result?.value;
}

async function waitFor(operation, message, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await operation();
    if (last) {
      return last;
    }
    await delay(intervalMs);
  }
  throw new Error(`${message}. Last observation: ${JSON.stringify(last)}`);
}

async function markedProcessIds() {
  const entries = await fs.readdir("/proc");
  const marker = Buffer.from(`THREADLEAF_REPRESENTATIVE_RUN=${processMarker}\0`);
  const pids = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    const pid = Number.parseInt(entry, 10);
    try {
      const environment = await fs.readFile(`/proc/${pid}/environ`);
      const commandLine = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
      if (environment.includes(marker) || commandLine.includes(`--user-data-dir=${userDataPath}`)) {
        pids.push(pid);
      }
    } catch {
      // Processes can exit during enumeration.
    }
  }
  return pids;
}

async function terminateProbeProcesses() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const pids = await markedProcessIds();
      if (pids.length === 0) {
        return;
      }
      for (const pid of pids) {
        try {
          process.kill(pid, signal);
        } catch {
          // The process already exited.
        }
      }
      await delay(100);
    }
  }
  assert((await markedProcessIds()).length === 0, "Could not stop the trial Electron processes.");
}

async function launchProbe() {
  const port = await availablePort();
  const startedAt = Date.now();
  const child = spawn(
    "xvfb-run",
    [
      "-a",
      electronPath,
      "--ozone-platform=x11",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataPath}`,
      "--disable-gpu",
      "--password-store=basic",
      ".",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        ELECTRON_OZONE_PLATFORM_HINT: "x11",
        THREADLEAF_REPRESENTATIVE_RUN: processMarker,
        THREADLEAF_SAFE_PLUGINS: "1",
        THREADLEAF_VAULT_PATH: vaultPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.resume();
  }
  const target = await waitForMainTarget(port);
  const probe = { cdp: connectCdp(target.webSocketDebuggerUrl), exited, startedAt };
  await Promise.race([
    probe.cdp.send("Page.enable"),
    delay(10_000).then(() => {
      throw new Error("The main renderer debugging target did not become ready.");
    }),
  ]);
  return probe;
}

function renderedStateExpression() {
  return `(async () => {
    const snapshot = await window.threadleaf.getSnapshot();
    const summary = document.querySelector("#filter-summary")?.textContent ?? "";
    return {
      ready: document.querySelector("#runtime-state")?.textContent === "Ready",
      count: snapshot.workspace?.census.indexed ?? 0,
      visibleFileCount: snapshot.workspace?.inventory.fileCount ?? 0,
      visibleFolderCount: snapshot.workspace?.inventory.folderCount ?? 0,
      summary,
      activePath: document.querySelector("#note-path")?.textContent ?? "",
      editState: document.querySelector("#edit-state")?.textContent ?? "",
      draftState: document.querySelector("#edit-state")?.getAttribute("data-draft-state") ?? "",
      bodyVisible: document.body.getBoundingClientRect().width > 0,
    };
  })()`;
}

async function waitForRenderedTarget(probe) {
  return waitFor(
    async () => {
      const state = await evaluate(
        probe,
        `(() => {
          return {
            visible: document.body.getBoundingClientRect().width > 0,
            target: document.querySelector("#vault-identity")?.getAttribute("title") ?? "",
          };
        })()`,
      );
      return state.visible && state.target === vaultPath ? state : null;
    },
    "Threadleaf did not render the copied vault promptly",
    10_000,
  );
}

async function waitForReady(probe, expectedCount, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(probe, renderedStateExpression());
    if (last.ready && last.count === expectedCount) {
      break;
    }
    await delay(250);
  }
  assert(
    last?.ready && last.count === expectedCount,
    `The copied vault did not reach the exact ready note count ${expectedCount}. Last observation: ${JSON.stringify(last)}`,
  );
  return evaluate(
    probe,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      return {
        count: snapshot.workspace?.census.indexed ?? 0,
        filePageTotal: snapshot.workspace?.filePage.total ?? 0,
        residentFiles: snapshot.workspace?.files.length ?? 0,
        generation: snapshot.workspace?.indexGeneration ?? "",
        watcherSequence: snapshot.workspace?.watcher.lastSequence ?? 0,
        watcherError: snapshot.workspace?.watcher.error ?? null,
      };
    })()`,
    15_000,
  );
}

async function pressKey(probe, key, code, modifiers = 0) {
  await probe.cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined,
  });
  await probe.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
}

async function openNote(probe, notePath, timeoutMs = 15_000) {
  await evaluate(
    probe,
    `(async () => { await window.threadleaf.openNote(${JSON.stringify(notePath)}); return true; })()`,
    timeoutMs,
  );
  await waitFor(
    async () => {
      const state = await evaluate(probe, renderedStateExpression());
      return state.activePath === notePath ? state : null;
    },
    "Threadleaf did not activate the requested note",
    timeoutMs,
  );
}

async function closeProbe(probe) {
  try {
    await evaluate(probe, "setTimeout(() => window.close(), 0); true");
  } catch {
    // A clean close can race the final CDP response.
  }
  // Begin the WebSocket close handshake while the renderer can still answer it.
  // Closing only after Electron exits leaves Node's WebSocket client waiting for
  // its transport timeout even though every product assertion has completed.
  probe.cdp.close();
  const exit = await Promise.race([
    probe.exited,
    delay(15_000).then(() => ({ code: null, signal: "timeout" })),
  ]);
  assert(exit.code === 0, `Electron did not exit cleanly: ${JSON.stringify(exit)}`);
  activeProbe = null;
}

async function atomicExternalWrite(relativePath, content) {
  const destination = path.join(vaultPath, ...relativePath.split("/"));
  const temporary = `${destination}.${randomUUID()}.sync-tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

async function verifyVirtualFileWindow(probe, expectedCount) {
  const expression = `(() => {
      const list = document.querySelector("#file-list");
      const rows = [...document.querySelectorAll("#file-list .virtual-file-row")];
      const positions = rows.map((row) => Number(row.getAttribute("aria-posinset")));
      const total = Number(rows[0]?.getAttribute("aria-setsize") ?? 0);
      return {
        mode: list?.getAttribute("data-mode") ?? "",
        rowCount: rows.length,
        consecutive: positions.every((position, index) => position === positions[0] + index),
        total,
        expected: ${expectedCount},
      };
    })()`;
  let state = await evaluate(probe, expression);
  if (state.mode !== "virtual") {
    const switched = await evaluate(
      probe,
      `(() => {
        const toggle = document.querySelector("#navigator-view-toggle");
        if (!(toggle instanceof HTMLButtonElement)) return false;
        toggle.click();
        return true;
      })()`,
    );
    assert(switched, "The navigator did not expose its visible list-view control.");
    state = await waitFor(
      async () => {
        const candidate = await evaluate(probe, expression);
        return candidate.mode === "virtual" && candidate.rowCount > 0 ? candidate : null;
      },
      "The navigator did not switch to its virtualized flat list",
      10_000,
    );
  }
  return state;
}

try {
  assert(process.platform === "linux", "The representative-vault probe requires Linux and Xvfb.");
  await fs.access(electronPath);
  const copyStartedAt = Date.now();
  const inventory = await collectSourceFiles();
  assert(inventory.notes.length > 0, "The source has no visible Markdown notes.");
  phase = "private representative copy";
  const copied = await copyRepresentativeVault(inventory);
  await addTrialNotes(copied.selectedImages);
  const copyMs = Date.now() - copyStartedAt;
  const initialCount = inventory.notes.length + 4;
  const largestNote = inventory.notes.reduce((largest, note) =>
    note.size > largest.size ? note : largest,
  );
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });

  phase = "first full startup";
  activeProbe = await launchProbe();
  await waitForRenderedTarget(activeProbe);
  const firstRenderMs = Date.now() - activeProbe.startedAt;
  assert(firstRenderMs <= 10_000, `The copied vault opening shell took ${firstRenderMs} ms.`);
  const ready = await waitForReady(activeProbe, initialCount);
  const firstReadyMs = Date.now() - activeProbe.startedAt;
  assert(ready.count === initialCount, "The ready snapshot did not contain every copied note.");
  assert(
    ready.filePageTotal === initialCount && ready.residentFiles <= 256,
    "The ready snapshot did not expose a bounded first page over the complete note census.",
  );
  assert(ready.watcherError === null, "The copied vault watcher reported an error.");
  const virtualFiles = await verifyVirtualFileWindow(activeProbe, initialCount);
  assert(virtualFiles.mode === "virtual", "The real-scale file list was not virtualized.");
  assert(
    virtualFiles.rowCount > 0 && virtualFiles.rowCount <= 64,
    "Virtualization mounted too many rows.",
  );
  assert(
    virtualFiles.consecutive && virtualFiles.total === initialCount,
    "Virtualized file geometry drifted.",
  );

  phase = "large note edit and autosave";
  const largeOpenStartedAt = Date.now();
  await openNote(activeProbe, largestNote.relativePath, 20_000);
  const largeOpenMs = Date.now() - largeOpenStartedAt;
  await evaluate(
    activeProbe,
    `document.querySelector('[data-pane-id="primary"] .cm-content')?.focus(); true`,
  );
  await pressKey(activeProbe, "End", "End", 2);
  const largeMarker = "\n\n<!-- threadleaf representative large-note save -->";
  await activeProbe.cdp.send("Input.insertText", { text: largeMarker });
  await waitFor(
    async () => {
      const state = await evaluate(activeProbe, renderedStateExpression());
      return state.editState === "Saving soon" || state.editState === "Saving" ? state : null;
    },
    "The large-note edit did not enter autosave",
    15_000,
  );
  const largeSaveStartedAt = Date.now();
  await waitFor(
    async () => (await evaluate(activeProbe, renderedStateExpression())).editState === "Saved",
    "The large-note edit did not autosave",
    30_000,
  );
  const largeSaveMs = Date.now() - largeSaveStartedAt;
  assert(
    (
      await fs.readFile(path.join(vaultPath, ...largestNote.relativePath.split("/")), "utf8")
    ).endsWith(largeMarker),
    "The large note did not retain the exact appended marker.",
  );

  phase = "attachment rendering";
  const attachmentStartedAt = Date.now();
  await openNote(activeProbe, attachmentNotePath);
  await evaluate(activeProbe, `document.querySelector("#read-view")?.click(); true`);
  await waitFor(
    async () =>
      evaluate(
        activeProbe,
        `(() => {
          const images = [...document.querySelectorAll("#note-preview img.preview-local-image")];
          return images.length === ${copied.selectedImages.length} && images.every((image) =>
            image.complete && image.naturalWidth > 0 && image.src.startsWith("data:image/"));
        })()`,
      ),
    "The sampled local attachments did not render",
    20_000,
  );
  const attachmentMs = Date.now() - attachmentStartedAt;

  phase = "external atomic edit";
  await openNote(activeProbe, externalNotePath);
  const externalContent = "# External probe\n\nversion two from sync-style replacement";
  const externalStartedAt = Date.now();
  await atomicExternalWrite(externalNotePath, externalContent);
  await waitFor(
    async () =>
      evaluate(
        activeProbe,
        `(() => {
          const root = document.querySelector('[data-pane-id="primary"]');
          return root && [...root.querySelectorAll(".cm-content .cm-line")]
            .map((line) => line.textContent ?? "").join("\\n") === ${JSON.stringify(externalContent)};
        })()`,
      ),
    "The active editor did not converge to an external atomic replacement",
    20_000,
  );
  const externalEditMs = Date.now() - externalStartedAt;

  phase = "sync-style event burst";
  const burstStartedAt = Date.now();
  const burstPaths = Array.from(
    { length: 200 },
    (_, index) => `${burstDirectory}/Note ${String(index).padStart(3, "0")}.md`,
  );
  await mapLimit(burstPaths, 32, (filePath, index) =>
    atomicExternalWrite(filePath, `# Burst ${index}\n\ncreated`),
  );
  await mapLimit(burstPaths.slice(0, 100), 32, (filePath, index) =>
    atomicExternalWrite(filePath, `# Burst ${index}\n\nupdated`),
  );
  const movedBurstPaths = burstPaths
    .slice(0, 50)
    .map((_, index) => `${burstDirectory}/Moved ${String(index).padStart(3, "0")}.md`);
  await Promise.all(
    burstPaths
      .slice(0, 50)
      .map((filePath, index) =>
        fs.rename(
          path.join(vaultPath, ...filePath.split("/")),
          path.join(vaultPath, ...movedBurstPaths[index].split("/")),
        ),
      ),
  );
  await Promise.all(
    burstPaths
      .slice(50, 100)
      .map((filePath) => fs.unlink(path.join(vaultPath, ...filePath.split("/")))),
  );
  const expectedAfterBurst = initialCount + 150;
  await waitForReady(activeProbe, expectedAfterBurst, 45_000);
  const burstEvidence = await evaluate(
    activeProbe,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const descriptor = snapshot.workspace?.filePage;
      const vaultId = snapshot.vault.id;
      if (!descriptor || !vaultId) throw new Error("The settled vault file page is unavailable.");
      if (descriptor.generation !== snapshot.workspace?.indexGeneration) {
        throw new Error("The settled vault snapshot exposed mismatched index generations.");
      }
      const paths = new Set();
      for (let offset = 0; offset < descriptor.total; offset += descriptor.limit) {
        const response = await window.threadleaf.getWorkspaceFilePage({
          expectedVaultId: vaultId,
          generation: descriptor.generation,
          offset,
          limit: descriptor.limit,
        });
        if (
          response.status !== "ready" ||
          response.page.generation !== descriptor.generation ||
          response.page.offset !== offset ||
          response.page.limit !== descriptor.limit ||
          response.page.total !== descriptor.total ||
          response.page.complete !== (offset + response.files.length >= descriptor.total)
        ) {
          throw new Error("The settled vault file pages changed during the burst check.");
        }
        for (const file of response.files) paths.add(file.path);
      }
      if (paths.size !== descriptor.total) {
        throw new Error("The settled vault file pages did not cover the declared total.");
      }
      const moved = ${JSON.stringify(movedBurstPaths)};
      const retained = ${JSON.stringify(burstPaths.slice(100))};
      const removed = ${JSON.stringify(burstPaths.slice(0, 100))};
      const settled = await window.threadleaf.getSnapshot();
      if (
        settled.workspace?.indexGeneration !== descriptor.generation ||
        settled.workspace?.filePage.generation !== descriptor.generation ||
        settled.workspace?.filePage.total !== descriptor.total
      ) {
        throw new Error("The settled vault generation changed while its pages were inspected.");
      }
      return {
        count: paths.size,
        complete: moved.every((item) => paths.has(item)) &&
          retained.every((item) => paths.has(item)) && removed.every((item) => !paths.has(item)),
        watcherError: settled.workspace?.watcher.error ?? null,
      };
    })()`,
    20_000,
  );
  assert(
    burstEvidence.count === expectedAfterBurst && burstEvidence.complete,
    "The event burst did not converge to the exact final file set.",
  );
  assert(burstEvidence.watcherError === null, "The watcher degraded during the event burst.");
  const burstMs = Date.now() - burstStartedAt;

  phase = "whole-vault rename refactor";
  await openNote(activeProbe, renameTargetPath);
  const renameStartedAt = Date.now();
  const preview = await evaluate(
    activeProbe,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const note = snapshot.workspace?.activeNote;
      if (!note || !snapshot.vault.id) throw new Error("Synthetic rename note is unavailable.");
      const response = await window.threadleaf.moveNote(
        note.path,
        ${JSON.stringify(renamedTargetPath)},
        note.revision,
        snapshot.vault.id,
      );
      return {
        status: response.outcome.status,
        confirmationId: response.outcome.status === "requires-confirmation"
          ? response.outcome.confirmationId
          : null,
        rewrites: response.outcome.status === "requires-confirmation"
          ? response.outcome.rewrites.length
          : 0,
      };
    })()`,
    60_000,
  );
  assert(
    preview.status === "requires-confirmation" && preview.confirmationId && preview.rewrites === 1,
    "The whole-vault rename did not produce one exact rewrite preview.",
  );
  const committedMove = await evaluate(
    activeProbe,
    `(async () => {
      const snapshot = await window.threadleaf.getSnapshot();
      const note = snapshot.workspace?.activeNote;
      if (!note || !snapshot.vault.id) throw new Error("Synthetic rename note is unavailable.");
      const response = await window.threadleaf.moveNote(
        note.path,
        ${JSON.stringify(renamedTargetPath)},
        note.revision,
        snapshot.vault.id,
        ${JSON.stringify(preview.confirmationId)},
      );
      return {
        status: response.outcome.status,
        rewrites: response.outcome.status === "committed" ? response.outcome.rewrites.length : 0,
      };
    })()`,
    60_000,
  );
  assert(
    committedMove.status === "committed" && committedMove.rewrites === 1,
    "The confirmed whole-vault rename did not commit exactly one rewrite.",
  );
  const renameSource = await fs.readFile(
    path.join(vaultPath, ...renameSourcePath.split("/")),
    "utf8",
  );
  assert(
    renameSource.includes(`[[${renamedTargetPath.slice(0, -3)}]]`),
    "The rename did not rewrite the synthetic inbound link.",
  );
  const renameMs = Date.now() - renameStartedAt;
  await openNote(activeProbe, renamedTargetPath);

  phase = "clean restart";
  await closeProbe(activeProbe);
  activeProbe = await launchProbe();
  await waitForRenderedTarget(activeProbe);
  const restartReady = await waitForReady(activeProbe, expectedAfterBurst, 90_000);
  const restartReadyMs = Date.now() - activeProbe.startedAt;
  const restartState = await evaluate(activeProbe, renderedStateExpression());
  assert(
    restartState.activePath === renamedTargetPath,
    "The active workspace note did not survive restart.",
  );
  assert(restartReady.watcherError === null, "The restarted watcher reported an error.");
  await closeProbe(activeProbe);

  phase = "source immutability verification";
  await verifySourceUnchanged(inventory, copied.manifest, copied.selectedImages);
  succeeded = true;
  console.log(
    JSON.stringify({
      sourceNotes: inventory.notes.length,
      copiedNoteBytes: copied.noteBytes,
      maximumNoteBytes: copied.maximumNoteBytes,
      sampledAttachments: copied.selectedImages.length,
      sampledAttachmentBytes: copied.selectedImages.reduce((sum, image) => sum + image.bytes, 0),
      copyMs,
      firstRenderMs,
      firstReadyMs,
      largeOpenMs,
      largeSaveMs,
      attachmentMs,
      externalEditMs,
      burstMs,
      renameMs,
      restartReadyMs,
      finalNotes: expectedAfterBurst,
      sourceUnchanged: true,
    }),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Representative-vault phase ${phase} failed: ${sanitize(detail)}.`);
} finally {
  activeProbe?.cdp.close();
  await terminateProbeProcesses();
  if (!keepTrial) {
    await fs.rm(testRoot, { recursive: true, force: true });
  } else {
    console.error(`Representative trial retained at ${testRoot}.`);
  }
  if (!succeeded && keepTrial) {
    console.error("The retained trial contains a private source copy; do not publish it.");
  }
}

// Node's built-in WebSocket client retains its transport timeout after both
// renderer connections have closed. At this point the marked process set is
// empty, the private trial is removed, and source immutability is verified, so
// flush the report and end the one-shot harness instead of idling for a minute.
if (succeeded) {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}
