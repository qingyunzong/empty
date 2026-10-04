import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";

const SAMPLE = {
  start: "A",
  end: "F",
  checkpoints: ["D"],
  edges: [
    { from: "A", to: "B", cost: 2 },
    { from: "B", to: "D", cost: 2 },
    { from: "D", to: "F", cost: 2 },
    { from: "A", to: "C", cost: 1 },
    { from: "C", to: "F", cost: 1 },
    { from: "A", to: "D", cost: 9 },
  ],
};

interface CliOutput {
  found: boolean;
  witness: {
    path: string[];
    nodeCount: number;
    maxEdgeCost: number;
    totalCost: number;
  } | null;
  stats: { simplePaths: number; feasiblePaths: number };
}

// Runs the CLI in-process (the sandbox forbids spawning child processes),
// capturing everything it prints.
function runCli(argv: string[], stdin?: string): { code: number; out: string; err: string } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (msg?: unknown) => logs.push(String(msg));
  console.error = (msg?: unknown) => errors.push(String(msg));
  try {
    const code = run(argv, () => stdin ?? "");
    return { code, out: logs.join("\n"), err: errors.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

test("CLI reads a spec file and prints the witness", () => {
  const file = join(tmpdir(), "path-cli-sample.json");
  writeFileSync(file, JSON.stringify(SAMPLE));
  const { code, out } = runCli([file]);
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as CliOutput;
  assert.equal(parsed.found, true);
  // A-B-D-F: max edge 2, total 6; A-D-F has max edge 9; A-C-F skips checkpoint D.
  assert.deepEqual(parsed.witness, {
    path: ["A", "B", "D", "F"],
    nodeCount: 4,
    maxEdgeCost: 2,
    totalCost: 6,
  });
  assert.equal(parsed.stats.simplePaths, 3);
  assert.equal(parsed.stats.feasiblePaths, 2);
});

test("CLI reads the spec from stdin", () => {
  const { code, out } = runCli(["--compact"], JSON.stringify(SAMPLE));
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as CliOutput;
  assert.deepEqual(parsed.witness!.path, ["A", "B", "D", "F"]);
});

test("CLI overrides max-nodes and checkpoints from flags", () => {
  const { code, out } = runCli(
    ["--compact", "--max-nodes", "3", "--checkpoints", "D"],
    JSON.stringify(SAMPLE)
  );
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as CliOutput;
  assert.deepEqual(parsed.witness!.path, ["A", "D", "F"]); // 4-node path now excluded
  assert.equal(parsed.witness!.maxEdgeCost, 9);
});

test("CLI exits 1 with found=false when no feasible path exists", () => {
  const infeasible = { ...SAMPLE, maxNodes: 2 };
  const { code, out } = runCli(["--compact"], JSON.stringify(infeasible));
  assert.equal(code, 1);
  const parsed = JSON.parse(out) as CliOutput;
  assert.equal(parsed.found, false);
  assert.equal(parsed.witness, null);
});

test("CLI exits 2 on invalid JSON and on bad options", () => {
  assert.equal(runCli([], "not json").code, 2);
  assert.equal(runCli(["--max-nodes", "zero"], "{}").code, 2);
  assert.equal(runCli(["--nope"], "{}").code, 2);
});
