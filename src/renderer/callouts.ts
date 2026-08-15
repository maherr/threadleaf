export type CalloutFold = "expanded" | "collapsed" | null;

export interface CalloutHeader {
  type: string;
  fold: CalloutFold;
}

export const standardCalloutTypes = [
  "note",
  "abstract",
  "info",
  "todo",
  "tip",
  "success",
  "question",
  "warning",
  "failure",
  "danger",
  "bug",
  "example",
  "quote",
] as const;

export type StandardCalloutType = (typeof standardCalloutTypes)[number];

const calloutAliases: Readonly<Record<string, StandardCalloutType>> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

const sourceHeaderPattern =
  /^(?: {0,3}>[\t ]+)+\[!([a-zA-Z0-9_-]+)\]([+-]?)(?=$|[\t ])(?:[\t ].*)?$/u;
const renderedHeaderPattern = /^\[!([a-zA-Z0-9_-]+)\]([+-]?)(?=$|[\t \r\n])/u;

function foldFromMarker(marker: string): CalloutFold {
  if (marker === "+") return "expanded";
  if (marker === "-") return "collapsed";
  return null;
}

/**
 * Recognize a callout only when its marker occupies the first quoted source
 * line. In particular, `>[!note]` remains an ordinary blockquote so users do
 * not lose source text for a malformed marker.
 */
export function parseCalloutSourceLine(line: string): CalloutHeader | null {
  const match = sourceHeaderPattern.exec(line.replace(/\r$/u, ""));
  if (!match?.[1]) return null;
  return {
    type: match[1].toLocaleLowerCase("en-US"),
    fold: foldFromMarker(match[2] ?? ""),
  };
}

