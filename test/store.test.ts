import { deepEqual, equal } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WeightedDag, type DagNode } from "../src/dag.js";
import { RankEngine } from "../src/engine.js";
import { loadSnapshot, saveSnapshot } from "../src/store.js";

const NODES: Record<string, DagNode> = {
  a: { kind: "source" },
  b: { kind: "source" },
  flag: { kind: "source" },
  base: { kind: "add", deps: ["a", "b"] },
  chosen: { kind: "cond", pick: "flag", then: "base", else: "b" },
};

const OUTPUTS: Record<string, number> = { chosen: 7, base: 3 };

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "weighted-rank-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("snapshot round-trips through the persistent index", () => {
  withTempDir((dir) => {
    const path = join(dir, "index.json");
    const engine = new RankEngine(new WeightedDag(NODES), OUTPUTS, { a: 1, b: 2, flag: 1 });
    engine.setSources({ a: 5 });
    const snapshot = engine.snapshot();
    saveSnapshot(path, snapshot);
    deepEqual(loadSnapshot(path), snapshot);
  });
});

test("recovery after a failed write returns the same committed snapshot", () => {
  withTempDir((dir) => {
    const path = join(dir, "index.json");
    const engine = new RankEngine(new WeightedDag(NODES), OUTPUTS, { a: 1, b: 2, flag: 1 });
    saveSnapshot(path, engine.snapshot());

    // Simulate a crash mid-write: partial tmp file, rename never happened.
    writeFileSync(`${path}.tmp`, '{"generation": 2, "sources": {"a":');
    deepEqual(loadSnapshot(path), engine.snapshot(), "committed snapshot must survive");

    // The index keeps working after the failed write.
    engine.setSources({ b: 9 });
    saveSnapshot(path, engine.snapshot());
    deepEqual(loadSnapshot(path), engine.snapshot());
  });
});

test("restored engine reproduces the exact snapshot state", () => {
  withTempDir((dir) => {
    const path = join(dir, "index.json");
    const engine = new RankEngine(new WeightedDag(NODES), OUTPUTS, { a: 1, b: 2, flag: 1 });
    engine.setSources({ a: 4, flag: 0 });
    saveSnapshot(path, engine.snapshot());
    const savedView = engine.read();

    // Mutate well past the saved point, then recover from disk.
    engine.setSources({ a: 100, b: 200, flag: 1 });
    engine.setSources({ a: 0 });
    const recovered = loadSnapshot(path);
    engine.restore(recovered as NonNullable<typeof recovered>);

    const view = engine.read();
    equal(view.generation, savedView.generation);
    deepEqual([...view.weights.entries()], [...savedView.weights.entries()]);
    deepEqual(view.scores, savedView.scores);

    // And it matches a fresh engine built from the recovered snapshot.
    const fresh = new RankEngine(
      new WeightedDag(NODES),
      (recovered as NonNullable<typeof recovered>).outputs,
      (recovered as NonNullable<typeof recovered>).sources,
    );
    deepEqual(view.scores, fresh.read().scores);
  });
});

test("loading a missing index returns null", () => {
  withTempDir((dir) => {
    equal(loadSnapshot(join(dir, "absent.json")), null);
  });
});
