#!/usr/bin/env node

import { cliExitCodes, runCli } from "./command-line";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.exit(cliExitCodes.success);
  }
  throw error;
});

void runCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
}).then((exitCode) => {
  process.exitCode = exitCode;
});
