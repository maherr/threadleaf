import * as codeMirrorState from "@codemirror/state";
import * as codeMirrorView from "@codemirror/view";
import type { MarkdownFileInfo } from "./obsidian-workspace-compat";

export interface LivePreviewStateType {
  mousedown: boolean;
}

export interface EditorCompatibilityModuleTable {
  state: typeof codeMirrorState;
  view: typeof codeMirrorView;
}

export interface EditorCompatibilityFields {
  editorEditorField: codeMirrorState.StateField<codeMirrorView.EditorView>;
  editorInfoField: codeMirrorState.StateField<MarkdownFileInfo>;
  editorLivePreviewField: codeMirrorState.StateField<boolean>;
  editorViewField: codeMirrorState.StateField<MarkdownFileInfo>;
  livePreviewState: codeMirrorView.ViewPlugin<LivePreviewStateType, undefined>;
  setFieldValue<T>(
    field: codeMirrorState.StateField<T>,
    value: T,
  ): codeMirrorState.StateEffect<unknown>;
}

export function createEditorCompatibilityFields(
  modules: EditorCompatibilityModuleTable,
): EditorCompatibilityFields {
  const fieldValueEffect = modules.state.StateEffect.define<{
    field: codeMirrorState.StateField<unknown>;
    value: unknown;
  }>();

  const createField = <T>(initial: T): codeMirrorState.StateField<T> => {
    let field: codeMirrorState.StateField<T>;
    field = modules.state.StateField.define<T>({
      create: () => initial,
      update: (value, transaction) => {
        for (const effect of transaction.effects) {
          if (!effect.is(fieldValueEffect) || effect.value.field !== field) continue;
          value = effect.value.value as T;
        }
        return value;
      },
    });
    return field;
  };

  const editorEditorField = createField<codeMirrorView.EditorView>(
    null as unknown as codeMirrorView.EditorView,
  );
  const editorInfoField = createField<MarkdownFileInfo>(null as unknown as MarkdownFileInfo);
  const editorLivePreviewField = createField(false);
  const livePreviewState = modules.view.ViewPlugin.define<LivePreviewStateType>(() => ({
    mousedown: false,
  }));

  return {
    editorEditorField,
    editorInfoField,
    editorLivePreviewField,
    editorViewField: editorInfoField,
    livePreviewState,
    setFieldValue: (field, value) =>
      fieldValueEffect.of({
        field: field as codeMirrorState.StateField<unknown>,
        value,
      }),
  };
}

export const rendererEditorCompatibilityFields = createEditorCompatibilityFields({
  state: codeMirrorState,
  view: codeMirrorView,
});

export const editorEditorField = rendererEditorCompatibilityFields.editorEditorField;
export const editorInfoField = rendererEditorCompatibilityFields.editorInfoField;
export const editorLivePreviewField = rendererEditorCompatibilityFields.editorLivePreviewField;
export const editorViewField = rendererEditorCompatibilityFields.editorViewField;
export const livePreviewState = rendererEditorCompatibilityFields.livePreviewState;
