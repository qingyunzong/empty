import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();
const buildRoot = mkdtempSync(join(tmpdir(), "dataeng-0254-test-"));
const testFile = join(buildRoot, "out", "test", "range-edit.test.js");

try {
  const compile = spawnSync(
    process.env.TSC ?? "tsc",
    [
      "--noCheck",
      "--target",
      "ES2022",
      "--module",
      "commonjs",
      "--moduleResolution",
      "bundler",
      "--esModuleInterop",
      "--rootDir",
      projectRoot,
      "--outDir",
      join(buildRoot, "out"),
      "index.ts",
      "test/range-edit.test.ts",
    ],
    {
      cwd: projectRoot,
      stdio: "inherit",
    },
  );

  if (compile.status !== 0) {
    process.exitCode = compile.status ?? 1;
  } else {
    const run = spawnSync(process.execPath, [testFile], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    process.exitCode = run.status ?? 1;
  }
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}
