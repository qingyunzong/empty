import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorruptSnapshotError, SnapshotStore } from "../src/persistence";
import { PersistedState } from "../src/engine";
import { naivePercentiles, sortingPercentiles, WeightedItem } from "../src/model";
import { assertScoresClose, buildLibrary } from "./helpers";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ranklib-"));
}

function itemsOf(state: PersistedState): WeightedItem[] {
  const weights = new Map(state.weights);
  return state.observations.map(([id, o]) => ({
    id,
    value: o.value,
    weight: weights.get(o.weightNode)!,
  }));
}

test("recovery after failure restores the same snapshot", () => {
  const dir = freshDir();
  const store = new SnapshotStore<PersistedState>(dir);

  const original = buildLibrary();
  original.commit([]);
  original.commit([["base", 9], ["bonus", 3], ["mode", 0]]);
  const before = original.getSnapshot();
  store.save(original.exportState());
  // simulate failure: the original instance is abandoned entirely

  const loaded = store.load();
  assert.ok(loaded !== null);
  const recovered = buildLibrary();
  const restored = recovered.restoreState(loaded);

  assert.equal(restored.generation, before.generation);
  assert.deepEqual(restored.sources, before.sources);
  assert.deepEqual(restored.weights, before.weights);
  assert.deepEqual(restored.scores, before.scores);

  // full DAG evaluation cross-check on the recovered sources
  assert.deepEqual(recovered.evaluateWeightsWithModel(), restored.weights);
  // sorting model cross-check on the recovered observations
  assertScoresClose(restored.scores, sortingPercentiles(itemsOf(loaded)));
  assertScoresClose(restored.scores, naivePercentiles(itemsOf(loaded)));

  // the recovered library keeps accepting commits from the same generation
  const next = recovered.commit([["base", 1]]);
  assert.equal(next.generation, before.generation + 1);
});

test("a torn temporary file from a crashed write is ignored", () => {
  const dir = freshDir();
  const store = new SnapshotStore<PersistedState>(dir);
  const lib = buildLibrary();
  lib.commit([]);
  store.save(lib.exportState());
  // simulate a crash in the middle of the next save
  writeFileSync(join(dir, "snapshot.json.tmp"), '{"payload":"{ truncated');
  const loaded = store.load();
  assert.ok(loaded !== null);
  assert.equal(loaded.generation, 1);
});

test("corrupted committed snapshot is detected via checksum", () => {
  const dir = freshDir();
  const store = new SnapshotStore<PersistedState>(dir);
  const lib = buildLibrary();
  lib.commit([]);
  store.save(lib.exportState());
  const file = join(dir, "snapshot.json");
  const envelope = JSON.parse(readFileSync(file, "utf8")) as { payload: string; checksum: string };
  envelope.payload = envelope.payload.replace(/"generation":\d+/, '"generation":999');
  writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => store.load(), CorruptSnapshotError);
});

test("loading from an empty directory returns null", () => {
  const store = new SnapshotStore<PersistedState>(freshDir());
  assert.equal(store.load(), null);
});
