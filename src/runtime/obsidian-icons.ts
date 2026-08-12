import { type IconNode, icons as lucideIcons } from "lucide";

const iconNodes = lucideIcons as unknown as Record<string, IconNode>;

function iconKey(iconId: string): string {
  const normalized = iconId.replace(/^lucide-/, "");
  const camelCase = normalized.replace(/(^|[\s_-]+)(\w)/g, (_match, _prefix, letter: string) =>
    letter.toUpperCase(),
  );
  return camelCase.charAt(0).toUpperCase() + camelCase.slice(1);
}

function appendIconNode(document: Document, parent: SVGElement, iconNode: IconNode): void {
  for (const [tag, attributes] of iconNode) {
    const child = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value !== undefined) {
        child.setAttribute(name, String(value));
      }
    }
    parent.append(child);
  }
}

export function createCompatibleIcon(
  document: Document,
  iconId: string,
  customContent: string | null,
): SVGSVGElement | null {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("svg-icon", "lucide");
  svg.dataset.icon = iconId;
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("height", "18");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");

  if (customContent !== null) {
    svg.innerHTML = customContent;
    return svg;
  }

  const iconNode = iconNodes[iconKey(iconId)];
  if (!iconNode) {
    return null;
  }
  appendIconNode(document, svg, iconNode);
  return svg;
}
