/** Applies the main-process appearance cascade to the renderer-owned style element. */
export function applyAppearanceCss(target: { textContent: string | null }, css: string): void {
  target.textContent = css;
}
