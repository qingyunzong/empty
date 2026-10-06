import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bruteForce,
  confusion,
  groupOptions,
  lexCmp,
  solve,
} from "../src/calibrate.js";
import {
  addSample,
  load,
  removeSample,
  save,
  validate,
} from "../src/dataset.js";
import type { Dataset, Group } from "../src/types.js";

const grp = (name: string, samples: [string, number, 0 | 1][]): Group => ({
  name,
  samples: samples.map(([id, score, label]) => ({ id, score, label })),
});

test("hand-computed optimum with budget and lexicographic tie-break", () => {
  // A: t5->(fp1,fn0), t7->(fp0,fn1). B: t3->(fp1,fn0), t4->(fp0,fn1).
  // budget 1: best fn=1 achieved by [5,4] and [7,3]; lex-min is [5,4].
  const groups = [
    grp("A", [
      ["p1", 5, 1],
      ["p2", 7, 1],
      ["n1", 6, 0],
    ]),
    grp("B", [
      ["p1", 3, 1],
      ["n1", 3, 0],
    ]),
  ];
  const r = solve(groups, 1);
  assert.deepEqual(r.vector, [5, 4]);
  assert.equal(r.fn, 1);
  assert.equal(r.fp, 1);
  const bf = bruteForce(r.options, 1);
  assert.equal(bf.status, "ok");
  assert.equal(bf.fn, r.fn);
  assert.deepEqual(bf.vector, r.vector);
});

test("tied scores always share a decision", () => {
  const g = grp("G", [
    ["a", 3, 1],
    ["b", 3, 0],
  ]);
  const opts = groupOptions(g);
  // only thresholds 3 and 4 are distinct decisions
  assert.equal(opts.length, 2);
  const c3 = confusion(g, 3);
  assert.deepEqual(c3, { tp: 1, fp: 1, tn: 0, fn: 0 });
  const c4 = confusion(g, 4);
  assert.deepEqual(c4, { tp: 0, fp: 0, tn: 1, fn: 1 });
});

test("pareto pruning keeps smallest threshold among equal (fp,fn)", () => {
  const g = grp("G", [
    ["p1", 1, 1],
    ["p2", 2, 1],
  ]);
  const opts = groupOptions(g);
  // no negatives: accepting everything (t=1) dominates all others
  assert.deepEqual(opts, [{ threshold: 1, fp: 0, fn: 0 }]);
});

test("empty group yields a single zero-cost option", () => {
  const opts = groupOptions(grp("E", []));
  assert.deepEqual(opts, [{ threshold: 0, fp: 0, fn: 0 }]);
  const r = solve([grp("E", [])], 3);
  assert.deepEqual(r.vector, [0]);
  assert.equal(r.fn, 0);
  assert.equal(r.fp, 0);
});

test("reject-all is always feasible within any budget", () => {
  const groups = [grp("A", [["n1", 9, 0]])];
  const r = solve(groups, 0);
  assert.equal(r.fp, 0);
  assert.equal(r.fn, 0);
  assert.deepEqual(r.vector, [10]); // max score + 1
});

test("lexCmp orders element-wise", () => {
  assert.ok(lexCmp([1, 9], [2, 0]) < 0);
  assert.ok(lexCmp([2, 0], [1, 9]) > 0);
  assert.equal(lexCmp([2, 0], [2, 0]), 0);
});

test("randomized: DP agrees with exhaustive enumeration", () => {
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let iter = 0; iter < 300; iter++) {
    const nGroups = 1 + rand(4);
    const groups: Group[] = [];
    for (let gi = 0; gi < nGroups; gi++) {
      const n = rand(9);
      const samples: [string, number, 0 | 1][] = [];
      for (let si = 0; si < n; si++) {
        samples.push([`g${gi}s${si}`, rand(6), rand(2) as 0 | 1]);
      }
      groups.push(grp(`G${gi}`, samples));
    }
    const budget = rand(5);
    const r = solve(groups, budget);
    const bf = bruteForce(r.options, budget);
    assert.equal(bf.status, "ok");
    assert.equal(r.fn, bf.fn, `iter ${iter}: fn mismatch`);
    assert.deepEqual(r.vector, bf.vector, `iter ${iter}: vector mismatch`);
    assert.ok(r.fp <= budget, `iter ${iter}: budget exceeded`);
    // confusion matrices must be consistent with the totals
    let tpFn = 0;
    let tpFp = 0;
    groups.forEach((g, i) => {
      const c = confusion(g, r.vector[i]!);
      tpFn += c.fn;
      tpFp += c.fp;
    });
    assert.equal(tpFn, r.fn);
    assert.equal(tpFp, r.fp);
  }
});

test("dataset validation rejects bad input", () => {
  assert.throws(() => validate({ budget: -1, groups: [] }));
  assert.throws(() => validate({ budget: 0, groups: new Array(9).fill({ name: "x", samples: [] }) }));
  assert.throws(() =>
    validate({ budget: 0, groups: [{ name: "g", samples: [{ id: "a", score: 1.5, label: 1 }] }] }),
  );
  assert.throws(() =>
    validate({ budget: 0, groups: [{ name: "g", samples: [{ id: "a", score: 1, label: 2 }] }] }),
  );
  assert.throws(() =>
    validate({
      budget: 0,
      groups: [{ name: "g", samples: [
        { id: "a", score: 1, label: 1 },
        { id: "a", score: 2, label: 0 },
      ] }],
    }),
  );
});

test("add/remove samples bump version and persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "calib-"));
  const path = join(dir, "ds.json");
  const ds: Dataset = {
    version: 0,
    budget: 1,
    groups: [grp("A", [["s1", 5, 1]])],
  };
  save(path, ds);
  let cur = load(path);
  addSample(cur, "A", { id: "s2", score: 4, label: 0 });
  assert.equal(cur.version, 1);
  save(path, cur);
  cur = load(path);
  assert.equal(cur.version, 1);
  assert.equal(cur.groups[0]!.samples.length, 2);
  assert.throws(() => addSample(cur, "A", { id: "s2", score: 1, label: 1 }));
  assert.throws(() => addSample(cur, "B", { id: "x", score: 1, label: 1 }));
  removeSample(cur, "A", "s1");
  assert.equal(cur.version, 2);
  assert.equal(cur.groups[0]!.samples.length, 1);
  assert.throws(() => removeSample(cur, "A", "nope"));
});

test("eight groups supported, nine rejected", () => {
  const groups = Array.from({ length: 8 }, (_, i) =>
    grp(`G${i}`, [
      ["p", i, 1],
      ["n", i, 0],
    ]),
  );
  const r = solve(groups, 0);
  assert.equal(r.fn, 8); // budget 0 forces reject-all everywhere
  assert.equal(r.fp, 0);
});
