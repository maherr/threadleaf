import DOMPurify, { type Config } from "dompurify";
import MarkdownIt, { type RendererRule, type StateBlock, type StateInline } from "markdown-it";
import { parseMarkdownLinks, splitMarkdownDestinationTarget } from "../kernel/markdown-links";
import {
  isCompletedMarkdownTaskStatus,
  markdownTaskStatusLabel,
  type ParsedMarkdownTask,
  parseMarkdownTasks,
} from "../kernel/markdown-tasks";
import { isPassiveAttachmentTarget } from "../shared/attachment-targets";
import type {
  CanvasLoadResponse,
  VaultAttachmentResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
  WorkspaceLinkSummary,
} from "../shared/contracts";
import { isValidTagBody } from "../shared/tags";
import { upgradeRenderedCallouts } from "./callouts";
import {
  collectFootnotes,
  type FootnoteCollection,
  type InlineMathCandidate,
  joinSourceLines,
  renderSafeMath,
  safeMathLimits,
  scanFrontmatter,
  scanInlineMath,
  splitSourceLines,
} from "./markdown-extensions";

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
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "summary",
  "sup",
  "sub",
  "section",
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
    "checked",
    "colspan",
    "data-source-line",
    "data-task",
    "data-threadleaf-alt",
    "data-threadleaf-attachment-alt",
    "data-threadleaf-attachment-target",
    "data-threadleaf-attachment-status",
    "data-threadleaf-asset",
    "data-threadleaf-canvas-embed",
    "data-threadleaf-embed",
    "data-threadleaf-external-url",
    "data-threadleaf-footnote",
    "data-threadleaf-footnote-ref",
    "data-threadleaf-math",
    "data-threadleaf-link",
    "data-threadleaf-note-embed",
    "data-threadleaf-render-token",
    "data-threadleaf-source-fallback",
    "data-threadleaf-subpath",
    "data-threadleaf-table",
    "data-threadleaf-task",
    "data-threadleaf-tag",
    "data-threadleaf-target",
    "data-tag-name",
    "href",
    "id",
    "role",
    "rowspan",
    "start",
    "scope",
    "title",
    "type",
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
  return splitMarkdownDestinationTarget(value);
}

function protectEscapedDestinationDelimiters(source: string): string {
  const replacements = parseMarkdownLinks(source)
    .map((link) => ({ start: link.targetStart, end: link.targetEnd }))
    .filter(({ start, end }) => /\\[?#]/u.test(source.slice(start, end)));
  let result = source;
  for (const { start, end } of [...replacements].sort((left, right) => right.start - left.start)) {
    const raw = result.slice(start, end);
    const protectedRaw = raw.replaceAll("\\?", "%3F").replaceAll("\\#", "%23");
    result = `${result.slice(0, start)}${protectedRaw}${result.slice(end)}`;
  }
  return result;
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

function tagRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src[start] !== "#" || state.linkLevel > 0) {
    return false;
  }
  if (start > 0 && !/[\s(]/u.test(state.src[start - 1] ?? "")) {
    return false;
  }
  const body = /^[\p{L}\p{M}\p{N}_/-]+/u.exec(state.src.slice(start + 1))?.[0];
  if (!body || !isValidTagBody(body)) {
    return false;
  }
  if (!silent) {
    const token = state.push("threadleaf_tag", "a", 0);
    token.meta = { tag: body };
  }
  state.pos = start + body.length + 1;
  return true;
}

interface MarkdownPreviewEnvironment {
  [key: string | symbol]: unknown;
  threadleafFootnotes: FootnoteCollection;
  threadleafFootnoteReferences: Map<string, number>;
  threadleafRenderToken: string;
  threadleafSourceText: string;
  threadleafInlineMathSource: string | null;
  threadleafInlineMathCandidates: ReadonlyMap<number, InlineMathCandidate | null> | null;
  threadleafInlineMathRejectedRanges: ReadonlyMap<number, { from: number; to: number }>;
  threadleafInlineMathUnmatchedOpeners: ReadonlySet<number>;
  threadleafInlineMathCandidatesSeen: number;
  threadleafTasks: ReadonlyMap<number, ParsedMarkdownTask>;
}

function previewEnvironment(value: unknown): MarkdownPreviewEnvironment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<MarkdownPreviewEnvironment>;
  return candidate.threadleafFootnotes && candidate.threadleafFootnoteReferences
    ? (candidate as MarkdownPreviewEnvironment)
    : null;
}

let renderTokenSequence = 0;

/**
 * Markup produced by our renderer needs an identity that raw HTML cannot
 * predict.  The token is removed before the fragment is returned; it exists
 * only while we separate generated controls from author-owned HTML.
 */
function createRenderToken(): string {
  renderTokenSequence += 1;
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `threadleaf-render-${random}-${renderTokenSequence.toString(36)}`;
}

function renderTokenAttribute(token: string | undefined): string {
  return token ? ` data-threadleaf-render-token="${escapeAttribute(token)}"` : "";
}

function isEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function footnoteReferenceRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const environment = previewEnvironment(state.env);
  if (state.src[start] !== "[" || state.src[start + 1] !== "^") {
    return false;
  }
  const close = state.src.indexOf("]", start + 2);
  if (close < 0 || close === start + 2 || state.src.slice(start + 2, close).includes("\n")) {
    return false;
  }
  const id = state.src.slice(start + 2, close);
  if (!environment?.threadleafFootnotes.ids.has(id) || isEscaped(state.src, start)) {
    return false;
  }
  if (!silent) {
    const token = state.push("threadleaf_footnote_ref", "sup", 0);
    token.meta = { id };
  }
  state.pos = close + 1;
  return true;
}

