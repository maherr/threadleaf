export async function run(context, input) {
  const note = await context.vault.readText({ vaultId: context.vaultId, relativePath: input.path });
  return context.vault.writeText({
    vaultId: context.vaultId,
    relativePath: input.outputPath,
    content: `# Signed summary\n\n${note.content.split("\\n")[0] ?? "(empty note)"}\n`,
    expectedRevision: null,
  });
}
