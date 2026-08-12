import DOMPurify, { type Config } from "dompurify";
import MarkdownIt, { type RendererRule, type StateInline } from "markdown-it";
import type {
  VaultImageResponse,
  VaultNoteEmbedResponse,
  WorkspaceLinkSummary,
} from "../shared/contracts";

export interface PreviewWikiLink extends Record<string, unknown> {
  target: string;
  subpath: string | null;
  alias: string | null;
  embed: boolean;
}

const allowedTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "summary",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const sanitizeConfig = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: [
    "aria-label",
    "class",
    "colspan",
    "data-source-line",
    "data-threadleaf-alt",
    "data-threadleaf-asset",
    "data-threadleaf-embed",
    "data-threadleaf-external-url",
    "data-threadleaf-link",
    "data-threadleaf-note-embed",
    "data-threadleaf-subpath",
    "data-threadleaf-target",
    "href",
    "role",
    "rowspan",
    "start",
    "title",
  ],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_DOM_FRAGMENT: true,
} satisfies Config;

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function splitTarget(value: string): { target: string; subpath: string | null } {
  const headingIndex = value.indexOf("#");
  const blockIndex = value.indexOf("^");
  const indexes = [headingIndex, blockIndex].filter((index) => index >= 0);
  const splitAt = indexes.length > 0 ? Math.min(...indexes) : -1;
  if (splitAt === -1) {
    return { target: value.trim(), subpath: null };
  }
  return {
    target: value.slice(0, splitAt).trim(),
    subpath: value.slice(splitAt).trim() || null,
  };
}

function parseWikiLink(raw: string, embed: boolean): PreviewWikiLink {
  const aliasAt = raw.indexOf("|");
  const rawTarget = aliasAt === -1 ? raw : raw.slice(0, aliasAt);
  const { target, subpath } = splitTarget(rawTarget.trim());
  return {
    target,
    subpath,
    alias: aliasAt === -1 ? null : raw.slice(aliasAt + 1).trim() || null,
    embed,
  };
}

function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const embed = state.src[start] === "!";
  const markerStart = embed ? start + 1 : start;
  if (state.src.slice(markerStart, markerStart + 2) !== "[[") {
    return false;
  }
  const close = state.src.indexOf("]]", markerStart + 2);
  if (close === -1 || state.src.slice(markerStart + 2, close).includes("\n")) {
    return false;
  }
  const raw = state.src.slice(markerStart + 2, close);
  if (!raw.trim()) {
    return false;
  }
  if (!silent) {
    const token = state.push("threadleaf_wikilink", "a", 0);
    token.meta = parseWikiLink(raw, embed);
  }
  state.pos = close + 2;
  return true;
}

function maskFrontmatter(source: string): string {
  const lines = source.split("\n");
  if (lines[0]?.replace(/^\uFEFF/, "").trim() !== "---") {
    return source;
  }
  const close = lines.slice(1).findIndex((line) => {
    const trimmed = line.trim();
    return trimmed === "---" || trimmed === "...";
  });
  if (close === -1) {
    return source;
  }
  const end = close + 1;
  return lines.map((line, index) => (index <= end ? "" : line)).join("\n");
}

function isExternalLink(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function isMarkdownNoteTarget(target: string, subpath: string | null, wiki: boolean): boolean {
  const normalized = target.trim().toLocaleLowerCase("en-US");
  if (normalized.endsWith(".md")) {
    return true;
  }
  if (subpath && !/\.[^/]+$/u.test(normalized)) {
    return true;
  }
  return wiki && normalized !== "" && !/\.[^/]+$/u.test(normalized);
}

function noteEmbedPlaceholder(target: string, subpath: string | null, label: string): string {
  return `<span class="preview-note-embed-placeholder" role="status" aria-label="Loading embedded note ${escapeAttribute(label)}" data-threadleaf-note-embed="true" data-threadleaf-target="${escapeAttribute(target)}" data-threadleaf-subpath="${escapeAttribute(subpath ?? "")}" data-threadleaf-alt="${escapeAttribute(label)}">Embedded note: ${escapeText(label)}</span>`;
}

const markdown = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

markdown.inline.ruler.before("image", "threadleaf_wikilink", wikiLinkRule);

markdown.core.ruler.after("block", "threadleaf_source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.nesting >= 0 && token.type !== "inline") {
      token.attrSet("data-source-line", String(token.map[0] + 1));
    }
  }
});

