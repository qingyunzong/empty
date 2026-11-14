import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const out = mkdtempSync(
  path.join(process.env.TMPDIR || tmpdir(), "yaml-representation-graph-"),
);

execFileSync(
  process.env.TSC || "tsc",
  [
    "--noCheck",
    "--noEmit",
    "false",
    "--outDir",
    out,
    "--rewriteRelativeImportExtensions",
  ],
  { cwd: root, stdio: "inherit" },
);

const tests = [];
const visit = (directory) => {
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    const stat = statSync(full);
    if (stat.isDirectory()) visit(full);
    else if (/\.test\.(?:js|mjs)$/.test(name)) tests.push(full);
  }
};
visit(out);

if (tests.length === 0) {
  console.log("No compiled TypeScript tests found.");
  process.exit(0);
}

execFileSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=spec",
    ...tests.map((file) => path.relative(out, file)),
  ],
  {
    cwd: out,
    stdio: "inherit",
  },
);
