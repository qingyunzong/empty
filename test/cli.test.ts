import { test } from "node:test";
import assert from "node:assert";
import { run } from "../src/cli";

// The sandbox forbids spawning child processes, so instead of exec'ing the
// CLI we invoke its entry point directly and capture console output.
function cli(args: string[]): { status: number; stdout: string; stderr: string } {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    return { status: run(args), stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test("witness output and exit code 0", () => {
  const r = cli(["a/*", "*/b"]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "WITNESS a/b");
});

test("empty path witness prints (empty)", () => {
  const r = cli(["**", "**"]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "WITNESS (empty)");
});

test("empty intersection exits 1", () => {
  const r = cli(["a", "b"]);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, "EMPTY");
});

test("excludes via -x and comma separation", () => {
  const r = cli(["a/**", "**", "-x", "a,a/*"]);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, "WITNESS a/a/a");
  const r2 = cli(["a/*", "*/b", "--exclude", "a/b"]);
  assert.strictEqual(r2.status, 1);
});

test("unknown on tiny budget exits 2", () => {
  const r = cli(["a", "**", "--budget", "0"]);
  assert.strictEqual(r.status, 2);
  assert.ok(r.stdout.startsWith("UNKNOWN:"));
});

test("invalid patterns and usage exit 3", () => {
  assert.strictEqual(cli(["a//b", "c"]).status, 3);
  assert.strictEqual(cli(["a**b", "c"]).status, 3);
  assert.strictEqual(cli(["a"]).status, 3);
  assert.strictEqual(cli(["a", "b", "--budget", "xyz"]).status, 3);
  const many = ["a", "b"];
  for (let i = 0; i < 11; i++) many.push("-x", `e${i}`);
  const r = cli(many);
  assert.strictEqual(r.status, 3);
  assert.ok(r.stderr.includes("too many exclude"));
});
