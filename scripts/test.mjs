import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([
  ".git",
  ".test-build",
  "build",
  "dist",
  "node_modules",
]);

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: process.env,
      stdio: "inherit",
      ...options,
    });
    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (signal !== null) {
        rejectRun(new Error(`command ended with signal ${signal}`));
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}

async function findTests(directory) {
  const tests = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return tests;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) {
      continue;
    }
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...(await findTests(fullPath)));
      continue;
    }
    if (/\.test\.(?:ts|js|mjs|cjs)$/.test(entry.name)) {
      tests.push(fullPath);
    }
  }
  return tests;
}

function resolveTsc() {
  const local = join(workspace, "node_modules", ".bin", "tsc");
  if (existsSync(local)) {
    return local;
  }
  return "tsc";
}

const tests = await findTests(workspace);
if (tests.length === 0) {
  console.error("No *.test.ts/js files found.");
  process.exit(1);
}

const supportsTypescript = Boolean(process.features?.typescript);

if (supportsTypescript) {
  let code = 0;
  for (const testFile of tests) {
    code =
      (await run(
        process.execPath,
        ["--experimental-strip-types", testFile],
        { cwd: workspace },
      )) || code;
  }
  process.exit(code);
}

const tempRoot = process.env.TMPDIR || tmpdir();
const buildRoot = await mkdtemp(join(tempRoot, "dlks-de-0028-"));
const outDir = join(buildRoot, "out");
const compilerOptions = {
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  strict: true,
  skipLibCheck: true,
  outDir,
  rootDir: workspace,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  declaration: false,
  sourceMap: false,
  noEmit: false,
  types: [],
};
const typescriptTests = tests.filter((path) => path.endsWith(".ts"));
const runtimeTests = tests.filter((path) => !path.endsWith(".ts"));
const tsconfig = {
  compilerOptions,
  include: [
    join(workspace, "index.ts"),
    join(workspace, "src", "**", "*.ts"),
    join(workspace, "types", "**", "*.d.ts"),
    ...typescriptTests,
  ],
};
const tsconfigPath = join(buildRoot, "tsconfig.json");
await writeFile(
  tsconfigPath,
  `${JSON.stringify(tsconfig, null, 2)}\n`,
  "utf8",
);

let code = await run(resolveTsc(), ["-p", tsconfigPath]);
if (code !== 0) {
  await rm(buildRoot, { recursive: true, force: true });
  process.exit(code);
}

await mkdir(join(outDir, "test"), { recursive: true });
await writeFile(join(outDir, "package.json"), '{"type":"module"}\n', "utf8");

const compiledTests = typescriptTests.map((path) => {
  const relativePath = relative(workspace, path).replace(/\.ts$/, ".js");
  return join(outDir, relativePath);
});
let testExitCode = 0;
for (const testFile of compiledTests) {
  testExitCode =
    (await run(process.execPath, [testFile], { cwd: outDir })) ||
    testExitCode;
}
for (const testFile of runtimeTests) {
  testExitCode =
    (await run(process.execPath, [testFile], { cwd: workspace })) ||
    testExitCode;
}
if (process.env.KEEP_TEST_BUILD) {
  console.error(`test build kept at ${buildRoot}`);
} else {
  await rm(buildRoot, { recursive: true, force: true });
}
process.exit(testExitCode);