function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const environment = previewEnvironment(state.env);
  if (!environment) {
    return false;
  }
  if (environment.threadleafInlineMathSource !== state.src) {
    const remaining = Math.max(
      0,
      safeMathLimits.maxInlineMathCandidates - environment.threadleafInlineMathCandidatesSeen,
    );
    const scan = scanInlineMath(state.src, remaining);
    environment.threadleafInlineMathSource = state.src;
    environment.threadleafInlineMathCandidates = scan.candidates;
    environment.threadleafInlineMathRejectedRanges = scan.rejectedRanges;
    environment.threadleafInlineMathUnmatchedOpeners = scan.unmatchedOpeners;
    environment.threadleafInlineMathCandidatesSeen += scan.candidateCount;
  }
  const candidate = environment.threadleafInlineMathCandidates?.get(start);
  if (candidate === undefined) {
    return false;
  }
  const rejected = environment.threadleafInlineMathRejectedRanges.get(start);
  if (rejected) {
    if (!silent) {
      const token = state.push("text", "", 0);
      token.content = state.src.slice(rejected.from, rejected.to);
    }
    state.pos = rejected.to;
    return true;
  }
  if (candidate === null) {
    if (!environment.threadleafInlineMathUnmatchedOpeners.has(start)) {
      return false;
    }
    if (!silent) {
      const token = state.push("text", "", 0);
      token.content = state.src.slice(start);
    }
    state.pos = state.src.length;
    return true;
  }
  if (!silent) {
    const token = state.push("threadleaf_math_inline", "span", 0);
    token.meta = { expression: candidate.expression };
  }
  state.pos = candidate.to;
  return true;
}

function mathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const beginning = state.bMarks[startLine] ?? 0;
  const end = state.eMarks[startLine] ?? beginning;
  const marker = state.src.slice(beginning, end).trim();
  const closing = marker === "$$" ? "$$" : marker === "\\[" ? "\\]" : null;
  if (!closing) return false;
  let nextLine = startLine + 1;
  let closingLine = -1;
  while (nextLine < endLine && nextLine - startLine <= 256) {
    const nextStart = state.bMarks[nextLine] ?? 0;
    const nextEnd = state.eMarks[nextLine] ?? nextStart;
    if (state.src.slice(nextStart, nextEnd).trim() === closing) {
      closingLine = nextLine;
      break;
    }
    nextLine += 1;
  }
  if (closingLine < 0) return false;
  const content = state.getLines(startLine + 1, closingLine, state.blkIndent, true).trim();
  if (!renderSafeMath(content)) {
    if (silent) return true;
    const closingEnd = state.eMarks[closingLine] ?? beginning;
    const token = state.push("threadleaf_source_fallback", "pre", 0);
    token.block = true;
    token.map = [startLine, closingLine + 1];
    token.meta = { kind: "math" };
    token.content = state.src.slice(beginning, closingEnd);
    state.line = closingLine + 1;
    return true;
  }
  if (silent) return true;
  const token = state.push("threadleaf_math_block", "div", 0);
  token.block = true;
  token.map = [startLine, closingLine + 1];
  token.meta = { expression: content };
  token.content = content;
  state.line = closingLine + 1;
  return true;
}

function maskFrontmatter(source: string): string {
  const lines = splitSourceLines(source);
  const scan = scanFrontmatter(source);
  if (scan.status === "none") {
    return source;
  }
  const end = scan.closingLine ?? lines.length;
  return joinSourceLines(
    source,
    // Do not use the Unicode flag here: masking is a UTF-16 offset-preserving
    // operation, so an astral code point must become two spaces.
    lines.map((line, index) => (index < end ? line.replace(/[^\r]/g, " ") : line)),
  );
}

