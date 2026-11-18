import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MISS,
  MemoryL1Store,
  MemoryL2Store,
  MultiLevelCache,
  type LookupResult,
} from "../src/index.js";
import {
  ControlledLoader,
  VirtualClock,
  flushMicrotasks,
} from "./helpers.js";
import { NaiveCacheModel, type ModelLookup } from "./reference-model.js";

type Action =
  | { readonly kind: "get"; readonly key: string; readonly burst?: number }
  | { readonly kind: "invalidate"; readonly key: string }
  | { readonly kind: "resolve"; readonly key: string; readonly found: boolean }
  | { readonly kind: "advance"; readonly ms: number };

interface Comparison {
  readonly real: Promise<LookupResult<string>>;
  readonly expected: Promise<ModelLookup<string>>;
  readonly where: string;
}

const TTL_MS = 100;
const NEGATIVE_TTL_MS = 40;

function describeAction(action: Action): string {
  switch (action.kind) {
    case "get":
      return `get(${action.key}${action.burst === undefined ? "" : `x${action.burst}`})`;
    case "invalidate":
      return `invalidate(${action.key})`;
    case "resolve":
      return `resolve(${action.key}:${action.found ? "value" : "missing"})`;
    case "advance":
      return `advance(${action.ms})`;
  }
}

function* sequences(
  alphabet: readonly Action[],
  depth: number,
  prefix: Action[] = [],
): Generator<Action[]> {
  if (depth === 0) {
    yield prefix;
    return;
  }
  for (const action of alphabet) {
    yield* sequences(alphabet, depth - 1, [...prefix, action]);
  }
}

async function runScenario(actions: readonly Action[]): Promise<void> {
  const clock = new VirtualClock();
  const loader = new ControlledLoader<string>();
  const l1 = new MemoryL1Store<string, string>();
  const l2 = new MemoryL2Store<string, string>();
  const cache = new MultiLevelCache<string, string>({
    loader: loader.load,
    ttlMs: TTL_MS,
    negativeTtlMs: NEGATIVE_TTL_MS,
    now: clock.now,
    l1,
    l2,
  });
  const model = new NaiveCacheModel<string, string>({
    ttlMs: TTL_MS,
    negativeTtlMs: NEGATIVE_TTL_MS,
    now: clock.now,
  });
  const keys = ["a", "b"];
  const comparisons: Comparison[] = [];
  const where = actions.map(describeAction).join(" -> ");

  for (const action of actions) {
    switch (action.kind) {
      case "get": {
        const burst = action.burst ?? 1;
        for (let index = 0; index < burst; index += 1) {
          comparisons.push({
            real: cache.getDetailed(action.key),
            expected: model.beginGet(action.key),
            where: `${where} [request ${index + 1}]`,
          });
          // Stable point: the request has either resolved from a cache level
          // or registered itself with the loader/single-flight group.
          await flushMicrotasks();
        }
        break;
      }
      case "invalidate": {
        const realInvalidation = cache.invalidate(action.key);
        model.invalidate(action.key);
        await realInvalidation;
        break;
      }
      case "resolve": {
        const realCount = loader.resolveWith(action.key, (id) =>
          action.found ? `${action.key}#${id}` : MISS,
        );
        const modelCount = model.completeLoads(action.key, action.found);
        assert.equal(
          realCount,
          modelCount,
          `${where}: pending load count for ${action.key}`,
        );
        await flushMicrotasks();
        break;
      }
      case "advance": {
        clock.advance(action.ms);
        await flushMicrotasks();
        break;
      }
    }
  }

  // Release any load that was still in flight at the end of the trace.
  let remaining = loader.pendingKeys();
  while (remaining.length > 0) {
    for (const key of remaining) {
      const realCount = loader.resolveWith(key, (id) => `${key}#${id}`);
      const modelCount = model.completeLoads(key, true);
      assert.equal(
        realCount,
        modelCount,
        `${where}: trailing pending load count for ${key}`,
      );
    }
    await flushMicrotasks();
    remaining = loader.pendingKeys();
  }

  for (const comparison of comparisons) {
    const [real, expected] = await Promise.all([
      comparison.real,
      comparison.expected,
    ]);
    assert.equal(real.source, expected.source, `${comparison.where}: source`);
    assert.equal(real.value, expected.value, `${comparison.where}: value`);
    assert.equal(
      real.negative,
      expected.negative,
      `${comparison.where}: negative`,
    );
  }

  for (const key of keys) {
    assert.deepEqual(l1.get(key), model.l1.get(key), `${where}: L1 ${key}`);
    assert.deepEqual(l2.get(key), model.l2.get(key), `${where}: L2 ${key}`);
    assert.equal(
      cache.statsFor(key).loads,
      model.loadsFor(key),
      `${where}: loads for ${key}`,
    );
    assert.equal(
      l2.writesFor(key),
      model.writesFor(key),
      `${where}: L2 writes for ${key}`,
    );
  }
}

describe("exhaustive concurrent schedules", () => {
  it("matches the naive model for every one-key schedule of length four", async () => {
    const alphabet: Action[] = [
      { kind: "get", key: "a" },
      { kind: "get", key: "a", burst: 3 },
      { kind: "invalidate", key: "a" },
      { kind: "resolve", key: "a", found: true },
      { kind: "resolve", key: "a", found: false },
      { kind: "advance", ms: 30 },
      { kind: "advance", ms: 70 },
    ];
    let count = 0;
    for (const actions of sequences(alphabet, 4)) {
      await runScenario(actions);
      count += 1;
    }
    assert.equal(count, 7 ** 4);
  });

  it("matches the naive model for every two-key schedule of length three", async () => {
    const alphabet: Action[] = [
      { kind: "get", key: "a" },
      { kind: "get", key: "a", burst: 3 },
      { kind: "get", key: "b" },
      { kind: "invalidate", key: "a" },
      { kind: "invalidate", key: "b" },
      { kind: "resolve", key: "a", found: true },
      { kind: "resolve", key: "a", found: false },
      { kind: "resolve", key: "b", found: true },
      { kind: "resolve", key: "b", found: false },
      { kind: "advance", ms: 30 },
    ];
    let count = 0;
    for (const actions of sequences(alphabet, 3)) {
      await runScenario(actions);
      count += 1;
    }
    assert.equal(count, 10 ** 3);
  });

  it("matches the naive model through a long invalidation/refetch interleaving", async () => {
    await runScenario([
      { kind: "get", key: "a" },
      { kind: "get", key: "b", burst: 3 },
      { kind: "resolve", key: "a", found: true },
      { kind: "invalidate", key: "b" },
      { kind: "get", key: "b" },
      { kind: "resolve", key: "b", found: false },
      { kind: "invalidate", key: "a" },
      { kind: "get", key: "a", burst: 3 },
      { kind: "resolve", key: "b", found: true },
      { kind: "resolve", key: "a", found: true },
      { kind: "advance", ms: 30 },
      { kind: "invalidate", key: "a" },
      { kind: "get", key: "a" },
      { kind: "resolve", key: "a", found: false },
      { kind: "advance", ms: 30 },
      { kind: "get", key: "a" },
      { kind: "advance", ms: 30 },
      { kind: "get", key: "b" },
      { kind: "invalidate", key: "b" },
      { kind: "resolve", key: "b", found: true },
      { kind: "get", key: "b" },
      { kind: "resolve", key: "b", found: false },
    ]);
  });
});
