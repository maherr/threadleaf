import { isSafeAttachmentDisplayFileName } from "./attachment-limits";

const passiveAttachmentSuffix =
  /\.(?:bin|pdf|rtf|txt|csv|docx?|xlsx?|pptx?|zip|7z|tar|gz|mp3|m4a|flac|ogg|wav|mp4|m4v|mov|avi|mkv|webm)$/iu;
const rasterAttachmentSuffix = /\.(?:gif|jpe?g|png|webp)$/iu;

/** Formats rendered as bounded metadata cards instead of executable inline content. */
export function isPassiveAttachmentTarget(target: string): boolean {
  return passiveAttachmentSuffix.test(target);
}

/** Formats safe to create from bounded external bytes and reference from Markdown. */
export function isExternalAttachmentTarget(target: string): boolean {
  return passiveAttachmentSuffix.test(target) || rasterAttachmentSuffix.test(target);
}

/** One passive/raster vault filename, with no active document suffix or unsafe basename. */
export function isSafeExternalAttachmentTarget(target: string): boolean {
  const fileName = target.split("/").at(-1) ?? "";
  return isSafeAttachmentDisplayFileName(fileName) && isExternalAttachmentTarget(target);
}
