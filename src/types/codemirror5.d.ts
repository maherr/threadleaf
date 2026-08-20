declare module "codemirror5" {
  interface LegacyModeSpec {
    name?: string;
    [key: string]: unknown;
  }

  interface LegacyCodeMirrorStatic {
    defineMode(
      name: string,
      factory: (config: Record<string, unknown>, parserConfig?: LegacyModeSpec) => unknown,
    ): void;
    getMode(config: Record<string, unknown>, spec: string | LegacyModeSpec): unknown;
    version: string;
  }

  const CodeMirror: LegacyCodeMirrorStatic;
  export default CodeMirror;
}

declare module "codemirror5/mode/javascript/javascript";
