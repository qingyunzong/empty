import assert from "node:assert/strict";
import { RankedLibrary } from "../src/engine";

/** Deterministic PRNG so randomized tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function assertClose(actual: number, expected: number, tol = 1e-9, message = ""): void {
  const scale = Math.max(1, Math.abs(expected));
  if (!(Math.abs(actual - expected) <= tol * scale)) {
    assert.fail(`expected ${actual} ~= ${expected} (tol ${tol}) ${message}`);
  }
}

export function assertScoresClose(
  actual: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  tol = 1e-9
): void {
  assert.equal(actual.size, expected.size, "score map sizes differ");
  for (const [id, p] of expected) {
    const a = actual.get(id);
    assert.ok(a !== undefined, `missing score for id ${id}`);
    assertClose(a, p, tol, `score mismatch for id ${id}`);
  }
}

/** Standard topology shared by the engine and persistence tests. */
export function buildLibrary(): RankedLibrary {
  const lib = new RankedLibrary();
  lib.addSource("base", 4);
  lib.addSource("bonus", 1);
  lib.addSource("mode", 1);
  lib.addNode("w_a", { kind: "derived", deps: ["base", "bonus"], compute: (v) => v[0] + v[1] });
  lib.addNode("w_b", { kind: "derived", deps: ["base"], compute: (v) => v[0] * 2 });
  lib.addNode("w_c", {
    kind: "conditional",
    conditionDeps: ["mode"],
    select: (v) => (v[0] >= 0.5 ? "hi" : "lo"),
    branches: {
      hi: { deps: ["w_a"], compute: (v) => v[0] },
      lo: { deps: ["w_b"], compute: (v) => v[0] * 0.5 },
    },
  });
  lib.addObservation("obs1", 10, "w_a");
  lib.addObservation("obs2", 20, "w_b");
  lib.addObservation("obs3", 30, "w_c");
  return lib;
}
