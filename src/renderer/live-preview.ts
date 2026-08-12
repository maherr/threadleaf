import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { VaultImageResponse } from "../shared/contracts";

export type LivePreviewLinkSyntax = "wiki" | "markdown";

export interface LivePreviewLink {
  syntax: LivePreviewLinkSyntax;
  target: string;
  subpath: string | null;
  label: string;
  embed: boolean;
  external: boolean;
}

export interface LivePreviewOptions {
  sourceNotePath(): string | null;
  expectedVaultId(): string | null;
  activateLink(link: LivePreviewLink): void;
  loadImage(
    sourceNotePath: string,
    target: string,
    expectedVaultId: string,
  ): Promise<VaultImageResponse>;
}

interface SourceRange {
  from: number;
  to: number;
}

interface ParsedInlineToken extends SourceRange {
  kind: "link" | "image" | "embed" | "callout" | "tag";
  link?: LivePreviewLink;
  label: string;
}

const rasterImagePattern = /\.(?:gif|jpe?g|png|webp)$/iu;

function isExternalTarget(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
}

function splitTarget(value: string): { target: string; subpath: string | null } {
  let normalized: string;
  try {
    normalized = decodeURIComponent(value).replaceAll("\\", "/");
  } catch {
    normalized = value.replaceAll("\\", "/");
  }
  const headingIndex = normalized.indexOf("#");
  const blockIndex = normalized.indexOf("^");
  const indexes = [headingIndex, blockIndex].filter((index) => index >= 0);
  const splitAt = indexes.length > 0 ? Math.min(...indexes) : -1;
  if (splitAt === -1) {
    return { target: normalized.trim(), subpath: null };
  }
  return {
    target: normalized.slice(0, splitAt).trim(),
    subpath: normalized.slice(splitAt).trim() || null,
  };
}

function rangesIntersect(left: SourceRange, right: SourceRange): boolean {
  return left.from < right.to && right.from < left.to;
}

function intersectsAny(range: SourceRange, ranges: readonly SourceRange[]): boolean {
  return ranges.some((candidate) => rangesIntersect(range, candidate));
}

function parseWikiLink(raw: string, embed: boolean): LivePreviewLink | null {
  const aliasAt = raw.indexOf("|");
  const rawTarget = aliasAt === -1 ? raw : raw.slice(0, aliasAt);
  const { target, subpath } = splitTarget(rawTarget.trim());
  if (!target && !subpath) {
    return null;
  }
  return {
    syntax: "wiki",
    target,
    subpath,
    label: (aliasAt === -1 ? "" : raw.slice(aliasAt + 1).trim()) || `${target}${subpath ?? ""}`,
    embed,
    external: isExternalTarget(target),
  };
}

function parseMarkdownLink(
  rawTarget: string,
  label: string,
  embed: boolean,
): LivePreviewLink | null {
  const trimmed = rawTarget.trim();
  const destination =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  if (!destination || /\s/u.test(destination)) {
    return null;
  }
  const { target, subpath } = splitTarget(destination);
  if (!target && !subpath) {
    return null;
  }
  return {
    syntax: "markdown",
    target,
    subpath,
    label: label.trim() || `${target}${subpath ?? ""}`,
    embed,
    external: isExternalTarget(target),
  };
}

