import test from "node:test";
import assert from "node:assert/strict";
import { DiagnosticStore, type DiagnosticReport } from "../src/diagnostics.js";
import { FullSetModel } from "./model.js";

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

const SOURCES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const STAGES = ["parse", "resolve", "typecheck", "lint", "emit"];
const CODES = ["E001", "E002", "E003"];
const CAUSES = ["syntax", "undefined-name", "type-mismatch", "unused"];
const RANGES = [
  { start: 0, end: 4 },
  { start: 4, end: 9 },
  { start: 9, end: 10 },
  { start: 10, end: 10 },
  { start: 20, end: 25 },
];

function randomReport(rand: () => number): DiagnosticReport {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const code = pick(CODES);
  const cause = pick(CAUSES);
  return {
    sourceId: pick(SOURCES),
    stage: pick(STAGES),
    code,
    message: `message for ${code}`,
    cause,
    range: pick(RANGES),
  };
}

test("random report/withdraw sequences match the full-set model", () => {
  const seeds = [1, 7, 42, 1337, 20261005];
  for (const seed of seeds) {
    const rand = mulberry32(seed);
    const store = new DiagnosticStore();
    const model = new FullSetModel();
    for (let op = 0; op < 2000; op++) {
      if (rand() < 0.65) {
        const r = randomReport(rand);
        store.report(r);
        model.report(r);
      } else {
        const sourceId = SOURCES[Math.floor(rand() * SOURCES.length)]!;
        store.withdrawSource(sourceId);
        model.withdrawSource(sourceId);
      }
      assert.deepEqual(
        store.diagnostics(),
        model.diagnostics(),
        `seed=${seed} diverged after op ${op}`,
      );
    }
  }
});

test("randomized interleavings are deterministic per seed", () => {
  const run = (seed: number) => {
    const rand = mulberry32(seed);
    const store = new DiagnosticStore();
    for (let op = 0; op < 500; op++) {
      if (rand() < 0.7) store.report(randomReport(rand));
      else store.withdrawSource(SOURCES[Math.floor(rand() * SOURCES.length)]!);
    }
    return store.diagnostics();
  };
  assert.deepEqual(run(99), run(99));
});
