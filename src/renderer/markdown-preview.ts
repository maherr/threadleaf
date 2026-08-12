import DOMPurify, { type Config } from "dompurify";
import MarkdownIt, { type RendererRule, type StateInline } from "markdown-it";
import type { VaultImageResponse } from "../shared/contracts";

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
  return `<span class="preview-asset-placeholder" role="note" data-threadleaf-asset="${escapeAttribute(source)}" data-threadleaf-alt="${escapeAttribute(alt)}">Image: ${escapeText(label)}</span>`;
};

const maxImagesPerPreview = 128;
const maxPreviewImageBytes = 64 * 1024 * 1024;

export interface PreviewImageHydrationOptions {
  sourceNotePath: string;
  expectedVaultId: string;
  loadImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
  isCurrent?(): boolean;
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
  let loadedBytes = 0;

  for (const [index, placeholder] of placeholders.entries()) {
    if (options.isCurrent && !options.isCurrent()) {
      return;
    }
    const label = imageLabel(placeholder);
    if (index >= maxImagesPerPreview) {
      markImageUnavailable(
        placeholder,
        label,
        "preview-limit",
        `Reading view loads at most ${maxImagesPerPreview} local images at once.`,
      );
      continue;
    }
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
    if (loadedBytes + response.size > maxPreviewImageBytes) {
      markImageUnavailable(
        placeholder,
        label,
        "preview-limit",
        "This reading view reached its 64 MiB local-image budget.",
      );
      continue;
    }
    loadedBytes += response.size;

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

export function addPreviewSourceControls(fragment: DocumentFragment): DocumentFragment {
  for (const element of [...fragment.children]) {
    const mappedElement = element.hasAttribute("data-source-line")
      ? element
      : element.querySelector<HTMLElement>("[data-source-line]");
    const line = Number.parseInt(mappedElement?.getAttribute("data-source-line") ?? "", 10);
    if (!Number.isSafeInteger(line) || line < 1) {
      continue;
    }
    const wrapper = document.createElement("section");
    wrapper.className = "preview-block";
    wrapper.dataset.sourceLine = String(line);
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.className = "preview-source-action";
    sourceButton.dataset.sourceLine = String(line);
    sourceButton.ariaLabel = `Edit source at line ${line}`;
    sourceButton.title = `Edit source at line ${line}`;
    sourceButton.textContent = String(line);
    fragment.insertBefore(wrapper, element);
    mappedElement?.removeAttribute("data-source-line");
    wrapper.append(sourceButton, element);
  }
  return fragment;
}
