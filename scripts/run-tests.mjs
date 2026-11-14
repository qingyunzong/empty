import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dlks-tests-"));

function collectTests(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectTests(path));
    } else if (/\.test\.(?:js|mjs|cjs)$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

try {
  const compile = spawnSync(
    join(root, "node_modules", ".bin", "tsc"),
    [
      "-p",
      join(root, "tsconfig.test.json"),
      "--outDir",
      outDir,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const tscBin = existsSync(join(root, "node_modules", ".bin", "tsc"))
    ? join(root, "node_modules", ".bin", "tsc")
    : "tsc";
  const result =
    compile.error?.code === "ENOENT"
      ? spawnSync(tscBin, ["-p", join(root, "tsconfig.test.json"), "--outDir", outDir], {
          cwd: root,
          encoding: "utf8",
        })
      : compile;

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (!existsSync(join(outDir, "index.js"))) {
    process.stderr.write(result.stdout ?? "");
    process.exit(result.status ?? 1);
  }

  const tests = collectTests(outDir);
  const run = spawnSync(
    process.execPath,
    ["--test", ...process.argv.slice(2), ...tests],
    { cwd: root, stdio: "inherit" },
  );
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
