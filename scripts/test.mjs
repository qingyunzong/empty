import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testDir = join(root, "test");
const tests = (await readdir(testDir))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(testDir, name));

if (tests.length === 0) {
  console.log("No TypeScript tests found.");
  process.exit(0);
}

const buildDir = await mkdtemp(
  join(process.env.TMPDIR ?? tmpdir(), "dlks-de-0179-test-"),
);
const compile = spawnSync(
  "tsc",
  [
    "--ignoreConfig",
    join(root, "index.ts"),
    join(testDir, "node-shims.d.ts"),
    ...tests,
    "--outDir",
    buildDir,
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--strict",
    "--skipLibCheck",
  ],
  { encoding: "utf8" },
);

if (compile.status !== 0) {
  process.stderr.write(compile.stdout ?? "");
  process.stderr.write(compile.stderr ?? "");
  process.exit(compile.status ?? 1);
}

await writeFile(
  join(buildDir, "package.json"),
  JSON.stringify({ type: "module" }),
  "utf8",
);
const compiledTests = (await readdir(join(buildDir, "test")))
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => join(buildDir, "test", name));
const run = spawnSync(
  process.execPath,
  ["--test", ...compiledTests],
  { stdio: "inherit" },
);
process.exit(run.status ?? 1);
