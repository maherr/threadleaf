const passiveAttachmentSuffix =
  /\.(?:bin|pdf|rtf|txt|csv|docx?|xlsx?|pptx?|zip|7z|tar|gz|mp3|m4a|flac|ogg|wav|mp4|m4v|mov|avi|mkv|webm)$/iu;

/** Formats rendered as bounded metadata cards instead of executable inline content. */
export function isPassiveAttachmentTarget(target: string): boolean {
  return passiveAttachmentSuffix.test(target);
}
