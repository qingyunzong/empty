import test from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createDataset } from "../src/dataset.ts";
import {
  enumerateCompressed,
  enumerateNaive,
  groupMultiplicities,
} from "../src/enumerate.ts";

test("two samples: exact counts", () => {
  const ds = createDataset([{ id: "a", diff: "1" }, { id: "b", diff: "2" }]);
  const r = enumerateCompressed(ds);
  equal(r.totalAssignments, 4n);
  equal(r.tailCount, 2n);
  const naive = enumerateNaive(ds);
  equal(naive.tailCount, 2n);
});

test("zero difference contributes a single sign", () => {
  const ds = createDataset([{ id: "z", diff: "0" }, { id: "b", diff: "5" }]);
  const r = enumerateCompressed(ds);
  equal(r.totalAssignments, 2n);
  equal(r.tailCount, 2n);
  const naive = enumerateNaive(ds);
  equal(naive.totalAssignments, 2n);
  equal(naive.tailCount, 2n);
});

test("repeated values require distinct sample ids", () => {
  throws(() =>
    createDataset([
      { id: "a", diff: "2" },
      { id: "a", diff: "2" },
    ]),
  );
  const ds = createDataset([
    { id: "a", diff: "2" },
    { id: "b", diff: "2" },
    { id: "c", diff: "2" },
  ]);
  equal(ds.length, 3);
});

test("repeated diffs: compressed matches naive, multiplicity preserved", () => {
  const ds = createDataset([
    { id: "a", diff: "2" },
    { id: "b", diff: "2" },
    { id: "c", diff: "2" },
  ]);
  const groups = groupMultiplicities(ds);
  equal(groups.get("2"), 3);
  const r = enumerateCompressed(ds);
  equal(r.totalAssignments, 8n);
  equal(r.tailCount, 2n);
  let sumCounts = 0n;
  for (const c of r.counts.values()) sumCounts += c;
  equal(sumCounts, 8n);
  const naive = enumerateNaive(ds);
  equal(naive.tailCount, r.tailCount);
  equal(naive.totalAssignments, r.totalAssignments);
});

test("compressed matches naive on 20 rational samples", () => {
  const entries: { id: string; diff: string }[] = [];
  for (let i = 0; i < 20; i++) entries.push({ id: `s${i}`, diff: `${(i % 5) + 1}/2` });
  const ds = createDataset(entries);
  const comp = enumerateCompressed(ds);
  const naive = enumerateNaive(ds);
  equal(comp.totalAssignments, 1n << 20n);
  equal(comp.tailCount, naive.tailCount);
  equal(comp.totalAssignments, naive.totalAssignments);
});

test("naive checkpoint: stop and resume gives identical counts", () => {
  const entries = [];
  for (let i = 1; i <= 12; i++) entries.push({ id: `s${i}`, diff: String(i) });
  const ds = createDataset(entries);
  const file = join(tmpdir(), `naive-ckpt-${process.pid}.json`);
  const oneShot = enumerateNaive(ds);
  const partial = enumerateNaive(ds, { checkpointFile: file, checkpointEvery: 200, maxSteps: 1000 });
  equal(partial.done, false);
  equal(partial.processed, 1000n);
  ok(existsSync(file));
  const resumed = enumerateNaive(ds, { checkpointFile: file, resume: true });
  equal(resumed.done, true);
  equal(resumed.tailCount, oneShot.tailCount);
  equal(resumed.totalAssignments, oneShot.totalAssignments);
});

test("compressed checkpoint: resume after interruption", () => {
  const entries = [];
  for (let i = 1; i <= 14; i++) entries.push({ id: `s${i}`, diff: `${i}/3` });
  const ds = createDataset(entries);
  const file = join(tmpdir(), `comp-ckpt-${process.pid}.json`);
  const first = enumerateCompressed(ds, { checkpointFile: file });
  ok(existsSync(file));
  const second = enumerateCompressed(ds, { checkpointFile: file, resume: true });
  equal(second.tailCount, first.tailCount);
  equal(second.totalAssignments, first.totalAssignments);
});

test("checkpoint rejects mismatched dataset", () => {
  const a = createDataset([{ id: "a", diff: "1" }]);
  const b = createDataset([{ id: "b", diff: "2" }]);
  const file = join(tmpdir(), `mismatch-ckpt-${process.pid}.json`);
  enumerateCompressed(a, { checkpointFile: file });
  throws(() => enumerateCompressed(b, { checkpointFile: file, resume: true }));
});

test("rejects more than 20 samples", () => {
  const entries: { id: string; diff: string }[] = [];
  for (let i = 0; i < 21; i++) entries.push({ id: `s${i}`, diff: "1" });
  throws(() => createDataset(entries));
});
