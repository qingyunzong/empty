import test from "node:test";
import assert from "node:assert";
import { parseProblem } from "../src/parser";
import { solveProblem, StepInterval } from "../src/solver";
import { constraintHolds, verifyProblem } from "../src/verify";

/** Deterministic RNG (test data generation only, never used by the solver). */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return (n: number): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

function linStr(a: number, k: number): string {
  return `${a}*x + (${k})`;
}

function expand(intervals: StepInterval[]): bigint[] {
  const out: bigint[] = [];
  for (const iv of intervals) for (let v = iv.start; v <= iv.end; v += iv.step) out.push(v);
  return out;
}

test("randomized systems match brute-force enumeration exactly", () => {
  const rng = makeRng(20261008);
  const ops = ["<=", "<", ">=", ">", "==", "!="];
  for (let iter = 0; iter < 400; iter++) {
    const lo = -rng(60);
    const hi = rng(60);
    const lines: string[] = [`var x in [${lo}, ${hi}]`];
    const nIneq = rng(5);
    for (let i = 0; i < nIneq; i++) {
      const a = rng(13) - 6;
      const k = rng(61) - 30;
      lines.push(`${linStr(a, k)} ${ops[rng(ops.length)]} 0`);
    }
    const nCong = rng(3);
    for (let i = 0; i < nCong; i++) {
      const a = rng(9);
      const k = rng(25) - 12;
      const m = 1 + rng(12);
      lines.push(`${linStr(a, k)} % ${m} == 0`);
    }
    const nNeq = rng(3);
    for (let i = 0; i < nNeq; i++) {
      lines.push(`x != ${lo - 5 + rng(hi - lo + 11)}`);
    }
    const text = lines.join("\n");
    const problem = parseProblem(text);
    const result = solveProblem(problem);

    // Independent brute force over the whole declared domain.
    const expected: bigint[] = [];
    for (let x = BigInt(lo); x <= BigInt(hi); x++) {
      if (problem.constraints.every((c) => constraintHolds(c, "x", x))) expected.push(x);
    }

    if (result.certificate !== null) {
      // A constant constraint failed: no variable assignment can help.
      assert.equal(result.status, "unsat");
      assert.equal(expected.length, 0, `constant contradiction but brute force found solutions for:\n${text}`);
      continue;
    }
    const sol = result.variables[0]!;

    if (expected.length === 0) {
      assert.equal(sol.status, "unsat", `expected UNSAT for:\n${text}`);
      assert.ok(sol.certificate !== null, `UNSAT must carry a certificate for:\n${text}`);
    } else {
      assert.equal(sol.status, "sat", `expected SAT for:\n${text}`);
      assert.deepStrictEqual(expand(sol.intervals), expected, `interval mismatch for:\n${text}`);
      assert.equal(sol.solutionCount, BigInt(expected.length));
      // Minimality: intervals share one step and are separated by >= 2 steps.
      const step = sol.intervals[0]!.step;
      for (let i = 0; i < sol.intervals.length; i++) {
        assert.equal(sol.intervals[i]!.step, step, `inconsistent step for:\n${text}`);
        if (i > 0) {
          const gap = sol.intervals[i]!.start - sol.intervals[i - 1]!.end;
          assert.ok(gap >= 2n * step, `intervals are mergeable (not minimal) for:\n${text}`);
        }
      }
    }

    // The verifier itself must confirm the result exhaustively.
    const reports = verifyProblem(problem, result, 1_000_000n);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.mode, "exhaustive");
    assert.ok(reports[0]!.ok, `verification failed for:\n${text}\n${reports[0]!.mismatches.join("\n")}`);
  }
});

test("boundary verification kicks in for huge shrunk domains", () => {
  const problem = parseProblem(
    `var x in [${-(2n ** 63n)}, ${2n ** 63n - 1n}]\nx % 1000000007 == 42\nx != 42`
  );
  const result = solveProblem(problem);
  assert.equal(result.status, "sat");
  const reports = verifyProblem(problem, result, 1000n);
  assert.equal(reports[0]!.mode, "boundary");
  assert.ok(reports[0]!.ok);
  assert.ok(reports[0]!.candidatesChecked > 0n);
});

test("unsat certificates are confirmed by exhaustive scan", () => {
  const problem = parseProblem("var x in [-40, 40]\n3*x % 9 == 1\nx >= -40");
  const result = solveProblem(problem);
  assert.equal(result.status, "unsat");
  const reports = verifyProblem(problem, result, 1_000_000n);
  assert.equal(reports[0]!.mode, "exhaustive");
  assert.ok(reports[0]!.ok);
  assert.equal(reports[0]!.candidatesChecked, 81n);
});