markdown.renderer.rules.threadleaf_wikilink = (tokens, index) => {
  const link = tokens[index]?.meta as PreviewWikiLink | undefined;
  if (!link) {
    return "";
  }
  const fallback = `${link.target}${link.subpath ?? ""}`;
  const label = link.alias ?? fallback;
  if (link.embed && /\.(?:gif|jpe?g|png|webp)$/iu.test(link.target)) {
    return `<span class="preview-asset-placeholder" role="note" data-threadleaf-asset="${escapeAttribute(link.target)}" data-threadleaf-alt="${escapeAttribute(link.alias ?? "")}">Image: ${escapeText(label)}</span>`;
  }
  if (link.embed && isMarkdownNoteTarget(link.target, link.subpath, true)) {
    return noteEmbedPlaceholder(link.target, link.subpath, label);
  }
  const classes = link.embed ? "internal-link preview-embed-link" : "internal-link";
  return `<a href="#" class="${classes}" data-threadleaf-link="wiki" data-threadleaf-target="${escapeAttribute(link.target)}" data-threadleaf-subpath="${escapeAttribute(link.subpath ?? "")}" data-threadleaf-embed="${String(link.embed)}">${escapeText(label)}</a>`;
};

const renderAlignedTableCell: RendererRule = (tokens, index, options, _env, renderer) => {
  const token = tokens[index];
  if (!token) {
    return "";
  }
  const style = String(token.attrGet("style") ?? "");
  const alignment = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(style)?.[1];
  token.attrs = token.attrs?.filter(([name]) => name !== "style") ?? null;
  if (alignment) {
    token.attrJoin("class", `align-${alignment.toLocaleLowerCase("en-US")}`);
  }
  return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.th_open = renderAlignedTableCell;
markdown.renderer.rules.td_open = renderAlignedTableCell;

const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (!token) {
    return "";
  }
  const destination = String(token.attrGet("href") ?? "");
  token.attrJoin("class", isExternalLink(destination) ? "external-link" : "internal-link");
  token.attrSet(
    isExternalLink(destination) ? "data-threadleaf-external-url" : "data-threadleaf-target",
    destination,
  );
  token.attrSet("data-threadleaf-link", isExternalLink(destination) ? "external" : "markdown");
  token.attrSet("href", "#");
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, renderer)
    : renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (!token) {
    return "";
  }
  const source = String(token.attrGet("src") ?? "");
  const alt = renderer.renderInlineAsText(token.children ?? [], options, env).trim();
  const label = alt || source || "attachment";
  const { target, subpath } = splitTarget(source);
  if (isMarkdownNoteTarget(target, subpath, false)) {
    return noteEmbedPlaceholder(target, subpath, label);
  }
  return `<span class="preview-asset-placeholder" role="note" data-threadleaf-asset="${escapeAttribute(source)}" data-threadleaf-alt="${escapeAttribute(alt)}">Image: ${escapeText(label)}</span>`;
};

const maxImagesPerPreview = 128;
const maxPreviewImageBytes = 64 * 1024 * 1024;
const maxNoteEmbedsPerPreview = 32;
const maxPreviewNoteEmbedBytes = 8 * 1024 * 1024;
const maxNoteEmbedDepth = 4;

interface PreviewHydrationBudget {
  imageBytes: number;
  imageCount: number;
  noteEmbedBytes: number;
  noteEmbedCount: number;
}

function createPreviewHydrationBudget(): PreviewHydrationBudget {
  return { imageBytes: 0, imageCount: 0, noteEmbedBytes: 0, noteEmbedCount: 0 };
}

function noteEmbedIdentity(path: string, subpath: string | null): string {
  return `${path}\0${subpath ?? ""}`;
}

export interface PreviewImageHydrationOptions {
  sourceNotePath: string;
  expectedVaultId: string;
  loadImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  isCurrent?(): boolean;
  budget?: PreviewHydrationBudget;
}

function imageLabel(placeholder: HTMLElement): string {
  return placeholder.dataset.threadleafAlt || placeholder.dataset.threadleafAsset || "attachment";
}

function markImageUnavailable(
  placeholder: HTMLElement,
  label: string,
  status: string,
  message: string,
): void {
  placeholder.ariaBusy = "false";
  placeholder.dataset.threadleafAssetStatus = status;
  placeholder.textContent = `Image unavailable: ${label}`;
  placeholder.title = message;
}

