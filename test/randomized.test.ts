import test from "node:test";
import { Monitor } from "../src/monitor.ts";
import { tickScan, assertSweepMatchesTicks } from "./tick-model.ts";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVICES = ["A", "B", "C", "D", "E"];
const HORIZON = 24;
const KS = [1, 2, 3];

function crossCheck(monitor: Monitor): void {
  const records = tickScan(
    monitor.snapshotIntervals(),
    monitor.snapshotDeps(),
    monitor.knownServices(),
    0,
    HORIZON,
  );
  for (const k of KS) {
    assertSweepMatchesTicks(monitor.getSegments(k), records, k);
  }
}

function runScenario(seed: number, steps: number): void {
  const random = mulberry32(seed);
  const monitor = new Monitor();
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const liveIntervalIds: number[] = [];
  const liveDeps: Array<[string, string]> = [];

  for (let step = 0; step < steps; step++) {
    monitor.transact(() => {
      const ops = 1 + Math.floor(random() * 3);
      for (let op = 0; op < ops; op++) {
        const kind = random();
        if (kind < 0.4 || liveIntervalIds.length === 0) {
          const service = pick(SERVICES);
          const start = Math.floor(random() * (HORIZON - 2));
          const end = start + 1 + Math.floor(random() * (HORIZON - 1 - start));
          liveIntervalIds.push(monitor.addInterval(service, start, end));
        } else if (kind < 0.6) {
          const index = Math.floor(random() * liveIntervalIds.length);
          const [id] = liveIntervalIds.splice(index, 1);
          monitor.removeInterval(id!);
        } else if (kind < 0.8) {
          const from = pick(SERVICES);
          const to = pick(SERVICES);
          monitor.addDependency(from, to);
          liveDeps.push([from, to]);
        } else if (liveDeps.length > 0) {
          const index = Math.floor(random() * liveDeps.length);
          const dep = liveDeps.splice(index, 1)[0]!;
          monitor.removeDependency(dep[0], dep[1]);
        }
      }
    });
    crossCheck(monitor);
  }
}

for (const seed of [1, 7, 42, 1337, 20261006]) {
  test(`randomized interval+dependency churn matches per-tick model (seed ${seed})`, () => {
    runScenario(seed, 40);
  });
}

test("randomized pure-interval churn matches per-tick model (seed 99)", () => {
  const random = mulberry32(99);
  const monitor = new Monitor();
  const live: number[] = [];
  for (let step = 0; step < 60; step++) {
    if (live.length === 0 || random() < 0.6) {
      const service = SERVICES[Math.floor(random() * SERVICES.length)]!;
      const start = Math.floor(random() * (HORIZON - 1));
      const end = start + 1 + Math.floor(random() * (HORIZON - 1 - start));
      live.push(monitor.addInterval(service, start, end));
    } else {
      const index = Math.floor(random() * live.length);
      const [id] = live.splice(index, 1);
      monitor.removeInterval(id!);
    }
    crossCheck(monitor);
  }
});
