#!/usr/bin/env node

import { runSameVaultCorpus } from "./same-vault-corpus";

void runSameVaultCorpus().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
