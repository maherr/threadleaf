import DOMPurify, { type Config } from "dompurify";

const publishedContentTags = [
  "a",
  "article",
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
  "header",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "span",
  "strong",
  "summary",
  "sup",
  "sub",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const publishedContentSanitizeConfig = {
  ALLOWED_TAGS: publishedContentTags,
  ALLOWED_ATTR: [
    "alt",
    "aria-label",
    "class",
    "colspan",
    "decoding",
    "href",
    "id",
    "loading",
    "rel",
    "role",
    "rowspan",
    "src",
    "start",
    "scope",
    "title",
  ],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
} satisfies Config;

const standaloneStyles = `
:root {
  color-scheme: light dark;
  --page: #f6f3ed;
  --paper: #fffdf8;
  --ink: #1c2835;
  --muted: #64717d;
  --line: #c9d2d8;
  --accent: #0072b2;
  --accent-soft: #dceef8;
  --code: #edf1f3;
  --quote: #eef6f4;
  --warning: #9a5b00;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--page);
  line-height: 1.68;
}
.published-shell {
  width: min(860px, calc(100% - 32px));
  margin: 42px auto;
  padding: clamp(28px, 6vw, 68px);
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--paper);
  box-shadow: 0 24px 70px rgb(26 39 50 / 12%);
}
.published-masthead {
  margin-bottom: 42px;
  padding-bottom: 24px;
  border-bottom: 3px double var(--line);
}
.published-masthead p,
.published-footer,
.preview-note-embed-eyebrow,
.preview-note-embed-provenance {
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
.published-masthead h1 {
  margin: 5px 0 0;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(2rem, 7vw, 4rem);
  line-height: 1.04;
  overflow-wrap: anywhere;
}
.published-content { min-width: 0; }
.published-content :is(h1, h2, h3, h4, h5, h6) {
  margin: 1.75em 0 0.55em;
  line-height: 1.2;
  text-wrap: balance;
}
.published-content :is(h1, h2) { font-family: Georgia, "Times New Roman", serif; }
.published-content h1 { font-size: 2rem; }
.published-content h2 { font-size: 1.55rem; }
.published-content h3 { font-size: 1.2rem; }
.published-content p { margin: 0 0 1em; }
.published-content a { color: var(--accent); text-underline-offset: 0.18em; }
.published-content img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1.6rem auto;
  border-radius: 8px;
}
.published-content blockquote {
  margin: 1.5rem 0;
  padding: 0.7rem 1.15rem;
  border-left: 4px solid var(--accent);
  background: var(--quote);
}
.published-content code {
  padding: 0.12em 0.32em;
  border-radius: 4px;
  background: var(--code);
  font: 0.92em ui-monospace, SFMono-Regular, Consolas, monospace;
}
.published-content pre {
  max-width: 100%;
  overflow: auto;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--code);
}
.published-content pre code { padding: 0; background: transparent; }
.published-content table {
  width: 100%;
  margin: 1.5rem 0;
  border-collapse: collapse;
}
.published-content :is(th, td) {
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--line);
  text-align: left;
}
.published-content .align-center { text-align: center; }
.published-content .align-right { text-align: right; }
.published-content .preview-math-block {
  width: fit-content;
  max-width: 100%;
  margin: 1em auto;
  padding: 0.55em 0.85em;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
}
.published-content .math-fraction {
  display: inline-grid;
  grid-template-rows: auto auto;
  vertical-align: middle;
  text-align: center;
}
.published-content .math-numerator {
  padding: 0 0.18em 0.08em;
  border-bottom: 1px solid currentColor;
}
.published-content .math-denominator { padding: 0.08em 0.18em 0; }
.published-content .preview-footnotes {
  margin-top: 2em;
  padding-top: 1em;
  border-top: 2px solid var(--line);
  font-size: 0.9em;
}
.published-content .preview-footnote-backrefs { margin-left: 0.6em; }
.published-content .preview-footnote-backref { text-decoration: none; }
.vault-link {
  color: var(--muted);
  text-decoration: underline dotted;
  text-underline-offset: 0.2em;
  cursor: help;
}
.preview-note-embed {
  margin: 1.5rem 0;
  padding: 1rem 1.15rem;
  border: 1px solid var(--line);
  border-left: 4px solid var(--accent);
  border-radius: 8px;
  background: var(--accent-soft);
}
.preview-note-embed-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.45rem 0.8rem;
  margin-bottom: 0.85rem;
}
.preview-note-embed-identity { display: grid; }
.published-embed-source { font-weight: 700; overflow-wrap: anywhere; }
.preview-note-embed-provenance { margin-left: auto; }
.preview-note-embed-unavailable,
.preview-asset-placeholder {
  display: block;
  padding: 0.7rem 0.9rem;
  border: 1px dashed var(--warning);
  border-radius: 6px;
  color: var(--warning);
}
.published-footer {
  margin-top: 46px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #111820;
    --paper: #18232d;
    --ink: #eef4f7;
    --muted: #a8b6c0;
    --line: #3b4b57;
    --accent: #66b8e8;
    --accent-soft: #203846;
    --code: #111b23;
    --quote: #172d2a;
    --warning: #f0ad4e;
  }
  .published-shell { box-shadow: 0 24px 70px rgb(0 0 0 / 32%); }
}
@media (max-width: 560px) {
  .published-shell {
    width: 100%;
    margin: 0;
    padding: 24px 18px 36px;
    border-width: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .published-masthead { margin-bottom: 28px; }
}
@media print {
  :root { --page: #fff; --paper: #fff; --ink: #111; --muted: #555; --line: #aaa; }
  .published-shell { width: 100%; margin: 0; padding: 0; border: 0; box-shadow: none; }
  .published-footer { break-before: avoid; }
  .published-content a { color: inherit; }
}
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeExternalUrl(value: string): string | null {
  if (/\s/u.test(value)) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function replaceWithTextSpan(element: Element, className: string, title?: string): void {
  const replacement = element.ownerDocument.createElement("span");
  replacement.className = className;
  replacement.textContent = element.textContent;
  if (title) {
    replacement.title = title;
  }
  element.replaceWith(replacement);
}

function preparePublishedContent(source: HTMLElement): string {
  const root = source.cloneNode(true);
  if (!(root instanceof HTMLElement)) {
    throw new Error("The rendered note could not be cloned for export.");
  }

  for (const action of root.querySelectorAll(".preview-source-action")) {
    action.remove();
  }
  for (const wrapper of [...root.querySelectorAll<HTMLElement>(".preview-block")]) {
    wrapper.replaceWith(...wrapper.childNodes);
  }
  for (const action of root.querySelectorAll(".preview-note-embed-open")) {
    const replacement = action.ownerDocument.createElement("span");
    replacement.className = "published-embed-source";
    replacement.textContent = "Included content";
    action.replaceWith(replacement);
  }
  for (const provenance of root.querySelectorAll(".preview-note-embed-provenance")) {
    provenance.remove();
  }
  for (const embed of root.querySelectorAll<HTMLElement>(".preview-note-embed")) {
    embed.ariaLabel = "Embedded note";
  }
  for (const anchor of [...root.querySelectorAll<HTMLAnchorElement>("a")]) {
    if (anchor.dataset.threadleafRawLink === "true") {
      replaceWithTextSpan(
        anchor,
        "vault-link",
        "Raw HTML links are not active in this single-note export.",
      );
      continue;
    }
    if (
      anchor.dataset.threadleafFootnoteRef ||
      anchor.classList.contains("preview-footnote-backref")
    ) {
      continue;
    }
    if (anchor.dataset.threadleafLink === "external") {
      const safeUrl = safeExternalUrl(anchor.dataset.threadleafExternalUrl ?? "");
      if (safeUrl) {
        anchor.href = safeUrl;
        anchor.rel = "noreferrer noopener";
        anchor.title = "External link";
        continue;
      }
    }
    replaceWithTextSpan(
      anchor,
      "vault-link",
      "Internal vault link is not active in this single-note export.",
    );
  }
  for (const image of [...root.querySelectorAll<HTMLImageElement>("img")]) {
    if (!/^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/]+=*$/iu.test(image.src)) {
      replaceWithTextSpan(image, "preview-asset-placeholder", "Image was not embedded.");
    }
  }
  for (const button of root.querySelectorAll("button")) {
    replaceWithTextSpan(button, "published-control-placeholder");
  }
  for (const element of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    for (const attribute of [...element.attributes]) {
      if (
        attribute.name.startsWith("data-") ||
        attribute.name.startsWith("on") ||
        (attribute.name === "id" && !attribute.value.startsWith("threadleaf-footnote-")) ||
        attribute.name === "style" ||
        attribute.name === "contenteditable" ||
        attribute.name === "aria-busy"
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return DOMPurify.sanitize(root.innerHTML, publishedContentSanitizeConfig);
}

export function createStandalonePublishedNoteHtml(
  title: string,
  renderedNote: HTMLElement,
): string {
  const safeTitle = escapeHtml(title.trim() || "Untitled note");
  const content = preparePublishedContent(renderedNote);
  return `<!doctype html>
<html lang="en" data-threadleaf-publish-version="1">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Threadleaf">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <title>${safeTitle}</title>
  <style>${standaloneStyles}</style>
</head>
<body>
  <main class="published-shell">
    <header class="published-masthead">
      <p>Standalone Markdown export</p>
      <h1>${safeTitle}</h1>
    </header>
    <article class="published-content">${content}</article>
    <footer class="published-footer">Exported with Threadleaf</footer>
  </main>
</body>
</html>
`;
}