export async function hydrateMarkdownPreviewImages(
  root: HTMLElement,
  options: PreviewImageHydrationOptions,
): Promise<void> {
  const placeholders = [
    ...root.querySelectorAll<HTMLElement>(".preview-asset-placeholder[data-threadleaf-asset]"),
  ];
  const budget = options.budget ?? createPreviewHydrationBudget();

  for (const placeholder of placeholders) {
    if (options.isCurrent && !options.isCurrent()) {
      return;
    }
    const label = imageLabel(placeholder);
    if (budget.imageCount >= maxImagesPerPreview) {
      markImageUnavailable(
        placeholder,
        label,
        "preview-limit",
        `Reading view loads at most ${maxImagesPerPreview} local images at once.`,
      );
      continue;
    }
    budget.imageCount += 1;
    const target = placeholder.dataset.threadleafAsset ?? "";
    placeholder.ariaBusy = "true";
    placeholder.dataset.threadleafAssetStatus = "loading";

    let response: VaultImageResponse;
    try {
      response = await options.loadImage(options.sourceNotePath, target, options.expectedVaultId);
    } catch {
      if ((!options.isCurrent || options.isCurrent()) && root.contains(placeholder)) {
        markImageUnavailable(placeholder, label, "unreadable", "The local image request failed.");
      }
      continue;
    }
    if ((options.isCurrent && !options.isCurrent()) || !root.contains(placeholder)) {
      return;
    }
    if (response.status === "stale-vault" || response.vaultId !== options.expectedVaultId) {
      markImageUnavailable(
        placeholder,
        label,
        "stale-vault",
        "The active vault changed before this image finished loading.",
      );
      continue;
    }
    if (response.status === "unavailable") {
      markImageUnavailable(placeholder, label, response.reason, response.message);
      continue;
    }
    if (budget.imageBytes + response.size > maxPreviewImageBytes) {
      markImageUnavailable(
        placeholder,
        label,
        "preview-limit",
        "This reading view reached its 64 MiB local-image budget.",
      );
      continue;
    }
    budget.imageBytes += response.size;

    const image = root.ownerDocument.createElement("img");
    image.className = "preview-local-image";
    image.alt = placeholder.dataset.threadleafAlt ?? "";
    image.loading = "eager";
    image.decoding = "async";
    image.dataset.threadleafAsset = target;
    image.dataset.threadleafAssetPath = response.path;
    image.dataset.threadleafRevision = response.revision;
    image.addEventListener("error", () => {
      if (!root.contains(image)) {
        return;
      }
      const failure = root.ownerDocument.createElement("span");
      failure.className = "preview-asset-placeholder";
      failure.setAttribute("role", "note");
      failure.dataset.threadleafAsset = target;
      markImageUnavailable(
        failure,
        label,
        "decode-failed",
        "Chromium could not decode the sniffed local image.",
      );
      image.replaceWith(failure);
    });
    image.src = `data:${response.mimeType};base64,${response.base64}`;
    placeholder.replaceWith(image);
  }
}

