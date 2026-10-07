import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { runCli } from "../src/cli";
import {
  calibrate,
  buildOptions,
  activeSamples,
  lexCompare,
  normalizeInput,
  resolveVersion,
  ThresholdOption,
  CalibrateResult,
} from "../src/calibrate";

/** Independent brute-force optimum over the same candidate domain. */
function bruteForce(optionsPerGroup: ThresholdOption[][], budget: number): { fn: number; vec: number[] } {
  let bestFn = Infinity;
  let bestVec: number[] = [];
  const vec: number[] = new Array(optionsPerGroup.length).fill(0);
  const rec = (i: number, fp: number, fn: number): void => {
    if (i === optionsPerGroup.length) {
      if (fn < bestFn || (fn === bestFn && lexCompare(vec, bestVec) < 0)) {
        bestFn = fn;
        bestVec = vec.slice();
      }
      return;
    }
    for (const o of optionsPerGroup[i]) {
      if (fp + o.fp > budget) continue;
      vec[i] = o.threshold;
      rec(i + 1, fp + o.fp, fn + o.fn);
    }
  };
  rec(0, 0, 0);
  return { fn: bestFn, vec: bestVec };
}

function optionsOf(result: CalibrateResult): ThresholdOption[][] {
  return result.certificate.groups.map((g) => g.options);
}

test("hand-computed two-group case", () => {
  const result = calibrate({
    budget: 1,
    groups: [
      {
        name: "a",
        samples: [
          { score: 5, label: 1 },
          { score: 6, label: 0 },
        ],
      },
      {
        name: "b",
        samples: [
          { score: 3, label: 1 },
          { score: 4, label: 0 },
        ],
      },
    ],
  });
  // Each group: accept-all costs fp=1/fn=0, reject-all costs fp=0/fn=1.
  // Budget 1 -> exactly one group can accept all, total FN = 1 either way.
  // Tie on FN -> lexicographically smallest vector: [5, 5] beats [7, 3].
  assert.deepEqual(result.thresholds, [5, 5]);
  assert.equal(result.totals.fn, 1);
  assert.equal(result.totals.fp, 1);
  assert.deepEqual(result.groups[0].confusion, { tp: 1, fp: 1, tn: 0, fn: 0 });
  assert.deepEqual(result.groups[1].confusion, { tp: 0, fp: 0, tn: 1, fn: 1 });
});

test("tied scores always share the same decision", () => {
  const result = calibrate({
    budget: 10,
    groups: [
      {
        samples: [
          { score: 7, label: 1 },
          { score: 7, label: 0 },
          { score: 7, label: 1 },
          { score: 2, label: 0 },
        ],
      },
    ],
  });
  const c = result.groups[0].confusion;
  // Budget 10 -> accept everything; the whole score-7 block moves together.
  assert.deepEqual(result.thresholds, [2]);
  assert.deepEqual(c, { tp: 2, fp: 2, tn: 0, fn: 0 });
});

test("lexicographic tie-break picks smallest threshold vector", () => {
  // In each group the negative outranks the positive, so FN 0 costs FP 1
  // (accept all) and FN 1 costs FP 0 (reject all). Budget 1 forces total
  // FN = 1; the lexicographically smallest optimal vector wins.
  const result = calibrate({
    budget: 1,
    groups: [
      {
        samples: [
          { score: 1, label: 1 },
          { score: 2, label: 0 },
        ],
      },
      {
        samples: [
          { score: 9, label: 1 },
          { score: 10, label: 0 },
        ],
      },
    ],
  });
  assert.equal(result.totals.fn, 1);
  assert.deepEqual(result.thresholds, [1, 11]); // [1,11] < [3,9] lexicographically
});

test("budget constraint is never violated", () => {
  const result = calibrate({
    budget: 0,
    groups: [
      {
        samples: [
          { score: 5, label: 0 },
          { score: 9, label: 1 },
        ],
      },
    ],
  });
  assert.equal(result.totals.fp, 0);
  assert.deepEqual(result.thresholds, [9]); // accept the positive, reject the negative
  assert.equal(result.totals.fn, 0);
});

test("sample versions add and remove samples", () => {
  const input = {
    budget: 5,
    groups: [
      {
        samples: [
          { id: "keep", score: 5, label: 1 },
          { id: "added-later", score: 1, label: 0, since: 2 },
          { id: "removed", score: 9, label: 0, until: 2 },
        ],
      },
    ],
  };
  const v0 = calibrate({ ...input, version: 0 });
  assert.equal(v0.groups[0].sampleCount, 2); // keep + removed
  const v2 = calibrate({ ...input, version: 2 });
  assert.equal(v2.groups[0].sampleCount, 2); // keep + added-later
  const v3 = calibrate({ ...input, version: 3 });
  assert.equal(v3.groups[0].sampleCount, 2);
  // Default version = latest mentioned (2).
  assert.equal(resolveVersion(normalizeInput(input)), 2);
});

test("rejects more than 8 groups and bad scores", () => {
  assert.throws(() =>
    calibrate({ budget: 1, groups: Array.from({ length: 9 }, () => ({ samples: [] })) })
  );
  assert.throws(() =>
    calibrate({ budget: 1, groups: [{ samples: [{ score: 1.5, label: 1 }] }] })
  );
  assert.throws(() => calibrate({ budget: -1, groups: [{ samples: [] }] }));
});

