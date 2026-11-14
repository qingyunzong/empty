import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dlks-test-"));
const ignored = new Set([".git", "node_modules", "dist", "build"]);

function copyTree(source, target) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (ignored.has(entry.name)) {
      continue;
    }
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else if (
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".js") ||
      entry.name.endsWith(".mjs") ||
      entry.name === "package.json"
    ) {
      let contents = readFileSync(from, "utf8");
      if (entry.name.endsWith(".ts")) {
        // The emitted build is JavaScript; source stays idiomatic TS.
        contents = contents.replace(/(\.ts)(["'])/g, ".js$2");
      }
      writeFileSync(to, contents);
    }
  }
}

function collectTests(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(path));
    } else if (entry.name.endsWith(".test.js") || entry.name.endsWith(".test.mjs")) {
      files.push(path);
    }
  }
  return files;
}

let status = 0;
try {
  copyTree(root, build);
  // Keep the source imports intact in the workspace, but compile the copy.
  writeFileSync(
    join(build, "tsconfig.prepared.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          outDir: "dist",
          rootDir: ".",
          skipLibCheck: true,
        },
        include: ["**/*.ts"],
        exclude: ["dist", "build", "node_modules"],
      },
      null,
      2,
    ),
  );

  const compiler = spawnSync(
    process.env.TSC ?? "tsc",
    ["-p", join(build, "tsconfig.prepared.json")],
    { stdio: "inherit", cwd: build },
  );
  if (compiler.error) {
    throw compiler.error;
  }
  if (compiler.status !== 0) {
    status = compiler.status ?? 1;
  } else {
    const dist = join(build, "dist");
    const tests = collectTests(dist);
    if (tests.length === 0) {
      console.error("No *.test.js files were found after compilation.");
      status = 1;
    } else {
      const runner = spawnSync(process.execPath, ["--test", ...tests], {
        stdio: "inherit",
        cwd: build,
      });
      status = runner.status ?? 1;
    }
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}
process.exit(status);
