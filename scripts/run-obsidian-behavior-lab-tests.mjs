import { spawnSync } from "node:child_process";

const contributorProfile = process.env.THREADLEAF_CONTRIBUTOR_PLATFORM_TESTS === "1";

if (contributorProfile && process.platform !== "linux") {
  process.stdout.write(
    `Obsidian behavior lab tests: platform-unsupported on ${process.platform}; Linux authority remains required.\n`,
  );
  process.exit(0);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(
      `${command} ended without an exit status (${result.signal ?? "unknown signal"}).`,
    );
  }
  if (result.status !== 0) process.exit(result.status);
}

run(process.execPath, ["--test", "scripts/obsidian-behavior-lab/lab.test.mjs"]);
run("python3", ["-B", "scripts/obsidian-behavior-lab/sandbox-supervisor.test.py"]);
