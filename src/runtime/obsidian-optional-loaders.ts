function unsupportedLoader(name: string): Promise<never> {
  return Promise.reject(
    new Error(`Obsidian optional loader ${name} is unsupported in Threadleaf's local renderer.`),
  );
}

export function loadMathJax(): Promise<void> {
  return unsupportedLoader("MathJax");
}

export function loadMermaid(): Promise<unknown> {
  return unsupportedLoader("Mermaid");
}

export function loadPdfJs(): Promise<unknown> {
  return unsupportedLoader("PDF.js");
}

export function loadPrism(): Promise<unknown> {
  return unsupportedLoader("Prism");
}
