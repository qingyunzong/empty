import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeSamples, withdraw, enumerateNaive, shiftSamples, pValue,
} from "../src/core.js";
import { certify, confidenceSet, runWithCheckpoint } from "../src/certificate.js";
import { parse, cmp, toString } from "../src/rational.js";

const S = (diffs: string[]) =>
  makeSamples(diffs.map((d, i) => ({ id: `s${i + 1}`, diff: d })));

test("certificate cross-checks both engines and is deterministic", () => {
  const samples = S(["1/2", "1/2", "3", "-1", "0"]);
  const c1 = certify(samples, enumerateNaive(samples).tail);
  const c2 = certify(samples, enumerateNaive(samples).tail);
  assert.equal(c1.engines.agree, true);
  assert.equal(c1.digest, c2.digest);
  assert.equal(c1.statistic, "abs(mean(paired differences))");
  assert.equal(c1.zeroCount, 1);
});

test("confidence set matches brute force and uses strict p > alpha", () => {
  const samples = S(["1", "2", "4"]);
  const deltas = ["0", "1", "2", "3", "7/2"];
  const alpha = "1/4";
  const result = confidenceSet(samples, deltas, alpha);
  const a = parse(alpha);
  for (const cand of result.candidates) {
    // independent brute-force recomputation
    const shifted = shiftSamples(samples, parse(cand.delta));
    const t = enumerateNaive(shifted).tail;
    assert.equal(cand.p, toString(pValue(t)));
    assert.equal(cand.inSet, cmp(parse(cand.p), a) > 0);
  }
  assert.deepEqual(
    result.set,
    result.candidates.filter((c) => c.inSet).map((c) => c.delta),
  );
  // every candidate carries its own cross-checked certificate
  assert.equal(result.certificates.length, deltas.length);
  for (const c of result.certificates) assert.equal(c.engines.agree, true);
});

test("boundary: p exactly equal to alpha is excluded", () => {
  // diffs [1,2,3]: p = 1/4 exactly; alpha = 1/4 -> not in set
  const result = confidenceSet(S(["1", "2", "3"]), ["0"], "1/4");
  assert.equal(result.candidates[0].p, "1/4");
  assert.deepEqual(result.set, []);
  const result2 = confidenceSet(S(["1", "2", "3"]), ["0"], "1/5");
  assert.deepEqual(result2.set, ["0"]);
});

test("rejects more than 12 candidates", () => {
  const deltas = Array.from({ length: 13 }, (_, i) => String(i));
  assert.throws(() => confidenceSet(S(["1", "2"]), deltas, "1/4"), /too many candidates/);
});

test("withdrawal removes samples by id and validates ids", () => {
  const samples = S(["1", "2", "3", "4"]);
  const w = withdraw(samples, ["s2", "s4"]);
  assert.deepEqual(w.map((s) => s.id), ["s1", "s3"]);
  const t1 = enumerateNaive(w).tail;
  const t2 = enumerateNaive(S(["1", "3"])).tail;
  assert.equal(t1.countGE, t2.countGE);
  assert.equal(t1.total, t2.total);
  assert.throws(() => withdraw(samples, ["nope"]), /unknown sample id/);
});

test("checkpoint resume reproduces the uninterrupted count", () => {
  const dir = mkdtempSync(join(tmpdir(), "signflip-"));
  const cp = join(dir, "checkpoint.json");
  const samples = S(["1/3", "1/3", "-2", "5/4", "0", "7", "-1/2", "3", "3", "1", "2", "4"]);

  const first = runWithCheckpoint(samples, cp, { chunkSize: 64, maxChunks: 3 });
  assert.equal(first.complete, false);
  assert.equal(first.resumed, false);
  assert.ok(existsSync(cp), "checkpoint file persists after interruption");

  const second = runWithCheckpoint(samples, cp, { chunkSize: 64 });
  assert.equal(second.complete, true);
  assert.equal(second.resumed, true);
  assert.ok(!existsSync(cp), "checkpoint file is cleaned up on completion");

  const direct = enumerateNaive(samples).tail;
  assert.equal(second.tail.countGE, direct.countGE);
  assert.equal(second.tail.total, direct.total);
});

test("checkpoint refuses to resume with different input", () => {
  const dir = mkdtempSync(join(tmpdir(), "signflip-"));
  const cp = join(dir, "checkpoint.json");
  runWithCheckpoint(S(["1", "2", "3", "4", "5"]), cp, { chunkSize: 4, maxChunks: 1 });
  assert.throws(
    () => runWithCheckpoint(S(["9", "9", "9", "9", "9"]), cp),
    /does not match input/,
  );
});
