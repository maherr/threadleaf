import { createHash } from "node:crypto";
import {
  type PluginCapabilityFinding,
  type PluginCapabilityId,
  type PluginCapabilityReport,
  pluginCapabilityIds,
} from "../shared/plugins";

interface CapabilityRule {
  capability: PluginCapabilityId;
  evidence: string;
  pattern: RegExp;
}

const capabilityRules: readonly CapabilityRule[] = [
  {
    capability: "vault-read",
    evidence: "Obsidian vault read or lookup API",
    pattern:
      /\b(?:cachedRead|readBinary|getMarkdownFiles|getFiles|getAbstractFileByPath|getFirstLinkpathDest|getResourcePath)\s*\(|\.vault\s*\.\s*read\s*\(/u,
  },
  {
    capability: "vault-write",
    evidence: "Obsidian vault mutation API",
    pattern:
      /\b(?:createBinary|modifyBinary|processFrontMatter|trashFile)\s*\(|\.vault\s*\.\s*(?:create|modify|append|delete|rename|process)\s*\(/u,
  },
  {
    capability: "network",
    evidence: "Browser network API",
    pattern: /\b(?:fetch|requestUrl|XMLHttpRequest|WebSocket|EventSource)\s*(?:\.|\()/u,
  },
  {
    capability: "network",
    evidence: "Node network module",
    pattern:
      /(?:require|import)\s*\(\s*["'](?:node:)?(?:http|https|net|tls|dns)(?:\/promises)?["']\s*\)|\bfrom\s*["'](?:node:)?(?:http|https|net|tls|dns)(?:\/promises)?["']/u,
  },
  {
    capability: "filesystem",
    evidence: "Node filesystem module",
    pattern:
      /(?:require|import)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)|\bfrom\s*["'](?:node:)?fs(?:\/promises)?["']/u,
  },
  {
    capability: "subprocess",
    evidence: "Node child-process module",
    pattern:
      /(?:require|import)\s*\(\s*["'](?:node:)?child_process["']\s*\)|\bfrom\s*["'](?:node:)?child_process["']/u,
  },
  {
    capability: "host-environment",
    evidence: "Host process environment",
    pattern: /\bprocess\s*\.\s*(?:env|cwd|platform|arch|versions)\b/u,
  },
  {
    capability: "host-environment",
    evidence: "Host operating-system module",
    pattern: /(?:require|import)\s*\(\s*["'](?:node:)?os["']\s*\)|\bfrom\s*["'](?:node:)?os["']/u,
  },
  {
    capability: "clipboard",
    evidence: "Clipboard API",
    pattern: /\b(?:navigator\s*\.\s*)?clipboard\s*\.|\bclipboardData\b/u,
  },
  {
    capability: "external-navigation",
    evidence: "External navigation API",
    pattern:
      /\b(?:openExternal|openPath)\s*\(|\bwindow\s*\.\s*open\s*\(|\blocation\s*\.\s*(?:assign|replace)\s*\(/u,
  },
  {
    capability: "editor-extension",
    evidence: "Editor extension API",
    pattern:
      /\b(?:registerEditorExtension|EditorView|EditorState|StateField|StateEffect|ViewPlugin|Decoration)\b/u,
  },
  {
    capability: "workspace-ui",
    evidence: "Workspace contribution API",
    pattern:
      /\b(?:addCommand|addRibbonIcon|addStatusBarItem|addSettingTab|registerView|registerMarkdownPostProcessor|registerMarkdownCodeBlockProcessor)\s*\(/u,
  },
  {
    capability: "dynamic-code",
    evidence: "Runtime code evaluation",
    pattern: /(?:^|[^.$\w])eval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]/u,
  },
  {
    capability: "dynamic-code",
    evidence: "Dynamically selected module",
    pattern: /\b(?:require|import)\s*\(\s*(?!["'])/u,
  },
];

export function scanPluginCapabilities(bundleBytes: Uint8Array): PluginCapabilityReport {
  const bundleSource = new TextDecoder("utf-8", { fatal: true }).decode(bundleBytes);
  const evidenceByCapability = new Map<PluginCapabilityId, string[]>();
  for (const rule of capabilityRules) {
    if (!rule.pattern.test(bundleSource)) {
      continue;
    }
    const evidence = evidenceByCapability.get(rule.capability) ?? [];
    if (!evidence.includes(rule.evidence)) {
      evidence.push(rule.evidence);
    }
    evidenceByCapability.set(rule.capability, evidence);
  }
  const capabilities = pluginCapabilityIds.filter((capability) =>
    evidenceByCapability.has(capability),
  );
  const findings: PluginCapabilityFinding[] = capabilities.map((capability) => ({
    capability,
    evidence: evidenceByCapability.get(capability) ?? [],
  }));
  return {
    scannerVersion: 1,
    bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
    capabilities,
    findings,
    staticOnly: true,
  };
}