export function parseLivePreviewLine(
  text: string,
  lineFrom: number,
  protectedRanges: readonly SourceRange[] = [],
): ParsedInlineToken[] {
  const tokens: ParsedInlineToken[] = [];
  const occupied: SourceRange[] = [];
  const add = (token: ParsedInlineToken): void => {
    if (intersectsAny(token, protectedRanges) || intersectsAny(token, occupied)) {
      return;
    }
    tokens.push(token);
    occupied.push(token);
  };

  const callout = /^\s*>\s*\[!([a-z0-9_-]+)\](?:[+-])?/iu.exec(text);
  if (callout?.[0] && callout[1]) {
    const markerAt = callout[0].indexOf("[!");
    const marker = callout[0].slice(markerAt);
    add({
      from: lineFrom + markerAt,
      to: lineFrom + markerAt + marker.length,
      kind: "callout",
      label: callout[1].replaceAll(/[-_]+/gu, " "),
    });
  }

  for (const match of text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/gu)) {
    const full = match[0];
    const raw = match[2];
    if (match.index === undefined || !raw) {
      continue;
    }
    const embed = match[1] === "!";
    const link = parseWikiLink(raw, embed);
    if (!link) {
      continue;
    }
    add({
      from: lineFrom + match.index,
      to: lineFrom + match.index + full.length,
      kind: embed ? (rasterImagePattern.test(link.target) ? "image" : "embed") : "link",
      link,
      label: link.label,
    });
  }

  for (const match of text.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/gu)) {
    const full = match[0];
    const label = match[2] ?? "";
    const rawTarget = match[3];
    if (match.index === undefined || !rawTarget) {
      continue;
    }
    const embed = match[1] === "!";
    const link = parseMarkdownLink(rawTarget, label, embed);
    if (!link) {
      continue;
    }
    add({
      from: lineFrom + match.index,
      to: lineFrom + match.index + full.length,
      kind: embed ? (rasterImagePattern.test(link.target) ? "image" : "embed") : "link",
      link,
      label: link.label,
    });
  }

  for (const match of text.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
    if (match.index === undefined || !match[2]) {
      continue;
    }
    const prefixLength = match[1]?.length ?? 0;
    const from = lineFrom + match.index + prefixLength;
    add({ from, to: from + match[0].length - prefixLength, kind: "tag", label: match[2] });
  }

  return tokens.sort((left, right) => left.from - right.from || left.to - right.to);
}

function revealSource(view: EditorView, from: number, event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  view.dispatch({
    selection: { anchor: Math.min(from, view.state.doc.length) },
    scrollIntoView: true,
  });
  view.focus();
}

function isActivationEvent(event: MouseEvent | KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

class LinkWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly link: LivePreviewLink,
    readonly options: LivePreviewOptions,
  ) {
    super();
  }

  eq(other: LinkWidget): boolean {
    return (
      this.from === other.from &&
      this.link.syntax === other.link.syntax &&
      this.link.target === other.link.target &&
      this.link.subpath === other.link.subpath &&
      this.link.label === other.link.label &&
      this.link.external === other.link.external
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const link = document.createElement("span");
    link.className = this.link.external
      ? "tl-live-link tl-live-link-external"
      : "tl-live-link tl-live-link-internal";
    link.textContent = this.link.label;
    link.tabIndex = 0;
    link.setAttribute("role", "link");
    link.ariaLabel = `${this.link.label}, ${this.link.external ? "external" : "internal"} link`;
    link.title = this.link.external
      ? "External opening is disabled. Click to edit source."
      : "Click to edit source. Modifier-click to open.";
    const activate = (event: MouseEvent | KeyboardEvent): void => {
      if (isActivationEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
        this.options.activateLink(this.link);
      } else {
        revealSource(view, this.from, event);
      }
    };
    link.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        activate(event);
      }
    });
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        activate(event);
      }
    });
    return link;
  }
}

class EmbedWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly link: LivePreviewLink,
    readonly options: LivePreviewOptions,
  ) {
    super();
  }

  eq(other: EmbedWidget): boolean {
    return (
      this.from === other.from &&
      this.link.syntax === other.link.syntax &&
      this.link.target === other.link.target &&
      this.link.subpath === other.link.subpath &&
      this.link.label === other.link.label
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("span");
    card.className = "tl-live-embed";
    card.tabIndex = 0;
    card.setAttribute("role", "group");
    card.ariaLabel = `Embedded note ${this.link.label}`;
    const mark = document.createElement("span");
    mark.className = "tl-live-embed-mark";
    mark.ariaHidden = "true";
    mark.textContent = "◇";
    const label = document.createElement("span");
    label.textContent = this.link.label;
    card.append(mark, label);
    const activate = (event: MouseEvent | KeyboardEvent): void => {
      if (isActivationEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
        this.options.activateLink(this.link);
      } else {
        revealSource(view, this.from, event);
      }
    };
    card.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        activate(event);
      }
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        activate(event);
      }
    });
    return card;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly link: LivePreviewLink,
    readonly options: LivePreviewOptions,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      this.from === other.from &&
      this.link.target === other.link.target &&
      this.link.label === other.link.label &&
      this.options.sourceNotePath() === other.options.sourceNotePath() &&
      this.options.expectedVaultId() === other.options.expectedVaultId()
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement("span");
    frame.className = "tl-live-image";
    frame.tabIndex = 0;
    frame.setAttribute("role", "img");
    frame.ariaLabel = this.link.label || this.link.target;
    frame.ariaBusy = "true";
    const placeholder = document.createElement("span");
    placeholder.className = "tl-live-image-placeholder";
    placeholder.textContent = `Image: ${this.link.label || this.link.target}`;
    frame.append(placeholder);
    frame.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        revealSource(view, this.from, event);
      }
    });
    frame.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        revealSource(view, this.from, event);
      }
    });

    const sourceNotePath = this.options.sourceNotePath();
    const expectedVaultId = this.options.expectedVaultId();
    if (!sourceNotePath || !expectedVaultId || this.link.external) {
      frame.ariaBusy = "false";
      frame.dataset.status = "unavailable";
      frame.dataset.reason = !sourceNotePath
        ? "missing-source-note"
        : !expectedVaultId
          ? "missing-vault"
          : "external";
      return frame;
    }
    void this.options
      .loadImage(sourceNotePath, this.link.target, expectedVaultId)
      .then((response) => {
        if (!frame.isConnected) {
          return;
        }
        frame.ariaBusy = "false";
        if (
          response.status !== "ready" ||
          response.vaultId !== expectedVaultId ||
          this.options.sourceNotePath() !== sourceNotePath ||
          this.options.expectedVaultId() !== expectedVaultId
        ) {
          frame.dataset.status = "unavailable";
          frame.dataset.reason =
            response.status !== "ready"
              ? response.status
              : response.vaultId !== expectedVaultId
                ? "vault-response-mismatch"
                : this.options.sourceNotePath() !== sourceNotePath
                  ? "source-note-changed"
                  : "active-vault-changed";
          if (response.status === "unavailable") {
            frame.title = response.message;
          }
          return;
        }
        const image = document.createElement("img");
        image.className = "tl-live-image-content";
        image.alt = this.link.label;
        image.decoding = "async";
        image.src = `data:${response.mimeType};base64,${response.base64}`;
        image.addEventListener("error", () => {
          if (frame.contains(image)) {
            frame.dataset.status = "unavailable";
            frame.dataset.reason = "decode-failed";
            image.replaceWith(placeholder);
          }
        });
        frame.dataset.status = "ready";
        frame.replaceChildren(image);
        view.requestMeasure();
      })
      .catch(() => {
        if (frame.isConnected) {
          frame.ariaBusy = "false";
          frame.dataset.status = "unavailable";
          frame.dataset.reason = "load-failed";
        }
      });
    return frame;
  }
}

class CalloutWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly label: string,
  ) {
    super();
  }

  eq(other: CalloutWidget): boolean {
    return this.from === other.from && this.label === other.label;
  }

  toDOM(view: EditorView): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "tl-live-callout";
    badge.textContent = this.label;
    badge.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        revealSource(view, this.from, event);
      }
    });
    return badge;
  }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "tl-live-bullet";
    bullet.ariaHidden = "true";
    bullet.textContent = "•";
    return bullet;
  }

  eq(): boolean {
    return true;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly checked: boolean,
  ) {
    super();
  }

  eq(other: TaskWidget): boolean {
    return this.from === other.from && this.to === other.to && this.checked === other.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = document.createElement("input");
    checkbox.className = "tl-live-task";
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.disabled = view.state.readOnly;
    checkbox.ariaLabel = this.checked ? "Completed task" : "Open task";
    checkbox.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.readOnly) {
        checkbox.checked = this.checked;
        return;
      }
      const current = view.state.doc.sliceString(this.from, this.to);
      if (!/^\[[ xX]\]$/u.test(current)) {
        checkbox.checked = this.checked;
        return;
      }
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: current[1]?.toLocaleLowerCase("en-US") === "x" ? "[ ]" : "[x]",
        },
      });
      view.focus();
    });
    return checkbox;
  }
}

