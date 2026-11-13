import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dlks-de-0025-test-"));

function cleanup() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

function run(command, args, stdio = "inherit") {
  return spawnSync(command, args, { cwd: root, stdio });
}

function testFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...testFiles(full));
    else if (entry.name.endsWith(".test.js")) files.push(full);
  }
  return files;
}

// A compiler may exist without Node's optional TypeScript support. Probe it
// before choosing between direct TypeScript execution and a compiled run.
const probe = path.join(tempRoot, "probe.ts");
fs.writeFileSync(
  probe,
  "const value: number = 42;\nif (value !== 42) process.exit(1);\n",
);
const stripProbe = run(
  process.execPath,
  ["--experimental-strip-types", probe],
  "ignore",
);

if (stripProbe.status === 0) {
  const result = run(process.execPath, [
    "--experimental-strip-types",
    "--test",
  ]);
  process.exit(result.status ?? 1);
}

const buildDirectory = path.join(tempRoot, "build");
const compile = run("tsc", [
  "-p",
  "tsconfig.test.json",
  "--outDir",
  buildDirectory,
]);
if (compile.error || compile.status !== 0) {
  console.error(
    "\nThis Node build has no TypeScript support and the fallback tsc build failed.",
  );
  process.exit(compile.status ?? 1);
}

const files = testFiles(buildDirectory);
if (files.length === 0) {
  console.error("No compiled test files were found.");
  process.exit(1);
}
const result = run(process.execPath, ["--test", ...files]);
process.exit(result.status ?? 1);
