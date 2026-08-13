import type { VaultSearchResult } from "../shared/contracts";

export interface VaultSearchDisplayContext {
  label: string;
  line: number | undefined;
  text: string;
}

export function vaultSearchDisplayContext(
  result: Pick<VaultSearchResult, "contexts">,
): VaultSearchDisplayContext | null {
  const context = result.contexts[0];
  if (!context) {
    return null;
  }
  let label: string;
  if (context.kind === "content") {
    label = context.line ? `Line ${context.line}` : "Text";
  } else if (context.kind === "heading") {
    label = context.line ? `Heading ${context.line}` : "Heading";
  } else {
    label = `${context.kind[0]?.toLocaleUpperCase("en-US") ?? ""}${context.kind.slice(1)}`;
  }
  return { label, line: context.line, text: context.text };
}
