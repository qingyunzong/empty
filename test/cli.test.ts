import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const CLI = "dist/src/cli.js";

interface CliOutput {
  status: string;
  amount: number;
  minCost?: number;
  flows?: Array<{ from: string; to: string; flow: number; cost: number }>;
  potentials?: Record<string, number>;
  certificate?: { valid: boolean; checks: Array<{ name: string; ok: boolean }> };
  bruteForce?: { status: string; minCost?: number; agreesWithSolver: boolean };
}

// The sandbox blocks pipe IPC between processes, so capture child stdio
// through temporary files instead of pipes.
let tmpCounter = 0;
function runCli(args: string[], stdinText?: string): { code: number; stdout: string } {
  const tag = `/tmp/transfer-cli-test-${process.pid}-${tmpCounter++}`;
  const outPath = tag + ".out";
  writeFileSync(outPath, "");
  const outFd = openSync(outPath, "w");
  const stdio: Array<number | "ignore"> = ["ignore", outFd, "ignore"];
  let inFd: number | null = null;
  if (stdinText !== undefined) {
    const inPath = tag + ".in";
    writeFileSync(inPath, stdinText);
    inFd = openSync(inPath, "r");
    stdio[0] = inFd;
  }
  try {
    const r = spawnSync("node", [CLI, ...args], { stdio });
    if (r.error) throw r.error;
    return { code: r.status ?? -1, stdout: readFileSync(outPath, "utf8") };
  } finally {
    closeSync(outFd);
    if (inFd !== null) closeSync(inFd);
    for (const suffix of [".out", ".in"]) {
      try {
        unlinkSync(tag + suffix);
      } catch {
        /* ignore */
      }
    }
  }
}

describe("cli", () => {
  test("solves examples/sample.json with a valid certificate", () => {
    const { code, stdout } = runCli(["examples/sample.json", "--brute"]);
    assert.equal(code, 0);
    const out = JSON.parse(stdout) as CliOutput;
    assert.equal(out.status, "ok");
    assert.equal(out.amount, 5);
    assert.equal(out.minCost, 14);
    assert.equal(out.certificate!.valid, true);
    assert.equal(out.bruteForce!.agreesWithSolver, true);
    // Flow conservation in the reported flows.
    const balance = new Map<string, number>();
    for (const f of out.flows!) {
      balance.set(f.from, (balance.get(f.from) ?? 0) - f.flow);
      balance.set(f.to, (balance.get(f.to) ?? 0) + f.flow);
    }
    assert.equal(balance.get("alice"), -5);
    assert.equal(balance.get("dave"), 5);
    assert.equal(balance.get("bob") ?? 0, 0);
    assert.equal(balance.get("carol") ?? 0, 0);
    // Reported flow cost sums to minCost.
    const flowCost = out.flows!.reduce((acc, f) => acc + f.cost, 0);
    assert.equal(flowCost, out.minCost);
  });

  test("reads from stdin and honors --amount override", () => {
    const input = JSON.stringify({
      source: "A",
      sink: "B",
      amount: 1,
      edges: [{ from: "A", to: "B", segments: [{ capacity: 3, cost: 4 }] }],
    });
    const { code, stdout } = runCli(["-", "--amount", "2"], input);
    assert.equal(code, 0);
    const out = JSON.parse(stdout) as CliOutput;
    assert.equal(out.amount, 2);
    assert.equal(out.minCost, 8);
  });

  test("exit code 1 when the amount is infeasible", () => {
    const input = JSON.stringify({
      source: "A",
      sink: "B",
      amount: 5,
      edges: [{ from: "A", to: "B", segments: [{ capacity: 1, cost: 1 }] }],
    });
    const { code, stdout } = runCli(["-"], input);
    assert.equal(code, 1);
    assert.equal((JSON.parse(stdout) as CliOutput).status, "infeasible");
  });

  test("exit code 2 on negative-cost cycle input", () => {
    const { code } = runCli(["examples/negative-cycle.json"]);
    assert.equal(code, 2);
  });

  test("exit code 2 on invalid input", () => {
    const { code } = runCli(["-"], "{\"source\":\"A\"}");
    assert.equal(code, 2);
  });
});