export interface PreviewNoteEmbedHydrationOptions {
  sourceNotePath: string;
  expectedVaultId: string;
  loadImage: PreviewImageHydrationOptions["loadImage"];
  loadNoteEmbed(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse>;
  decorateLinks(
    root: HTMLElement,
    links: readonly WorkspaceLinkSummary[],
    sourceNotePath: string,
  ): void;
  isCurrent?(): boolean;
}

function noteEmbedLabel(placeholder: HTMLElement): string {
  return (
    placeholder.dataset.threadleafAlt ||
    `${placeholder.dataset.threadleafTarget ?? ""}${placeholder.dataset.threadleafSubpath ?? ""}` ||
    "embedded note"
  );
}

function markNoteEmbedUnavailable(
  placeholder: HTMLElement,
  label: string,
  status: string,
  message: string,
): void {
  placeholder.ariaBusy = "false";
  placeholder.className = "preview-note-embed preview-note-embed-unavailable";
  placeholder.dataset.threadleafNoteEmbedStatus = status;
  placeholder.setAttribute("role", "note");
  placeholder.setAttribute("aria-label", `Embedded note unavailable: ${label}`);
  placeholder.title = message;
  placeholder.replaceChildren();
  const marker = placeholder.ownerDocument.createElement("span");
  marker.className = "preview-note-embed-marker";
  marker.ariaHidden = "true";
  marker.textContent = "×";
  const copy = placeholder.ownerDocument.createElement("span");
  copy.className = "preview-note-embed-failure-copy";
  const title = placeholder.ownerDocument.createElement("strong");
  title.textContent = `Embedded note unavailable: ${label}`;
  const detail = placeholder.ownerDocument.createElement("span");
  detail.textContent = message;
  copy.append(title, detail);
  placeholder.append(marker, copy);
}

function noteEmbedHost(placeholder: HTMLElement): HTMLElement {
  const parent = placeholder.parentElement;
  if (
    parent?.tagName === "P" &&
    [...parent.childNodes].every(
      (node) => node === placeholder || (node.nodeType === 3 && !(node.textContent ?? "").trim()),
    )
  ) {
    return parent;
  }
  return placeholder;
}

function createNoteEmbed(
  placeholder: HTMLElement,
  response: Extract<VaultNoteEmbedResponse, { status: "ready" }>,
): { body: HTMLElement; embed: HTMLElement } {
  const document = placeholder.ownerDocument;
  const embed = document.createElement("section");
  embed.className = "preview-note-embed";
  embed.dataset.threadleafNoteEmbedStatus = "ready";
  embed.dataset.threadleafPath = response.path;
  embed.dataset.threadleafRevision = response.revision;
  embed.dataset.threadleafEmbedKind = response.kind;
  embed.setAttribute("aria-label", `Embedded note ${response.path}`);

  const header = document.createElement("header");
  header.className = "preview-note-embed-header";
  const marker = document.createElement("span");
  marker.className = "preview-note-embed-marker";
  marker.ariaHidden = "true";
  marker.textContent = "↳";
  const identity = document.createElement("span");
  identity.className = "preview-note-embed-identity";
  const eyebrow = document.createElement("span");
  eyebrow.className = "preview-note-embed-eyebrow";
  eyebrow.textContent =
    response.kind === "heading"
      ? "Embedded section"
      : response.kind === "block"
        ? "Embedded block"
        : "Embedded note";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "preview-note-embed-open";
  open.dataset.threadleafOpenPath = response.path;
  open.dataset.threadleafSubpath = response.subpath ?? "";
  open.textContent = `${response.path}${response.subpath ?? ""}`;
  open.title = `Open ${response.path}${response.subpath ?? ""}`;
  identity.append(eyebrow, open);
  const provenance = document.createElement("span");
  provenance.className = "preview-note-embed-provenance";
  provenance.textContent =
    response.startLine === response.endLine
      ? `line ${response.startLine}`
      : `lines ${response.startLine}-${response.endLine}`;
  header.append(marker, identity, provenance);

  const body = document.createElement("div");
  body.className = "preview-note-embed-body";
  embed.append(header, body);
  return { body, embed };
}

async function hydrateNoteEmbedTree(
  root: HTMLElement,
  sourceNotePath: string,
  depth: number,
  ancestors: ReadonlySet<string>,
  budget: PreviewHydrationBudget,
  options: PreviewNoteEmbedHydrationOptions,
): Promise<void> {
  await hydrateMarkdownPreviewImages(root, {
    sourceNotePath,
    expectedVaultId: options.expectedVaultId,
    loadImage: options.loadImage,
    budget,
    ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
  });
  const placeholders = [
    ...root.querySelectorAll<HTMLElement>(
      ".preview-note-embed-placeholder[data-threadleaf-note-embed]",
    ),
  ];
  for (const placeholder of placeholders) {
    if ((options.isCurrent && !options.isCurrent()) || !root.contains(placeholder)) {
      return;
    }
    const label = noteEmbedLabel(placeholder);
    const host = noteEmbedHost(placeholder);
    if (depth >= maxNoteEmbedDepth) {
      markNoteEmbedUnavailable(
        host,
        label,
        "depth-limit",
        `Reading view expands embedded notes through at most ${maxNoteEmbedDepth} levels.`,
      );
      continue;
    }
    if (budget.noteEmbedCount >= maxNoteEmbedsPerPreview) {
      markNoteEmbedUnavailable(
        host,
        label,
        "preview-limit",
        `Reading view expands at most ${maxNoteEmbedsPerPreview} embedded notes at once.`,
      );
      continue;
    }
    budget.noteEmbedCount += 1;
    placeholder.ariaBusy = "true";
    placeholder.dataset.threadleafNoteEmbedStatus = "loading";
    let response: VaultNoteEmbedResponse;
    try {
      response = await options.loadNoteEmbed(
        sourceNotePath,
        placeholder.dataset.threadleafTarget ?? "",
        placeholder.dataset.threadleafSubpath || null,
        options.expectedVaultId,
      );
    } catch {
      if ((!options.isCurrent || options.isCurrent()) && root.contains(placeholder)) {
        markNoteEmbedUnavailable(host, label, "unreadable", "The embedded note request failed.");
      }
      continue;
    }
    if ((options.isCurrent && !options.isCurrent()) || !root.contains(placeholder)) {
      return;
    }
    if (response.status === "stale-vault" || response.vaultId !== options.expectedVaultId) {
      markNoteEmbedUnavailable(
        host,
        label,
        "stale-vault",
        "The active vault changed before this embedded note finished loading.",
      );
      continue;
    }
    if (response.status === "unavailable") {
      markNoteEmbedUnavailable(host, label, response.reason, response.message);
      continue;
    }
    const responseIdentity = noteEmbedIdentity(response.path, response.subpath);
    if (ancestors.has(responseIdentity)) {
      markNoteEmbedUnavailable(
        host,
        label,
        "cycle",
        `Embedding ${response.path} here would create a recursive note cycle.`,
      );
      continue;
    }
    if (budget.noteEmbedBytes + response.contentBytes > maxPreviewNoteEmbedBytes) {
      markNoteEmbedUnavailable(
        host,
        label,
        "preview-limit",
        "This reading view reached its 8 MiB embedded-note budget.",
      );
      continue;
    }
    budget.noteEmbedBytes += response.contentBytes;
    const { body, embed } = createNoteEmbed(placeholder, response);
    body.append(
      addPreviewSourceControls(renderMarkdownPreview(response.content), {
        sourceNotePath: response.path,
        lineOffset: response.startLine - 1,
      }),
    );
    options.decorateLinks(body, response.links, response.path);
    host.replaceWith(embed);
    await hydrateNoteEmbedTree(
      body,
      response.path,
      depth + 1,
      new Set([...ancestors, responseIdentity]),
      budget,
      options,
    );
  }
}

export async function hydrateMarkdownPreview(
  root: HTMLElement,
  options: PreviewNoteEmbedHydrationOptions,
): Promise<void> {
  await hydrateNoteEmbedTree(
    root,
    options.sourceNotePath,
    0,
    new Set([noteEmbedIdentity(options.sourceNotePath, null)]),
    createPreviewHydrationBudget(),
    options,
  );
}

export function renderMarkdownPreview(source: string): DocumentFragment {
  const html = markdown.render(maskFrontmatter(source));
  const fragment = DOMPurify.sanitize(html, sanitizeConfig);
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    if (anchor.dataset.threadleafLink) {
      continue;
    }
    const destination = anchor.getAttribute("href") ?? "";
    const external = isExternalLink(destination);
    anchor.classList.add(external ? "external-link" : "internal-link");
    anchor.dataset.threadleafLink = external ? "external" : "markdown";
    if (external) {
      anchor.dataset.threadleafExternalUrl = destination;
    } else {
      anchor.dataset.threadleafTarget = destination;
    }
    anchor.setAttribute("href", "#");
  }
  return fragment;
}