export function calloutDefaultTitle(type: string): string {
  return type
    .replaceAll(/[-_]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toLocaleUpperCase("en-US")}${part.slice(1)}`)
    .join(" ");
}

export function resolveCalloutStyle(type: string): StandardCalloutType {
  const normalized = type.toLocaleLowerCase("en-US");
  if ((standardCalloutTypes as readonly string[]).includes(normalized)) {
    return normalized as StandardCalloutType;
  }
  return calloutAliases[normalized] ?? "note";
}

interface RenderedHeader {
  header: CalloutHeader;
  text: Text;
  markerLength: number;
}

function firstTextNode(root: Node): Text | null {
  const document = root.ownerDocument;
  if (!document) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

function parseRenderedHeader(paragraph: HTMLElement): RenderedHeader | null {
  const text = firstTextNode(paragraph);
  if (!text) return null;
  const match = renderedHeaderPattern.exec(text.data);
  if (!match?.[1]) return null;
  return {
    header: {
      type: match[1].toLocaleLowerCase("en-US"),
      fold: foldFromMarker(match[2] ?? ""),
    },
    text,
    markerLength: match[0].length,
  };
}

function hasVisibleContent(fragment: DocumentFragment): boolean {
  return [...fragment.childNodes].some(
    (node) => node.nodeType !== Node.TEXT_NODE || /\S/u.test(node.textContent ?? ""),
  );
}

function splitFirstParagraph(
  paragraph: HTMLElement,
  marker: RenderedHeader,
): { title: DocumentFragment; body: DocumentFragment } {
  const document = paragraph.ownerDocument;
  const title = document.createDocumentFragment();
  const body = document.createDocumentFragment();
  marker.text.data = marker.text.data.slice(marker.markerLength).replace(/^[\t ]+/u, "");

  let inBody = false;
  for (const node of [...paragraph.childNodes]) {
    if (!inBody && node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const lineBreak = /\r?\n/u.exec(text.data);
      if (lineBreak?.index !== undefined) {
        const before = text.data.slice(0, lineBreak.index);
        const after = text.data.slice(lineBreak.index + lineBreak[0].length);
        if (before) title.append(document.createTextNode(before));
        if (after) body.append(document.createTextNode(after));
        text.remove();
        inBody = true;
        continue;
      }
    }
    if (!inBody && node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === "BR") {
      node.remove();
      inBody = true;
      continue;
    }
    (inBody ? body : title).append(node);
  }
  return { title, body };
}

function toggleCallout(callout: HTMLElement, title: HTMLElement): void {
  const collapsed = callout.classList.toggle("is-collapsed");
  title.setAttribute("aria-expanded", String(!collapsed));
}

function createCallout(
  document: Document,
  header: CalloutHeader,
  titleNodes: DocumentFragment,
  bodyNodes: DocumentFragment,
  remainingNodes: readonly Node[],
  sourceLine: string,
  renderToken: string,
): HTMLElement {
  const callout = document.createElement("div");
  callout.className = "callout";
  callout.dataset.callout = header.type;
  callout.dataset.calloutStyle = resolveCalloutStyle(header.type);
  callout.dataset.sourceLine = sourceLine;
  callout.setAttribute("data-threadleaf-render-token", renderToken);

  const title = document.createElement("div");
  title.className = "callout-title";
  const icon = document.createElement("div");
  icon.className = "callout-icon";
  icon.setAttribute("aria-hidden", "true");
  const titleInner = document.createElement("div");
  titleInner.className = "callout-title-inner";
  if (hasVisibleContent(titleNodes)) {
    titleInner.append(titleNodes);
  } else {
    titleInner.textContent = calloutDefaultTitle(header.type);
  }
  title.append(icon, titleInner);

  const content = document.createElement("div");
  content.className = "callout-content";
  if (hasVisibleContent(bodyNodes)) {
    const firstBodyParagraph = document.createElement("p");
    firstBodyParagraph.append(bodyNodes);
    content.append(firstBodyParagraph);
  }
  for (const node of remainingNodes) {
    content.append(node);
  }

  if (header.fold) {
    callout.classList.add("is-collapsible");
    if (header.fold === "collapsed") {
      callout.classList.add("is-collapsed");
    }
    const fold = document.createElement("div");
    fold.className = "callout-fold";
    fold.setAttribute("aria-hidden", "true");
    title.append(fold);
    title.tabIndex = 0;
    title.setAttribute("role", "button");
    title.setAttribute("aria-expanded", String(header.fold !== "collapsed"));
    title.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleCallout(callout, title);
    });
    title.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      toggleCallout(callout, title);
    });
  }

  callout.append(title, content);
  return callout;
}

/**
 * Upgrade Markdown-it's generated blockquote tree after sanitization. The
 * source line and private render token keep raw author HTML from acquiring a
 * native callout shape or a source-navigation capability.
 */
export function upgradeRenderedCallouts(
  fragment: DocumentFragment,
  source: string,
  renderToken: string,
): void {
  const sourceLines = source.split("\n");
  const blockquotes = [...fragment.querySelectorAll<HTMLElement>("blockquote")]
    .filter((blockquote) => blockquote.getAttribute("data-threadleaf-render-token") === renderToken)
    .reverse();

  for (const blockquote of blockquotes) {
    const sourceLine = Number.parseInt(blockquote.dataset.sourceLine ?? "", 10);
    const sourceHeader =
      Number.isSafeInteger(sourceLine) && sourceLine > 0
        ? parseCalloutSourceLine(sourceLines[sourceLine - 1] ?? "")
        : null;
    const paragraph = blockquote.firstElementChild;
    if (!sourceHeader || !(paragraph instanceof HTMLElement) || paragraph.tagName !== "P") {
      continue;
    }
    const renderedHeader = parseRenderedHeader(paragraph);
    if (
      !renderedHeader ||
      renderedHeader.header.type !== sourceHeader.type ||
      renderedHeader.header.fold !== sourceHeader.fold
    ) {
      continue;
    }
    const remainingNodes = [...blockquote.childNodes].filter((node) => node !== paragraph);
    const { title, body } = splitFirstParagraph(paragraph, renderedHeader);
    const callout = createCallout(
      blockquote.ownerDocument,
      sourceHeader,
      title,
      body,
      remainingNodes,
      String(sourceLine),
      renderToken,
    );
    blockquote.replaceWith(callout);
  }
}