test("empty group gets a trivial threshold", () => {
  const result = calibrate({
    budget: 0,
    groups: [{ name: "empty", samples: [] }, { samples: [{ score: 3, label: 1 }] }],
  });
  assert.deepEqual(result.groups[0].confusion, { tp: 0, fp: 0, tn: 0, fn: 0 });
  assert.equal(result.totals.fn, 0);
});

test("confusion matrices sum to group sample counts", () => {
  const result = calibrate({
    budget: 2,
    groups: [
      {
        samples: [
          { score: 1, label: 1 },
          { score: 2, label: 0 },
          { score: 3, label: 1 },
        ],
      },
      {
        samples: [
          { score: 4, label: 0 },
          { score: 5, label: 0 },
        ],
      },
    ],
  });
  const counts = [3, 2];
  result.groups.forEach((g, i) => {
    const c = g.confusion;
    assert.equal(c.tp + c.fp + c.tn + c.fn, counts[i]);
  });
});

test("exhaustive certificate matches DP on a small domain", () => {
  const result = calibrate({
    budget: 3,
    groups: [
      {
        samples: [
          { score: 6, label: 1 },
          { score: 4, label: 0 },
          { score: 2, label: 1 },
        ],
      },
      {
        samples: [
          { score: 5, label: 0 },
          { score: 1, label: 1 },
        ],
      },
    ],
  });
  assert.equal(result.certificate.exhaustive.performed, true);
  assert.equal(result.certificate.exhaustive.matchesDp, true);
  assert.equal(result.certificate.exhaustive.combinations, 4 * 3);
  assert.equal(result.certificate.dp.tableIncluded, true);
});

test("exhaustive check is skipped beyond the verify limit", () => {
  const result = calibrate(
    { budget: 1, groups: [{ samples: [{ score: 1, label: 1 }] }] },
    { verifyLimit: 0 }
  );
  assert.equal(result.certificate.exhaustive.performed, false);
});

test("randomized cross-check: DP equals independent brute force", () => {
  let seed = 0xC0FFEE;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let trial = 0; trial < 300; trial++) {
    const groupCount = 1 + (rand() % 4);
    const groups = Array.from({ length: groupCount }, () => ({
      samples: Array.from({ length: rand() % 8 }, () => ({
        score: rand() % 7,
        label: rand() % 2,
      })),
    }));
    const budget = rand() % 6;
    const result = calibrate({ budget, groups });
    const bf = bruteForce(optionsOf(result), budget);
    assert.equal(result.totals.fn, bf.fn, `FN mismatch on trial ${trial}`);
    assert.deepEqual(result.thresholds, bf.vec, `threshold vector mismatch on trial ${trial}`);
    assert.ok(result.totals.fp <= budget, `budget violated on trial ${trial}`);
    assert.equal(result.certificate.exhaustive.matchesDp, true, `certificate mismatch on trial ${trial}`);
  }
});

test("buildOptions domain is distinct scores plus max+1", () => {
  const opts = buildOptions([
    { id: "a", score: 3, label: true },
    { id: "b", score: 3, label: false },
    { id: "c", score: 9, label: false },
  ]);
  assert.deepEqual(opts.map((o) => o.threshold), [3, 9, 10]);
  assert.deepEqual(opts[0], { threshold: 3, tp: 1, fp: 2, tn: 0, fn: 0 });
  assert.deepEqual(opts[2], { threshold: 10, tp: 0, fp: 0, tn: 2, fn: 1 });
});

test("activeSamples honours since/until boundaries", () => {
  const group = {
    samples: [
      { id: "x", score: 1, label: 1 as const, since: 2, until: 5 },
      { id: "y", score: 1, label: 0 as const },
    ],
  };
  assert.deepEqual(activeSamples(group, 1, 0).map((s) => s.id), ["y"]);
  assert.deepEqual(activeSamples(group, 2, 0).map((s) => s.id), ["x", "y"]);
  assert.deepEqual(activeSamples(group, 4, 0).map((s) => s.id), ["x", "y"]);
  assert.deepEqual(activeSamples(group, 5, 0).map((s) => s.id), ["y"]);
});

test("CLI end-to-end via runCli with file input and override flags", () => {
  const input = JSON.stringify({
    budget: 1,
    groups: [
      {
        name: "g",
        samples: [
          { score: 5, label: 1 },
          { score: 4, label: 0 },
        ],
      },
    ],
  });
  const tmpPath = `/tmp/calibrate-cli-test-${Date.now()}.json`;
  writeFileSync(tmpPath, input);
  const out = runCli([tmpPath, "--compact"]);
  const parsed = JSON.parse(out) as CalibrateResult;
  // fn=0 is reachable at t=4 (fp=1) and t=5 (fp=0); lex-min picks t=4.
  assert.deepEqual(parsed.thresholds, [4]);
  assert.deepEqual(parsed.groups[0].confusion, { tp: 1, fp: 1, tn: 0, fn: 0 });
  assert.equal(parsed.certificate.exhaustive.matchesDp, true);

  const out2 = runCli([tmpPath, "--budget", "0", "--compact"]);
  const parsed2 = JSON.parse(out2) as CalibrateResult;
  assert.deepEqual(parsed2.thresholds, [5]); // fp=0: accept positive at 5, reject negative at 4
  assert.equal(parsed2.totals.fp, 0);

  // Stdin path and validation errors.
  const out3 = runCli(["--compact"], () => input);
  assert.deepEqual((JSON.parse(out3) as CalibrateResult).thresholds, [4]);
  assert.throws(() => runCli([tmpPath, "--budget", "-3"]));
  assert.ok(runCli(["--help"]).includes("Usage: calibrate"));
  unlinkSync(tmpPath);
});