function literalizeSourceOnlyLines(source: string, sourceOnlyLines: ReadonlySet<number>): string {
  if (sourceOnlyLines.size === 0) return source;
  const lines = splitSourceLines(source);
  const literalize = (line: string): string =>
    [...line]
      .map((character) =>
        character === " " || character === "\t"
          ? character
          : `&#x${(character.codePointAt(0) ?? 0).toString(16)};`,
      )
      .join("");
  return joinSourceLines(
    source,
    lines.map((line, index) =>
      sourceOnlyLines.has(index + 1) && /\S/u.test(line) ? literalize(line) : line,
    ),
  );
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

function noteEmbedPlaceholder(
  target: string,
  subpath: string | null,
  label: string,
  renderToken?: string,
): string {
  return `<span class="preview-note-embed-placeholder" role="status" aria-label="Loading embedded note ${escapeAttribute(label)}" data-threadleaf-note-embed="true" data-threadleaf-target="${escapeAttribute(target)}" data-threadleaf-subpath="${escapeAttribute(subpath ?? "")}" data-threadleaf-alt="${escapeAttribute(label)}"${renderTokenAttribute(renderToken)}>Embedded note: ${escapeText(label)}</span>`;
}

function attachmentPlaceholder(target: string, label: string, renderToken?: string): string {
  return `<span class="preview-attachment-placeholder" role="status" aria-label="Loading local attachment ${escapeAttribute(label)}" data-threadleaf-attachment-target="${escapeAttribute(target)}" data-threadleaf-attachment-alt="${escapeAttribute(label)}"${renderTokenAttribute(renderToken)}>Attachment: ${escapeText(label)}</span>`;
}

function footnoteAnchor(id: string, number: number): string {
  const safeId = id
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `threadleaf-footnote-${number}-${safeId || "note"}`;
}

function renderFootnoteSection(
  collection: FootnoteCollection,
  environment: MarkdownPreviewEnvironment,
): string {
  if (collection.definitions.length === 0) return "";
  const footnoteEnvironment: MarkdownPreviewEnvironment = {
    ...environment,
    threadleafSourceText: "",
    threadleafInlineMathSource: null,
    threadleafInlineMathCandidates: null,
    threadleafInlineMathRejectedRanges: new Map(),
    threadleafInlineMathUnmatchedOpeners: new Set(),
    threadleafInlineMathCandidatesSeen: 0,
  };
  const firstLine = collection.definitions[0]?.sourceLine ?? 1;
  const items = collection.definitions
    .map((definition, index) => {
      const number = index + 1;
      const anchor = footnoteAnchor(definition.id, number);
      const rendered = markdown.renderInline(
        protectEscapedDestinationDelimiters(definition.content),
        footnoteEnvironment,
      );
      const references = environment.threadleafFootnoteReferences.get(definition.id) ?? 0;
      const backrefs = Array.from({ length: references }, (_, referenceIndex) => {
        const reference = `${anchor}-ref-${referenceIndex + 1}`;
        return `<a class="preview-footnote-backref" href="#${reference}" aria-label="Back to footnote ${number}"${renderTokenAttribute(environment.threadleafRenderToken)}>↩</a>`;
      }).join(" ");
      return `<li id="${anchor}" data-source-line="${definition.sourceLine}" data-threadleaf-footnote="${escapeAttribute(definition.id)}"${renderTokenAttribute(environment.threadleafRenderToken)}><span class="preview-footnote-number">${number}.</span><span class="preview-footnote-content">${rendered}</span>${backrefs ? `<span class="preview-footnote-backrefs">${backrefs}</span>` : ""}</li>`;
    })
    .join("");
  return `<section class="preview-footnotes" data-source-line="${firstLine}" data-threadleaf-footnote="section"${renderTokenAttribute(environment.threadleafRenderToken)}><h2>Footnotes</h2><ol>${items}</ol></section>`;
}

function canvasEmbedPlaceholder(target: string, label: string, renderToken?: string): string {
  return `<span class="preview-canvas-embed-placeholder" role="status" aria-label="Loading embedded canvas ${escapeAttribute(label)}" data-threadleaf-canvas-embed="true" data-threadleaf-target="${escapeAttribute(target)}" data-threadleaf-alt="${escapeAttribute(label)}"${renderTokenAttribute(renderToken)}>Embedded canvas: ${escapeText(label)}</span>`;
}

const markdown = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

markdown.inline.ruler.before("image", "threadleaf_wikilink", wikiLinkRule);
markdown.inline.ruler.before("text", "threadleaf_footnote_ref", footnoteReferenceRule);
markdown.inline.ruler.before("text", "threadleaf_math_inline", mathInlineRule);
markdown.inline.ruler.before("text", "threadleaf_tag", tagRule);
markdown.block.ruler.before("fence", "threadleaf_math_block", mathBlockRule);

markdown.core.ruler.after("block", "threadleaf_source_lines", (state) => {
  const renderToken = previewEnvironment(state.env)?.threadleafRenderToken;
  for (const token of state.tokens) {
    if (token.level === 0 && token.map && token.nesting >= 0 && token.type !== "inline") {
      token.attrSet("data-source-line", String(token.map[0] + 1));
      if (renderToken) {
        token.attrSet("data-threadleaf-render-token", renderToken);
      }
    }
  }
});

function taskForToken(
  environment: MarkdownPreviewEnvironment | null,
  token: { map?: [number, number] | null } | undefined,
): ParsedMarkdownTask | null {
  const sourceLine = token?.map?.[0];
  return sourceLine === undefined
    ? null
    : (environment?.threadleafTasks.get(sourceLine + 1) ?? null);
}

function renderTaskCheckbox(task: ParsedMarkdownTask, renderToken: string | undefined): string {
  const checked = isCompletedMarkdownTaskStatus(task.status);
  const label = [markdownTaskStatusLabel(task.status), task.text].filter(Boolean).join(", ");
  return `<input type="checkbox" class="task-list-item-checkbox" data-threadleaf-task="true" data-task="${escapeAttribute(task.status)}" aria-label="${escapeAttribute(label)}"${checked ? " checked" : ""}${renderTokenAttribute(renderToken)}>`;
}

markdown.core.ruler.after("inline", "threadleaf_task_markers", (state) => {
  const environment = previewEnvironment(state.env);
  for (const token of state.tokens) {
    const task = taskForToken(environment, token);
    const first = token.type === "inline" ? token.children?.[0] : null;
    const marker = task ? `[${task.status}]` : null;
    if (!task || !first || first.type !== "text" || !marker || !first.content.startsWith(marker)) {
      continue;
    }
    const remaining = first.content.slice(marker.length);
    if (remaining.length === 0 || /^[\t ]/u.test(remaining)) {
      first.content = remaining.length > 0 ? remaining.slice(1) : "";
    }
  }
});

const defaultListItemOpen = markdown.renderer.rules.list_item_open;
markdown.renderer.rules.list_item_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const environment = previewEnvironment(env);
  const task = taskForToken(environment, token);
  if (!token || !task) {
    return defaultListItemOpen
      ? defaultListItemOpen(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  }
  token.attrJoin("class", "task-list-item");
  token.attrSet("data-task", task.status);
  token.attrSet("data-source-line", String(task.line));
  token.attrSet("data-threadleaf-render-token", environment?.threadleafRenderToken ?? "");
  const opened = defaultListItemOpen
    ? defaultListItemOpen(tokens, index, options, env, renderer)
    : renderer.renderToken(tokens, index, options);
  return `${opened}${renderTaskCheckbox(task, environment?.threadleafRenderToken)}`;
};

const defaultBlockquoteOpen = markdown.renderer.rules.blockquote_open;
markdown.renderer.rules.blockquote_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (!token) return "";
  if (token.map) {
    token.attrSet("data-source-line", String(token.map[0] + 1));
  }
  const renderToken = previewEnvironment(env)?.threadleafRenderToken;
  if (renderToken) token.attrSet("data-threadleaf-render-token", renderToken);
  return defaultBlockquoteOpen
    ? defaultBlockquoteOpen(tokens, index, options, env, renderer)
    : renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.threadleaf_wikilink = (tokens, index, _options, env) => {
  const link = tokens[index]?.meta as PreviewWikiLink | undefined;
  if (!link) {
    return "";
  }
  const renderToken = previewEnvironment(env)?.threadleafRenderToken;
  const fallback = `${link.target}${link.subpath ?? ""}`;
  const label = link.alias ?? fallback;
  if (link.embed && /\.(?:gif|jpe?g|png|webp)$/iu.test(link.target)) {
    return `<span class="preview-asset-placeholder" role="note" data-threadleaf-asset="${escapeAttribute(link.target)}" data-threadleaf-alt="${escapeAttribute(link.alias ?? "")}"${renderTokenAttribute(renderToken)}>Image: ${escapeText(label)}</span>`;
  }
  if (link.embed && link.target.toLocaleLowerCase("en-US").endsWith(".canvas")) {
    return canvasEmbedPlaceholder(link.target, label, renderToken);
  }
  if (link.embed && isMarkdownNoteTarget(link.target, link.subpath, true)) {
    return noteEmbedPlaceholder(link.target, link.subpath, label, renderToken);
  }
  if (link.embed && isPassiveAttachmentTarget(link.target)) {
    return attachmentPlaceholder(link.target, label, renderToken);
  }
  const classes = link.embed ? "internal-link preview-embed-link" : "internal-link";
  return `<a href="#" class="${classes}" data-threadleaf-link="wiki" data-threadleaf-target="${escapeAttribute(link.target)}" data-threadleaf-subpath="${escapeAttribute(link.subpath ?? "")}" data-threadleaf-embed="${String(link.embed)}"${renderTokenAttribute(renderToken)}>${escapeText(label)}</a>`;
};

markdown.renderer.rules.threadleaf_tag = (tokens, index, _options, env) => {
  const tag = String(tokens[index]?.meta?.tag ?? "");
  if (!isValidTagBody(tag)) return "";
  return `<a class="tag" href="#${escapeAttribute(tag)}" data-threadleaf-tag="${escapeAttribute(tag)}" data-tag-name="#${escapeAttribute(tag)}"${renderTokenAttribute(previewEnvironment(env)?.threadleafRenderToken)}>#${escapeText(tag)}</a>`;
};

markdown.renderer.rules.threadleaf_math_inline = (tokens, index, _options, env) => {
  const expression = String(tokens[index]?.meta?.expression ?? "");
  const rendered = renderSafeMath(expression);
  if (!rendered) return escapeText(`$${expression}$`);
  return `<span class="preview-math" role="math" data-threadleaf-math="inline" aria-label="${escapeAttribute(rendered.text)}"${renderTokenAttribute(previewEnvironment(env)?.threadleafRenderToken)}>${rendered.html}</span>`;
};

markdown.renderer.rules.threadleaf_math_block = (tokens, index, _options, env) => {
  const expression = String(tokens[index]?.meta?.expression ?? "");
  const rendered = renderSafeMath(expression);
  if (!rendered) return escapeText(`$$\n${expression}\n$$`);
  return `<div class="preview-math-block" role="math" data-threadleaf-math="block" aria-label="${escapeAttribute(rendered.text)}"${renderTokenAttribute(previewEnvironment(env)?.threadleafRenderToken)}>${rendered.html}</div>`;
};

markdown.renderer.rules.threadleaf_source_fallback = (tokens, index, _options, env) => {
  const token = tokens[index];
  const line = token?.attrGet("data-source-line");
  const sourceLine = line ? ` data-source-line="${escapeAttribute(String(line))}"` : "";
  return `<pre class="preview-source-fallback" data-threadleaf-source-fallback="math"${sourceLine}${renderTokenAttribute(previewEnvironment(env)?.threadleafRenderToken)}>${escapeText(token?.content ?? "")}</pre>`;
};

markdown.renderer.rules.threadleaf_footnote_ref = (tokens, index, _options, env) => {
  const id = String(tokens[index]?.meta?.id ?? "");
  const environment = previewEnvironment(env);
  const number = environment ? [...environment.threadleafFootnotes.ids].indexOf(id) + 1 : 0;
  if (!environment || number < 1) return escapeText(`[^${id}]`);
  const occurrence = (environment.threadleafFootnoteReferences.get(id) ?? 0) + 1;
  environment.threadleafFootnoteReferences.set(id, occurrence);
  const anchor = footnoteAnchor(id, number);
  const reference = `${anchor}-ref-${occurrence}`;
  return `<sup class="preview-footnote-ref"${renderTokenAttribute(environment.threadleafRenderToken)}><a href="#${anchor}" id="${reference}" data-threadleaf-footnote-ref="true" data-threadleaf-footnote="${escapeAttribute(id)}" aria-label="Footnote ${number}"${renderTokenAttribute(environment.threadleafRenderToken)}>${number}</a></sup>`;
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
  if (token.tag === "th") {
    token.attrSet("scope", "col");
  }
  return renderer.renderToken(tokens, index, options);
};

markdown.renderer.rules.th_open = renderAlignedTableCell;
markdown.renderer.rules.td_open = renderAlignedTableCell;

const defaultTableOpen = markdown.renderer.rules.table_open;
markdown.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (!token) return "";
  token.attrJoin("class", "preview-gfm-table");
  token.attrSet("data-threadleaf-table", "gfm");
  const renderToken = previewEnvironment(env)?.threadleafRenderToken;
  if (renderToken) token.attrSet("data-threadleaf-render-token", renderToken);
  return defaultTableOpen
    ? defaultTableOpen(tokens, index, options, env, renderer)
    : renderer.renderToken(tokens, index, options);
};

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
  const renderToken = previewEnvironment(env)?.threadleafRenderToken;
  if (renderToken) token.attrSet("data-threadleaf-render-token", renderToken);
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
  const renderToken = previewEnvironment(env)?.threadleafRenderToken;
  const { target, subpath } = splitTarget(source);
  if (isMarkdownNoteTarget(target, subpath, false)) {
    return noteEmbedPlaceholder(target, subpath, label, renderToken);
  }
  if (target.toLocaleLowerCase("en-US").endsWith(".canvas")) {
    return canvasEmbedPlaceholder(target, label, renderToken);
  }
  if (!/^.*\.(?:gif|jpe?g|png|webp)$/iu.test(target)) {
    return attachmentPlaceholder(target, label, renderToken);
  }
  return `<span class="preview-asset-placeholder" role="note" data-threadleaf-asset="${escapeAttribute(source)}" data-threadleaf-alt="${escapeAttribute(alt)}"${renderTokenAttribute(renderToken)}>Image: ${escapeText(label)}</span>`;
};

