#!/usr/bin/env node

import { runExcalidrawRoundtripCorpus } from "./excalidraw-roundtrip-corpus";
import { runSameVaultCorpus } from "./same-vault-corpus";

void (async () => {
  await runSameVaultCorpus();
  await runExcalidrawRoundtripCorpus();
})().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
