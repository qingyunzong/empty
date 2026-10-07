import test from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import type { Rational } from "../src/rational.ts";
import { abs, add, cmp, make, parse, sub, toString } from "../src/rational.ts";
import { createDataset } from "../src/dataset.ts";
import { confidenceSet } from "../src/confidence.ts";

function bruteForceP(diffs: Rational[]): Rational {
  const nonzero = diffs.filter((d) => d.num !== 0n);
  const observed = diffs.reduce((acc, d) => add(acc, d), make(0n));
  const threshold = abs(observed);
  let tail = 0n;
  const total = 1n << BigInt(nonzero.length);
  for (let mask = 0n; mask < total; mask++) {
    let sum = make(0n);
    for (let j = 0; j < nonzero.length; j++) {
      const bit = (mask >> BigInt(j)) & 1n;
      sum = add(sum, bit === 1n ? nonzero[j] : { num: -nonzero[j].num, den: nonzero[j].den });
    }
    if (cmp(abs(sum), threshold) >= 0) tail++;
  }
  return make(tail, total);
}

test("confidence set matches independent brute force", () => {
  const ds = createDataset([
    { id: "a", diff: "1" },
    { id: "b", diff: "2" },
    { id: "c", diff: "3" },
    { id: "d", diff: "4" },
  ]);
  const deltas = [parse("0"), parse("5/2"), parse("10")];
  const alpha = parse("1/8");
  const result = confidenceSet(ds, deltas, alpha);
  for (const r of result.results) {
    const shifted = ds.map((s) => sub(s.diff, parse(r.delta)));
    const expected = bruteForceP(shifted);
    equal(r.pValue, toString(expected), `p mismatch at delta=${r.delta}`);
    equal(r.crossChecked, true);
  }
  equal(result.results[0].pValue, "1/8");
  equal(result.results[0].included, false);
  equal(result.results[1].pValue, "1");
  equal(result.results[1].included, true);
  equal(result.results[2].pValue, "1/8");
  equal(result.results[2].included, false);
  equal(result.included.length, 1);
  equal(result.included[0], "5/2");
});

test("strict inequality: p equal to alpha is excluded", () => {
  const ds = createDataset([{ id: "a", diff: "1" }, { id: "b", diff: "2" }]);
  const result = confidenceSet(ds, [parse("0")], parse("1/2"));
  equal(result.results[0].pValue, "1/2");
  equal(result.included.length, 0);
  const looser = confidenceSet(ds, [parse("0")], parse("1/4"));
  equal(looser.included.length, 1);
});

test("at most 12 candidate shifts", () => {
  const ds = createDataset([{ id: "a", diff: "1" }]);
  const deltas: Rational[] = [];
  for (let i = 0; i < 13; i++) deltas.push(make(BigInt(i)));
  throws(() => confidenceSet(ds, deltas, parse("1/10")));
  const twelve = deltas.slice(0, 12);
  ok(confidenceSet(ds, twelve, parse("1/10")).results.length === 12);
});