function activeLineRanges(view: EditorView): SourceRange[] {
  return view.state.selection.ranges.map((selection) => ({
    from: view.state.doc.lineAt(selection.from).from,
    to: view.state.doc.lineAt(selection.to).to,
  }));
}

function sameInactiveLine(
  view: EditorView,
  range: SourceRange,
  active: readonly SourceRange[],
): boolean {
  return (
    view.state.doc.lineAt(range.from).number ===
      view.state.doc.lineAt(Math.max(range.from, range.to - 1)).number &&
    !intersectsAny({ from: range.from, to: Math.max(range.from + 1, range.to) }, active)
  );
}

function visibleLines(view: EditorView): { from: number; to: number; text: string }[] {
  const seen = new Set<number>();
  const lines: { from: number; to: number; text: string }[] = [];
  for (const range of view.visibleRanges) {
    let line = view.state.doc.lineAt(range.from);
    while (true) {
      if (!seen.has(line.number)) {
        seen.add(line.number);
        lines.push({ from: line.from, to: line.to, text: line.text });
      }
      if (line.to >= range.to || line.number >= view.state.doc.lines) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  }
  return lines;
}

function buildDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const active = activeLineRanges(view);
  const protectedRanges: SourceRange[] = [];
  const replacedRanges: SourceRange[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const addLineClass = (position: number, className: string): void => {
    const line = view.state.doc.lineAt(Math.min(position, view.state.doc.length));
    const classes = lineClasses.get(line.from) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(line.from, classes);
  };
  const addNodeLines = (from: number, to: number, className: string): void => {
    let line = view.state.doc.lineAt(from);
    const endLine = view.state.doc.lineAt(Math.max(from, to - 1)).number;
    while (line.number <= endLine) {
      addLineClass(line.from, className);
      if (line.number === endLine) {
        break;
      }
      line = view.state.doc.line(line.number + 1);
    }
  };

  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        if (["InlineCode", "FencedCode", "CodeText", "HTMLBlock", "HTMLTag"].includes(node.name)) {
          protectedRanges.push({ from: node.from, to: node.to });
        }
      },
    });
  }

  for (const line of visibleLines(view)) {
    const lineActive = intersectsAny(
      { from: line.from, to: Math.max(line.from + 1, line.to) },
      active,
    );
    const tokens = parseLivePreviewLine(line.text, line.from, protectedRanges);
    for (const token of tokens) {
      if (token.kind === "tag") {
        ranges.push(
          Decoration.mark({
            class: "tl-live-tag",
            attributes: { "data-tl-source-from": String(token.from) },
          }).range(token.from, token.to),
        );
        continue;
      }
      if (lineActive) {
        continue;
      }
      let widget: WidgetType;
      if (token.kind === "callout") {
        widget = new CalloutWidget(token.from, token.label);
        addLineClass(token.from, "tl-live-callout-line");
      } else if (token.kind === "image" && token.link) {
        widget = new ImageWidget(token.from, token.link, options);
      } else if (token.kind === "embed" && token.link) {
        widget = new EmbedWidget(token.from, token.link, options);
      } else if (token.link) {
        widget = new LinkWidget(token.from, token.link, options);
      } else {
        continue;
      }
      ranges.push(Decoration.replace({ widget }).range(token.from, token.to));
      replacedRanges.push(token);
    }
  }

  for (const visible of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from: visible.from,
      to: visible.to,
      enter(node) {
        const nodeRange = { from: node.from, to: node.to };
        const replaced = intersectsAny(nodeRange, replacedRanges);
        const inactive = sameInactiveLine(view, nodeRange, active);
        const mark = (className: string): void => {
          if (!replaced && node.from < node.to) {
            ranges.push(
              Decoration.mark({
                class: className,
                attributes: { "data-tl-source-from": String(node.from) },
              }).range(node.from, node.to),
            );
          }
        };
        const hide = (from = node.from, to = node.to): void => {
          if (!replaced && inactive && from < to) {
            ranges.push(Decoration.replace({}).range(from, to));
          }
        };

        const heading = /^ATXHeading([1-6])$/u.exec(node.name);
        if (heading?.[1]) {
          addLineClass(node.from, `tl-live-heading tl-live-heading-${heading[1]}`);
          return;
        }
        switch (node.name) {
          case "HeaderMark": {
            const line = view.state.doc.lineAt(node.from);
            const following = view.state.doc.sliceString(node.to, Math.min(line.to, node.to + 1));
            hide(node.from, following === " " ? node.to + 1 : node.to);
            break;
          }
          case "StrongEmphasis":
            mark("tl-live-strong");
            break;
          case "Emphasis":
            mark("tl-live-emphasis");
            break;
          case "Strikethrough":
            mark("tl-live-strikethrough");
            break;
          case "EmphasisMark":
          case "StrikethroughMark":
            hide();
            break;
          case "InlineCode":
            mark("tl-live-inline-code");
            break;
          case "CodeMark":
            if (node.to - node.from < 3) {
              hide();
            }
            break;
          case "Blockquote":
            addNodeLines(node.from, node.to, "tl-live-blockquote-line");
            break;
          case "QuoteMark": {
            const line = view.state.doc.lineAt(node.from);
            const following = view.state.doc.sliceString(node.to, Math.min(line.to, node.to + 1));
            hide(node.from, following === " " ? node.to + 1 : node.to);
            break;
          }
          case "ListItem":
            addLineClass(node.from, "tl-live-list-line");
            break;
          case "ListMark": {
            const marker = view.state.doc.sliceString(node.from, node.to);
            if (inactive && /^[*+-]$/u.test(marker) && !replaced) {
              ranges.push(
                Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to),
              );
            }
            break;
          }
          case "Task":
            addLineClass(node.from, "tl-live-task-line");
            break;
          case "TaskMarker": {
            if (inactive && !replaced) {
              const marker = view.state.doc.sliceString(node.from, node.to);
              ranges.push(
                Decoration.replace({
                  widget: new TaskWidget(node.from, node.to, /[xX]/u.test(marker)),
                }).range(node.from, node.to),
              );
            }
            break;
          }
          case "FencedCode":
            addNodeLines(node.from, node.to, "tl-live-code-line");
            break;
          case "Table":
            addNodeLines(node.from, node.to, "tl-live-table-line");
            break;
          case "HorizontalRule":
            addLineClass(node.from, "tl-live-rule-line");
            break;
        }
      },
    });
  }

  const firstLine = view.state.doc.line(1);
  if (firstLine.text.replace(/^\uFEFF/u, "").trim() === "---") {
    for (let lineNumber = 1; lineNumber <= Math.min(view.state.doc.lines, 256); lineNumber += 1) {
      const line = view.state.doc.line(lineNumber);
      addLineClass(line.from, "tl-live-frontmatter-line");
      if (lineNumber > 1 && ["---", "..."].includes(line.text.trim())) {
        break;
      }
    }
  }

  for (const [from, classes] of lineClasses) {
    ranges.push(
      Decoration.line({
        class: [...classes].sort().join(" "),
        attributes: { "data-tl-source-from": String(from) },
      }).range(from),
    );
  }
  return Decoration.set(ranges, true);
}

export function createLivePreviewExtension(options: LivePreviewOptions): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = buildDecorations(view, options);
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.selectionSet || update.viewportChanged) {
            this.decorations = buildDecorations(update.view, options);
          }
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.target instanceof Element)) {
          return false;
        }
        const source = event.target.closest<HTMLElement>("[data-tl-source-from]");
        const from = Number.parseInt(source?.dataset.tlSourceFrom ?? "", 10);
        if (!Number.isSafeInteger(from) || from < 0) {
          return false;
        }
        revealSource(view, from, event);
        return true;
      },
    }),
  ];
}
