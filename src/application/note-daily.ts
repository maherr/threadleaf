import moment, { type Moment } from "moment";
import type { VaultMutationPort } from "../kernel/ports";
import type { NoteCreateOutcome } from "../shared/contracts";
import type { VaultNoteWorkflowSettings } from "../shared/note-workflows";
import { createMarkdownNote } from "./note-creation";
import {
  dailyNotePath,
  expandNoteTemplate,
  loadNoteTemplate,
  type NoteTemplateReader,
  noteTemplateTitle,
} from "./note-template";

export interface DailyNoteVault extends VaultMutationPort, NoteTemplateReader {}

export interface DailyNoteResult {
  outcome: NoteCreateOutcome;
  path: string;
  templatePath: string | null;
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function openOrCreateDailyNote(
  vault: DailyNoteVault,
  settings: VaultNoteWorkflowSettings,
  now: Moment = moment(),
): Promise<DailyNoteResult> {
  const targetPath = dailyNotePath(settings.dailyNoteFolder, settings.dailyNoteDateFormat, now);
  try {
    const existing = await vault.readText(targetPath);
    return {
      path: targetPath,
      templatePath: null,
      outcome: {
        status: "exists",
        path: targetPath,
        currentRevision: existing.revision,
      },
    };
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  let content = "";
  if (settings.dailyNoteTemplate) {
    const template = await loadNoteTemplate(vault, settings.dailyNoteTemplate);
    content = expandNoteTemplate(template.content, {
      title: noteTemplateTitle(targetPath),
      now,
      dateFormat: settings.templateDateFormat,
      timeFormat: settings.templateTimeFormat,
    });
  }
  return {
    path: targetPath,
    templatePath: settings.dailyNoteTemplate,
    outcome: await createMarkdownNote(vault, targetPath, content),
  };
}
