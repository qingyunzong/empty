import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeSamples, enumerateNaive, enumerateCompressed, pValue, MAX_SAMPLES,
} from "../src/core.js";
import { toString } from "../src/rational.js";

const S = (diffs: string[]) =>
  makeSamples(diffs.map((d, i) => ({ id: `s${i + 1}`, diff: d })));

test("hand-computed: diffs [1,2,3] gives p = 1/4", () => {
  const t = enumerateNaive(S(["1", "2", "3"])).tail;
  assert.equal(t.total, 8n);
  assert.equal(t.countGE, 2n); // only +++ and --- reach |sum| = 6
  assert.equal(toString(pValue(t)), "1/4");
  assert.equal(toString(t.observedStat), "2"); // |mean| = 6/3
});

test("hand-computed: four equal diffs gives p = 1/8", () => {
  const t = enumerateNaive(S(["1", "1", "1", "1"])).tail;
  assert.equal(t.total, 16n);
  assert.equal(t.countGE, 2n);
  assert.equal(toString(pValue(t)), "1/8");
});

test("hand-computed: rationals [1/2, 1/3] gives p = 1/2", () => {
  const t = enumerateNaive(S(["1/2", "1/3"])).tail;
  assert.equal(t.total, 4n);
  assert.equal(t.countGE, 2n);
  assert.equal(toString(pValue(t)), "1/2");
  assert.equal(toString(t.observedSum), "5/6");
});

test("zero diffs carry a single sign", () => {
  const t = enumerateNaive(S(["0", "5"])).tail;
  assert.equal(t.zeroCount, 1);
  assert.equal(t.nonzeroCount, 1);
  assert.equal(t.total, 2n); // not 4: the zero contributes one sign only
  assert.equal(t.countGE, 2n);
  assert.equal(toString(pValue(t)), "1");
});

test("all-zero input yields a single assignment and p = 1", () => {
  const t = enumerateNaive(S(["0", "0", "0"])).tail;
  assert.equal(t.total, 1n);
  assert.equal(t.countGE, 1n);
  assert.equal(toString(t.observedStat), "0");
});

test("compressed engine agrees with naive on repeated values", () => {
  const samples = S(["1/2", "1/2", "1/2", "-3/4", "-3/4", "2", "2", "2", "2", "0"]);
  const a = enumerateNaive(samples).tail;
  const b = enumerateCompressed(samples);
  assert.equal(a.total, b.total);
  assert.equal(a.countGE, b.countGE);
});

test("compressed engine agrees with naive on randomized inputs", () => {
  let seed = 0x2f6e2b1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pool = ["0", "1/4", "-1/4", "1/2", "1", "-3/2", "2", "0.75"];
  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + Math.floor(rnd() * 12);
    const diffs = Array.from({ length: n }, () => pool[Math.floor(rnd() * pool.length)]);
    const samples = S(diffs);
    const a = enumerateNaive(samples).tail;
    const b = enumerateCompressed(samples);
    assert.equal(a.total, b.total, `total mismatch on ${diffs}`);
    assert.equal(a.countGE, b.countGE, `countGE mismatch on ${diffs}`);
  }
});

test("rejects more than 20 samples", () => {
  const entries = Array.from({ length: MAX_SAMPLES + 1 }, (_, i) => ({
    id: `s${i}`, diff: "1",
  }));
  assert.throws(() => makeSamples(entries), /too many samples/);
});

test("duplicate sample ids are rejected", () => {
  assert.throws(() => makeSamples([
    { id: "a", diff: "1" }, { id: "a", diff: "2" },
  ]), /duplicate sample id/);
});
