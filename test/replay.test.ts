import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runProperty,
  loadFailureRecord,
  failureFilePath,
  FailureRecord,
} from "../src/property";
import { replayFailure } from "../src/replay";
import { integer, arrayOf } from "../src/gen";

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `pbt-test-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("failure persists generation parameters and shrink trace to disk", () => {
  const dir = tmpDir();
  try {
    const check = (n: number) => n < 10;
    const result = runProperty("persist/int", integer(0, 100), check, {
      seed: 777,
      runs: 100,
      failureDir: dir,
    });
    assert.equal(result.ok, false);

    const file = failureFilePath(dir, "persist/int");
    assert.ok(fs.existsSync(file), "failure record file must exist");

    const record = loadFailureRecord(file);
    assert.equal(record.property, "persist/int");
    assert.equal(record.masterSeed, 777);
    assert.ok(Number.isInteger(record.runSeed), "integer rng state saved");
    assert.ok(Number.isInteger(record.runIndex));
    assert.ok(Array.isArray(record.shrinkTrace));
    assert.ok(record.shrinkTrace.length > 0, "shrink trace saved");
    assert.equal(record.counterexample, 10);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay regenerates the final counterexample and confirms it still fails", () => {
  const dir = tmpDir();
  try {
    const check = (xs: number[]) => !xs.some((x) => x >= 8);
    const gen = arrayOf(integer(0, 50), { maxLength: 6 });
    const result = runProperty("replay/array", gen, check, {
      seed: 31337,
      runs: 300,
      failureDir: dir,
    });
    assert.equal(result.ok, false);
    const record = result.record!;

    const replayed = replayFailure(record, gen, check);
    assert.ok(replayed.reproduced, "final counterexample must still fail");
    assert.ok(replayed.matchesRecord, "regenerated value must match the record");
    assert.deepEqual(replayed.counterexample, [8]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay against a fixed (correct) implementation does not reproduce", () => {
  const dir = tmpDir();
  try {
    const buggy = (n: number) => n < 20;
    const gen = integer(0, 100);
    const result = runProperty("replay/fixed", gen, buggy, {
      seed: 55,
      runs: 100,
      failureDir: dir,
    });
    assert.equal(result.ok, false);

    const correct = (n: number) => n <= 100; // every generated value passes
    const replayed = replayFailure(result.record!, gen, correct);
    assert.equal(replayed.reproduced, false);
    assert.ok(replayed.matchesRecord);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replaying a record loaded from disk equals replaying the in-memory record", () => {
  const dir = tmpDir();
  try {
    const check = (n: number) => n % 2 === 1 || n < 4;
    const gen = integer(0, 30);
    const result = runProperty("replay/disk", gen, check, {
      seed: 8,
      runs: 100,
      failureDir: dir,
    });
    const fromDisk: FailureRecord = loadFailureRecord(
      failureFilePath(dir, "replay/disk")
    );
    const a = replayFailure(result.record!, gen, check);
    const b = replayFailure(fromDisk, gen, check);
    assert.deepEqual(a, b);
    assert.ok(a.reproduced);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
