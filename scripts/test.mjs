import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outputDir = mkdtempSync(join(tmpdir(), "dlks-de-0051-test-"));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  const compileStatus = run("tsc", ["-p", "tsconfig.test.json", "--outDir", outputDir]);
  if (compileStatus !== 0) process.exitCode = compileStatus;
  else {
    const testDir = join(outputDir, "test");
    const testFiles = readdirSync(testDir)
      .filter((name) => name.endsWith(".test.js"))
      .sort()
      .map((name) => join(testDir, name));
    for (const file of testFiles) {
      const status = run(process.execPath, [file]);
      if (status !== 0) {
        process.exitCode = status;
        break;
      }
    }
  }
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
