import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CliIO, run } from "../src/cli";

function makeIo(stdinText = "") {
  const io: CliIO & { out: string[]; err: string[] } = {
    out: [] as string[],
    err: [] as string[],
    writeOut(text: string) {
      this.out.push(text);
    },
    writeErr(text: string) {
      this.err.push(text);
    },
    readStdin: () => stdinText,
  };
  return io;
}

test("plan on the demo fixture prints the expected JSON plan", () => {
  const io = makeIo();
  const code = run(["node", "cli", "plan", "fixtures/demo.json"], io);
  assert.equal(code, 0, io.err.join(""));
  const plan = JSON.parse(io.out.join(""));
  assert.equal(plan.minimumSamples, 7);
  assert.deepEqual(plan.selectedSamples, ["s01", "s02", "s03", "s04", "s06", "s07", "s08"]);
  assert.equal(plan.verification.confirmed, true);
  assert.equal(plan.verification.optimalSolutionCount, 192);
  assert.equal(plan.equivalenceClasses.length, 1);
  assert.ok(typeof plan.elapsedMs === "number");
});

test("plan reads the problem from stdin when given '-'", () => {
  const input = JSON.stringify({
    samples: ["s1", "s2"],
    strategies: [
      { id: "A", outputs: [1, 1] },
      { id: "B", outputs: [1, 2] },
      { id: "C", outputs: [2, 1] },
    ],
  });
  const io = makeIo(input);
  const code = run(["node", "cli", "plan", "-"], io);
  assert.equal(code, 0, io.err.join(""));
  const plan = JSON.parse(io.out.join(""));
  assert.equal(plan.minimumSamples, 2);
  assert.deepEqual(plan.selectedSamples, ["s1", "s2"]);
  assert.deepEqual(plan.equivalenceClasses, []);
});

test("--no-verify skips the enumeration check", () => {
  const io = makeIo();
  const code = run(["node", "cli", "plan", "fixtures/demo.json", "--no-verify"], io);
  assert.equal(code, 0, io.err.join(""));
  const plan = JSON.parse(io.out.join(""));
  assert.match(plan.verification.method, /skipped/);
  assert.equal(plan.minimumSamples, 7);
});

test("invalid JSON and invalid problems exit 1 with a clear message", () => {
  const badJson = makeIo("{not json");
  assert.equal(run(["node", "cli", "plan", "-"], badJson), 1);
  assert.match(badJson.err.join(""), /not valid JSON/);

  const tooMany = makeIo(
    JSON.stringify({
      samples: ["s1"],
      strategies: Array.from({ length: 21 }, (_, i) => ({ id: `P${i}`, outputs: [i] })),
    })
  );
  assert.equal(run(["node", "cli", "plan", "-"], tooMany), 1);
  assert.match(tooMany.err.join(""), /invalid input: at most 20 strategies/);

  const missing = makeIo();
  assert.equal(run(["node", "cli", "plan", "fixtures/does-not-exist.json"], missing), 1);
  assert.match(missing.err.join(""), /cannot read input/);
});

test("usage errors exit 2 and --help exits 0", () => {
  assert.equal(run(["node", "cli"], makeIo()), 2);
  assert.equal(run(["node", "cli", "--help"], makeIo()), 0);
  assert.equal(run(["node", "cli", "bogus"], makeIo()), 2);
  assert.equal(run(["node", "cli", "plan", "fixtures/demo.json", "--nope"], makeIo()), 2);
  assert.equal(run(["node", "cli", "plan", "fixtures/demo.json,extra"], makeIo()), 1);
  assert.equal(run(["node", "cli", "plan", "fixtures/demo.json", "--verify-budget", "x"], makeIo()), 2);
  const missingInput = makeIo();
  assert.equal(run(["node", "cli", "plan"], missingInput), 2);
  assert.match(missingInput.err.join(""), /missing input file/);
});

test("compiled CLI works end to end as a real process", () => {
  // Piped stdio to nested node processes is restricted in some sandboxes,
  // so the child's stdout is redirected to a file instead of captured.
  const outFile = "dist/cli-e2e-out.json";
  const result = spawnSync(
    "/bin/sh",
    ["-c", `node dist/src/cli.js plan fixtures/demo.json > ${outFile}`],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(outFile, "utf8"));
  assert.equal(plan.minimumSamples, 7);
  assert.deepEqual(plan.selectedSamples, ["s01", "s02", "s03", "s04", "s06", "s07", "s08"]);
});

test("fixture file on disk matches the committed generator output", () => {
  const raw = JSON.parse(readFileSync("fixtures/demo.json", "utf8"));
  assert.equal(raw.strategies.length, 20);
  assert.equal(raw.samples.length, 30);
  assert.deepEqual(raw.strategies[18].outputs, raw.strategies[19].outputs);
});
