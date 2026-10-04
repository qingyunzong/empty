import { readdirSync, writeFileSync } from "node:fs";

// Test files are imported in-process (node:test auto-runs them) instead of
// spawning "node --test", whose child-process pipes do not deliver output
// in this sandboxed environment. TAP emitted on stdout is tee'd into a
// buffer and recorded to TEST-RESULTS.md.

const fence = String.fromCharCode(96, 96, 96);
const chunks = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, enc, cb) => {
  chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk, enc).toString());
  return origWrite(chunk, enc, cb);
};

const testFiles = readdirSync("dist/test")
  .filter((f) => f.endsWith(".test.js"))
  .sort();
for (const file of testFiles) {
  await import("../dist/test/" + file);
}

process.on("exit", (code) => {
  const output = chunks.join("");
  const sum = (re) => [...output.matchAll(re)].reduce((acc, m) => acc + Number(m[1]), 0);
  const pass = sum(/# pass (\d+)/g);
  const fail = sum(/# fail (\d+)/g);
  const report = [
    "# Test Results",
    "",
    "- Date: " + new Date().toISOString(),
    "- Node: " + process.version,
    "- Command: npm test (tsc + node scripts/run-tests.mjs)",
    "- Result: " + (code === 0 && fail === 0 ? "PASS" : "FAIL") +
      " (pass=" + pass + ", fail=" + fail + ")",
    "",
    "## Raw output",
    "",
    fence,
    output.trim(),
    fence,
    "",
  ].join("\n");
  writeFileSync("TEST-RESULTS.md", report);
  origWrite("\nRecorded: pass=" + pass + " fail=" + fail + " -> TEST-RESULTS.md\n");
});
