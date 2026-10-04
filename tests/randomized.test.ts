import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AsyncEngine, IncrementalEngine } from "../src/engine.js";
import { fullCompile } from "../src/fullModel.js";
import { Rng, makeSource, tweakDeps, tweakIface, tweakImpl } from "./helpers.js";

interface World {
  sources: Map<string, string>;
  nextId: number;
}

function applyRandomEdit(
  engine: IncrementalEngine,
  world: World,
  rng: Rng,
): void {
  const names = [...world.sources.keys()];
  const roll = rng.int(100);
  if (roll < 40 && names.length > 0) {
    const name = rng.pick(names);
    const source = tweakImpl(world.sources.get(name)!, rng);
    world.sources.set(name, source);
    engine.setModule(name, source);
  } else if (roll < 65 && names.length > 0) {
    const name = rng.pick(names);
    const source = tweakIface(world.sources.get(name)!, rng);
    world.sources.set(name, source);
    engine.setModule(name, source);
  } else if (roll < 85 && names.length > 0) {
    const name = rng.pick(names);
    const source = tweakDeps(world.sources.get(name)!, name, names, rng);
    world.sources.set(name, source);
    engine.setModule(name, source);
  } else if (roll < 95) {
    const name = `m${world.nextId}`;
    world.nextId += 1;
    const source = makeSource(rng, name, [...world.sources.keys(), name]);
    world.sources.set(name, source);
    engine.setModule(name, source);
  } else if (names.length > 1) {
    const name = rng.pick(names);
    world.sources.delete(name);
    engine.removeModule(name);
  }
}

function assertMatchesFullModel(engine: IncrementalEngine, world: World): void {
  assert.deepEqual(engine.artifactSnapshot(), fullCompile(world.sources));
}

function freshWorld(rng: Rng, size: number): World {
  const world: World = { sources: new Map(), nextId: size };
  const names = Array.from({ length: size }, (_, i) => `m${i}`);
  for (const name of names) {
    world.sources.set(name, makeSource(rng, name, names));
  }
  return world;
}

describe("randomized edits cross-checked against the full-compilation model", () => {
  test("synchronous incremental engine", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rng = new Rng(seed);
      const world = freshWorld(rng, 8);
      const engine = new IncrementalEngine();
      for (const [name, source] of world.sources) engine.setModule(name, source);
      engine.update();
      assertMatchesFullModel(engine, world);

      for (let step = 0; step < 60; step += 1) {
        applyRandomEdit(engine, world, rng);
        engine.update();
        assertMatchesFullModel(engine, world);
      }
    }
  });

  test("async engine with interleaved edits and stale baselines", () => {
    let totalStale = 0;
    for (let seed = 100; seed < 115; seed += 1) {
      const rng = new Rng(seed);
      const world = freshWorld(rng, 8);
      const engine = new AsyncEngine();
      for (const [name, source] of world.sources) engine.setModule(name, source);
      engine.settle();
      assertMatchesFullModel(engine, world);

      for (let step = 0; step < 80; step += 1) {
        applyRandomEdit(engine, world, rng);
        const action = rng.int(3);
        if (action === 0) {
          // Partial progress only: later edits may invalidate queued tasks.
          engine.schedule();
          engine.completeNext();
        } else if (action === 1) {
          engine.settle();
          assertMatchesFullModel(engine, world);
        }
        // action 2: keep editing without running any task.
      }
      engine.settle();
      assertMatchesFullModel(engine, world);
      totalStale += engine.staleTasks.length;
    }
    assert.ok(totalStale > 0, "expected the interleaving to produce stale tasks");
  });
});