const maxImagesPerPreview = 128;
const maxPreviewImageBytes = 64 * 1024 * 1024;
const maxNoteEmbedsPerPreview = 32;
const maxPreviewNoteEmbedBytes = 8 * 1024 * 1024;
const maxNoteEmbedDepth = 4;

interface PreviewHydrationBudget {
  imageBytes: number;
  imageCount: number;
  attachmentCount: number;
  noteEmbedBytes: number;
  noteEmbedCount: number;
  canvasEmbedCount: number;
}

function createPreviewHydrationBudget(): PreviewHydrationBudget {
  return {
    imageBytes: 0,
    imageCount: 0,
    attachmentCount: 0,
    noteEmbedBytes: 0,
    noteEmbedCount: 0,
    canvasEmbedCount: 0,
  };
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
  loadAttachment?(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultAttachmentResponse>;
  loadNoteEmbed(
    sourceNotePath: string,
    target: string,
    subpath: string | null,
    expectedVaultId: string,
  ): Promise<VaultNoteEmbedResponse>;
  loadCanvas?(path: string, expectedVaultId: string): Promise<CanvasLoadResponse>;
  decorateLinks(
    root: HTMLElement,
    links: readonly WorkspaceLinkSummary[],
    sourceNotePath: string,
  ): void;
  isCurrent?(): boolean;
}

const maxAttachmentsPerPreview = 128;

function attachmentLabel(placeholder: HTMLElement): string {
  return (
    placeholder.dataset.threadleafAttachmentAlt ||
    placeholder.dataset.threadleafAttachmentTarget ||
    "attachment"
  );
}

function formatAttachmentSize(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(1)} KiB`;
  return `${(size / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function markAttachmentUnavailable(
  placeholder: HTMLElement,
  label: string,
  status: string,
  message: string,
  recovery?: Extract<VaultAttachmentResponse, { status: "unavailable" }>["recovery"],
  sourceNotePath?: string,
): void {
  placeholder.className = "preview-attachment-card preview-attachment-unavailable";
  placeholder.dataset.threadleafAttachmentStatus = status;
  placeholder.setAttribute("role", recovery ? "group" : "note");
  placeholder.setAttribute("aria-label", `Attachment unavailable: ${label}`);
  placeholder.title = message;
  placeholder.replaceChildren();
  const marker = placeholder.ownerDocument.createElement("span");
  marker.className = "preview-attachment-marker";
  marker.ariaHidden = "true";
  marker.textContent = "×";
  const copy = placeholder.ownerDocument.createElement("span");
  copy.className = "preview-attachment-copy";
  const title = placeholder.ownerDocument.createElement("strong");
  title.textContent = `Attachment unavailable: ${label}`;
  const detail = placeholder.ownerDocument.createElement("span");
  detail.textContent = message;
  copy.append(title, detail);
  placeholder.append(marker, copy);
  if (recovery?.kind === "relink" && sourceNotePath) {
    placeholder.dataset.threadleafAttachmentSourceRevision = recovery.sourceNoteRevision;
    placeholder.dataset.threadleafAttachmentSourceNotePath = sourceNotePath;
    const actions = placeholder.ownerDocument.createElement("span");
    actions.className = "preview-attachment-actions";
    const button = placeholder.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "preview-attachment-action";
    button.dataset.threadleafAttachmentAction = "relink";
    button.dataset.threadleafAttachmentPath = recovery.missingPath;
    button.dataset.threadleafAttachmentMissingTarget =
      placeholder.dataset.threadleafAttachmentTarget ?? "";
    button.dataset.threadleafAttachmentSourceNotePath = sourceNotePath;
    button.textContent = "Relink";
    button.title = `Relink the missing attachment ${recovery.missingPath}`;
    actions.append(button);
    placeholder.append(actions);
  }
}

function createAttachmentCard(
  placeholder: HTMLElement,
  response: Extract<VaultAttachmentResponse, { status: "ready" }>,
  label: string,
): HTMLElement {
  const document = placeholder.ownerDocument;
  const card = document.createElement("section");
  card.className = "preview-attachment-card";
  card.dataset.threadleafAttachmentStatus = "ready";
  card.dataset.threadleafAttachmentPath = response.attachment.path;
  card.dataset.threadleafAttachmentRevision = response.attachment.revision;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `Local attachment ${response.attachment.path}`);

  const marker = document.createElement("span");
  marker.className = "preview-attachment-marker";
  marker.ariaHidden = "true";
  marker.textContent = response.attachment.kind === "unsupported" ? "?" : "↗";
  const body = document.createElement("span");
  body.className = "preview-attachment-copy";
  const title = document.createElement("strong");
  title.textContent = label || response.attachment.path;
  const detail = document.createElement("span");
  detail.textContent = `${response.attachment.kind} · ${response.attachment.mimeType ?? "unknown format"} · ${formatAttachmentSize(response.attachment.size)}`;
  body.append(title, detail);
  const actions = document.createElement("span");
  actions.className = "preview-attachment-actions";
  const actionNames: Array<"open" | "reveal" | "rename" | "move"> = [];
  if (response.attachment.actions.open) actionNames.push("open");
  if (response.attachment.actions.reveal) actionNames.push("reveal");
  if (response.attachment.actions.rename) actionNames.push("rename");
  if (response.attachment.actions.move) actionNames.push("move");
  for (const action of actionNames) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preview-attachment-action";
    button.dataset.threadleafAttachmentAction = action;
    button.dataset.threadleafAttachmentPath = response.attachment.path;
    const label =
      action === "open"
        ? "Open"
        : action === "reveal"
          ? "Reveal"
          : action === "rename"
            ? "Rename or move"
            : "Publish copy";
    button.textContent = label;
    button.title = `${action === "move" ? "Publish a retained copy of" : label} ${response.attachment.path}`;
    actions.append(button);
  }
  card.append(marker, body, actions);
  return card;
}

export async function hydrateMarkdownPreviewAttachments(
  root: HTMLElement,
  options: Omit<
    Pick<
      PreviewNoteEmbedHydrationOptions,
      "sourceNotePath" | "expectedVaultId" | "loadAttachment" | "isCurrent"
    >,
    "loadAttachment"
  > & {
    loadAttachment: NonNullable<PreviewNoteEmbedHydrationOptions["loadAttachment"]>;
    budget?: PreviewHydrationBudget;
  },
): Promise<void> {
  const placeholders = [
    ...root.querySelectorAll<HTMLElement>(
      ".preview-attachment-placeholder[data-threadleaf-attachment-target]",
    ),
  ];
  const budget = options.budget ?? createPreviewHydrationBudget();
  const loadAttachment = options.loadAttachment;
  for (const placeholder of placeholders) {
    if ((options.isCurrent && !options.isCurrent()) || !root.contains(placeholder)) return;
    const label = attachmentLabel(placeholder);
    if (budget.attachmentCount >= maxAttachmentsPerPreview) {
      markAttachmentUnavailable(
        placeholder,
        label,
        "preview-limit",
        `Reading view loads at most ${maxAttachmentsPerPreview} local attachments at once.`,
      );
      continue;
    }
    budget.attachmentCount += 1;
    const target = placeholder.dataset.threadleafAttachmentTarget ?? "";
    placeholder.dataset.threadleafAttachmentStatus = "loading";
    placeholder.ariaBusy = "true";
    let response: VaultAttachmentResponse;
    try {
      response = await loadAttachment(options.sourceNotePath, target, options.expectedVaultId);
    } catch {
      if ((!options.isCurrent || options.isCurrent()) && root.contains(placeholder)) {
        markAttachmentUnavailable(
          placeholder,
          label,
          "unreadable",
          "The local attachment request failed.",
        );
      }
      continue;
    }
    if ((options.isCurrent && !options.isCurrent()) || !root.contains(placeholder)) return;
    if (response.status === "stale-vault" || response.vaultId !== options.expectedVaultId) {
      markAttachmentUnavailable(
        placeholder,
        label,
        "stale-vault",
        "The active vault changed before this attachment finished loading.",
      );
      continue;
    }
    if (response.status === "unavailable") {
      markAttachmentUnavailable(
        placeholder,
        label,
        response.reason,
        response.message,
        response.recovery,
        options.sourceNotePath,
      );
      continue;
    }
    placeholder.replaceWith(createAttachmentCard(placeholder, response, label));
  }
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

function markCanvasEmbedUnavailable(
  placeholder: HTMLElement,
  label: string,
  message: string,
): void {
  placeholder.className = "preview-canvas-embed preview-canvas-embed-unavailable";
  placeholder.setAttribute("role", "note");
  placeholder.setAttribute("aria-label", `Embedded canvas unavailable: ${label}`);
  placeholder.textContent = `Embedded canvas unavailable: ${message}`;
}

function createCanvasEmbed(
  placeholder: HTMLElement,
  response: Extract<CanvasLoadResponse, { status: "ready" }>,
): HTMLElement {
  const embed = placeholder.ownerDocument.createElement("section");
  embed.className = "preview-canvas-embed";
  embed.dataset.threadleafCanvasEmbedStatus = "ready";
  embed.dataset.threadleafPath = response.canvas.path;
  embed.dataset.threadleafRevision = response.canvas.revision;
  embed.setAttribute("aria-label", `Embedded canvas ${response.canvas.path}`);
  const header = placeholder.ownerDocument.createElement("header");
  header.className = "preview-canvas-embed-header";
  const marker = placeholder.ownerDocument.createElement("span");
  marker.textContent = "▦";
  marker.ariaHidden = "true";
  const open = placeholder.ownerDocument.createElement("button");
  open.type = "button";
  open.className = "preview-canvas-embed-open";
  open.dataset.threadleafOpenPath = response.canvas.path;
  open.textContent = response.canvas.path;
  open.ariaLabel = `Open canvas ${response.canvas.path}`;
  header.append(marker, open);
  const body = placeholder.ownerDocument.createElement("ul");
  body.className = "preview-canvas-embed-objects";
  for (const node of response.canvas.document?.nodes ?? []) {
    if (!node || typeof node !== "object") {
      continue;
    }
    const item = placeholder.ownerDocument.createElement("li");
    const value =
      node.type === "text" && typeof node.text === "string"
        ? node.text
        : node.type === "file" && typeof node.file === "string"
          ? node.file
          : node.type === "link" && typeof node.url === "string"
            ? `External link (inactive): ${node.url}`
            : node.type;
    item.textContent = `${node.type}: ${value}`;
    body.append(item);
  }
  if ((response.canvas.document?.nodes?.length ?? 0) === 0) {
    const item = placeholder.ownerDocument.createElement("li");
    item.textContent = "Canvas has no objects.";
    body.append(item);
  }
  embed.append(header, body);
  if (response.canvas.diagnostics.length > 0) {
    const warning = placeholder.ownerDocument.createElement("p");
    warning.textContent = `Read-only: ${response.canvas.diagnostics.length} validation issue(s).`;
    embed.append(warning);
  }
  return embed;
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
  if (options.loadAttachment) {
    await hydrateMarkdownPreviewAttachments(root, {
      sourceNotePath,
      expectedVaultId: options.expectedVaultId,
      loadAttachment: options.loadAttachment,
      budget,
      ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
    });
  }
  const canvasPlaceholders = [
    ...root.querySelectorAll<HTMLElement>(
      ".preview-canvas-embed-placeholder[data-threadleaf-canvas-embed]",
    ),
  ];
  for (const placeholder of canvasPlaceholders) {
    if ((options.isCurrent && !options.isCurrent()) || !root.contains(placeholder)) {
      return;
    }
    const label =
      placeholder.dataset.threadleafAlt || placeholder.dataset.threadleafTarget || "canvas";
    if (budget.canvasEmbedCount >= maxNoteEmbedsPerPreview) {
      markCanvasEmbedUnavailable(placeholder, label, "the embedded-canvas limit was reached");
      continue;
    }
    budget.canvasEmbedCount += 1;
    if (!options.loadCanvas) {
      markCanvasEmbedUnavailable(placeholder, label, "canvas loading is unavailable");
      continue;
    }
    try {
      const response = await options.loadCanvas(
        placeholder.dataset.threadleafTarget ?? "",
        options.expectedVaultId,
      );
      if (response.status === "stale-vault" || response.vaultId !== options.expectedVaultId) {
        markCanvasEmbedUnavailable(placeholder, label, "the active vault changed");
      } else if (response.status === "unavailable") {
        markCanvasEmbedUnavailable(placeholder, label, response.message);
      } else {
        placeholder.replaceWith(createCanvasEmbed(placeholder, response));
      }
    } catch {
      markCanvasEmbedUnavailable(placeholder, label, "the canvas request failed");
    }
  }
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
  const frontmatter = scanFrontmatter(source);
  if (frontmatter.status === "unresolved") {
    const fallback = DOMPurify.sanitize(
      `<pre class="preview-source-fallback" data-threadleaf-source-fallback="frontmatter">${escapeText(source)}</pre>`,
      sanitizeConfig,
    );
    return fallback;
  }
  const footnotes = collectFootnotes(source);
  const sourceOnlyLines = new Set(footnotes.definitionLines);
  if (frontmatter.status === "resolved" && frontmatter.closingLine !== null) {
    for (let lineNumber = 1; lineNumber <= frontmatter.closingLine; lineNumber += 1) {
      sourceOnlyLines.add(lineNumber);
    }
  }
  const renderToken = createRenderToken();
  const environment: MarkdownPreviewEnvironment = {
    threadleafFootnotes: footnotes,
    threadleafFootnoteReferences: new Map(),
    threadleafRenderToken: renderToken,
    threadleafSourceText: protectEscapedDestinationDelimiters(
      literalizeSourceOnlyLines(maskFrontmatter(footnotes.body), sourceOnlyLines),
    ),
    threadleafInlineMathSource: null,
    threadleafInlineMathCandidates: null,
    threadleafInlineMathRejectedRanges: new Map(),
    threadleafInlineMathUnmatchedOpeners: new Set(),
    threadleafInlineMathCandidatesSeen: 0,
    threadleafTasks: new Map(parseMarkdownTasks(source).map((task) => [task.line, task])),
  };
  const bodyHtml = markdown.render(environment.threadleafSourceText, environment);
  const html = bodyHtml + renderFootnoteSection(footnotes, environment);
  const fragment = DOMPurify.sanitize(html, sanitizeConfig);
  upgradeRenderedCallouts(
    fragment,
    environment.threadleafSourceText,
    environment.threadleafRenderToken,
  );
  const privilegedClasses = new Set([
    "external-link",
    "internal-link",
    "preview-embed-link",
    "preview-footnote-backref",
    "preview-footnote-ref",
  ]);
  const trustedElements = new WeakSet<Element>();
  for (const element of fragment.querySelectorAll<HTMLElement>("*")) {
    if (element.getAttribute("data-threadleaf-render-token") === renderToken) {
      trustedElements.add(element);
      element.removeAttribute("data-threadleaf-render-token");
      continue;
    }
    if (element.tagName === "INPUT") {
      element.remove();
      continue;
    }
    // Raw HTML is source-owned.  Its marker attributes and navigation-shaped
    // classes are never an authority for generated controls, source buttons,
    // hydration, or export.  Remove them before looking at any href.
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name.startsWith("data-threadleaf-") ||
        attribute.name === "data-source-line" ||
        attribute.name === "data-task"
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const className of privilegedClasses) {
      element.classList.remove(className);
    }
  }
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    if (trustedElements.has(anchor)) {
      continue;
    }
    const destination = anchor.getAttribute("href") ?? "";
    const external = isExternalLink(destination);
    anchor.classList.add(external ? "external-link" : "internal-link");
    anchor.dataset.threadleafLink = external ? "external" : "markdown";
    anchor.dataset.threadleafRawLink = "true";
    // Raw HTML links remain inert. Their destination is useful only for the
    // classification above; retaining it in a privileged-looking data
    // attribute would let author HTML masquerade as a generated link.
    anchor.removeAttribute("data-threadleaf-external-url");
    anchor.removeAttribute("data-threadleaf-target");
    anchor.setAttribute("href", "#");
  }
  return fragment;
}