export interface PreviewSourceControlOptions {
  sourceNotePath?: string;
  lineOffset?: number;
}

export function addPreviewSourceControls(
  fragment: DocumentFragment,
  options: PreviewSourceControlOptions = {},
): DocumentFragment {
  const lineOffset = options.lineOffset ?? 0;
  for (const element of [...fragment.children]) {
    const mappedElement = element.hasAttribute("data-source-line")
      ? element
      : element.querySelector<HTMLElement>("[data-source-line]");
    const fragmentLine = Number.parseInt(mappedElement?.getAttribute("data-source-line") ?? "", 10);
    if (!Number.isSafeInteger(fragmentLine) || fragmentLine < 1) {
      continue;
    }
    const line = fragmentLine + lineOffset;
    const wrapper = fragment.ownerDocument.createElement("section");
    wrapper.className = "preview-block";
    wrapper.dataset.sourceLine = String(line);
    if (options.sourceNotePath) {
      wrapper.dataset.sourcePath = options.sourceNotePath;
    }
    const sourceButton = fragment.ownerDocument.createElement("button");
    sourceButton.type = "button";
    sourceButton.className = "preview-source-action";
    sourceButton.dataset.sourceLine = String(line);
    if (options.sourceNotePath) {
      sourceButton.dataset.sourcePath = options.sourceNotePath;
    }
    sourceButton.ariaLabel = `Edit source at line ${line}`;
    sourceButton.title = `Edit source at line ${line}`;
    sourceButton.textContent = String(line);
    fragment.insertBefore(wrapper, element);
    mappedElement?.removeAttribute("data-source-line");
    wrapper.append(sourceButton, element);
  }
  return fragment;
}
