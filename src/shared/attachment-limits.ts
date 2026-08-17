/** Maximum attachment payload accepted by one renderer-to-kernel ingress operation. */
export const MAX_VAULT_ATTACHMENT_BYTES = 16 * 1024 * 1024;

/** Maximum number of external files accepted by one ordered note-insertion transaction. */
export const MAX_VAULT_ATTACHMENT_BATCH_ITEMS = 32;

/** Maximum combined payload accepted by one ordered note-insertion transaction. */
export const MAX_VAULT_ATTACHMENT_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * A selected external filename is display and authorization metadata only. Keep it to one
 * portable basename so no ingress adapter can smuggle path authority into the restore request.
 */
export function isSafeAttachmentDisplayFileName(fileName: string): boolean {
  const hasUnsafeCharacter = [...fileName].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "/" || character === "\\" || codePoint <= 0x1f || codePoint === 0x7f;
  });
  return (
    fileName.length > 0 &&
    new TextEncoder().encode(fileName).byteLength <= 255 &&
    fileName !== "." &&
    fileName !== ".." &&
    !hasUnsafeCharacter
  );
}