/**
 * Every native-control class a settled plugin projection must never carry: the five privileged
 * classes `renderMarkdownPreview` strips from untrusted (non-render-token) elements, plus the
 * four classes `renderer.ts` matches by `closest()` to dispatch a delegated click (source jump,
 * note-embed open, attachment action, canvas-embed open). Neither list alone is sufficient --
 * `renderMarkdownPreview`'s own untrusted-element pass (markdown-preview.ts) only needed the
 * first five, because the delegated-click four are never emitted by ordinary note-content
 * rendering in the first place. Plugin output has no such constraint.
 */
const strippedProjectionClasses = new Set([
  "external-link",
  "internal-link",
  "preview-embed-link",
  "preview-footnote-backref",
  "preview-footnote-ref",
  "preview-source-action",
  "preview-note-embed-open",
  "preview-attachment-action",
  "preview-canvas-embed-open",
]);

/**
 * Sanitize an exact plugin's settled (already-executed) Markdown post-processor HTML for display
 * as a bounded, explicitly labeled Reading-view projection. Reuses the exact same allowlist as
 * ordinary note content (`sanitizeConfig`), then additionally strips every
 * `data-threadleaf-*`/`data-source-line` attribute, every privileged/delegated-click class in
 * {@link strippedProjectionClasses}, and inert-links every anchor: plugin-produced markup is
 * never a trusted render-token source and must never be able to pose as an internal link,
 * footnote, wiki embed, source-jump control, or other privileged or click-delegated native
 * control.
 */
export function sanitizePluginMarkdownProjection(html: string): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, sanitizeConfig);
  for (const input of fragment.querySelectorAll("input")) {
    input.remove();
  }
  for (const element of fragment.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name.startsWith("data-threadleaf-") ||
        attribute.name === "data-source-line" ||
        attribute.name === "data-task"
      ) {
        element.removeAttribute(attribute.name);
      }
    }
    for (const className of strippedProjectionClasses) {
      element.classList.remove(className);
    }
  }
  for (const anchor of fragment.querySelectorAll<HTMLAnchorElement>("a")) {
    anchor.removeAttribute("href");
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
