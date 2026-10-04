import { describe, test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { RankingEngine } from "../src/engine.js";
import type { MatchEvent } from "../src/types.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
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

function replay(events: readonly MatchEvent[]): RankingEngine {
  const engine = new RankingEngine();
  for (const event of events) {
    switch (event.kind) {
      case "result":
        engine.recordResult(event.matchId, event.home, event.away, event.homeScore, event.awayScore);
        break;
      case "cancel":
        engine.cancelMatch(event.matchId);
        break;
      case "correct":
        engine.correctResult(event.matchId, event.homeScore, event.awayScore);
        break;
    }
  }
  return engine;
}

function runFuzz(seed: number, operations: number): void {
  const random = mulberry32(seed);
  const teams = ["T0", "T1", "T2", "T3", "T4", "T5"];
  const engine = new RankingEngine();
  const validIds: string[] = [];
  let nextId = 0;

  const pickTeam = (): string => teams[Math.floor(random() * teams.length)]!;
  const pickScore = (): number => Math.floor(random() * 5);

  for (let op = 0; op < operations; op++) {
    const roll = random();
    if (roll < 0.55 || validIds.length === 0) {
      // record a new result
      const home = pickTeam();
      let away = pickTeam();
      while (away === home) away = pickTeam();
      const id = `m${nextId++}`;
      engine.recordResult(id, home, away, pickScore(), pickScore());
      validIds.push(id);
    } else if (roll < 0.8) {
      // cancel an existing match
      const index = Math.floor(random() * validIds.length);
      const id = validIds.splice(index, 1)[0]!;
      engine.cancelMatch(id);
    } else {
      // correct an existing match
      const id = validIds[Math.floor(random() * validIds.length)]!;
      engine.correctResult(id, pickScore(), pickScore());
    }
    ok(
      engine.verifyAgainstFullRecompute(),
      `seed=${seed} op=${op}: incremental state diverged from full recompute`,
    );
  }

  // The event log alone must be sufficient to reproduce the final standings.
  const replayed = replay(engine.getEvents());
  deepEqual(replayed.getStandings(), engine.getStandings());

  // And the independent full-recompute path must agree on the final table.
  const full = RankingEngine.fullRecompute(engine.getEvents());
  deepEqual(full.standings, engine.getStandings());
}

describe("fuzz: incremental updates vs full recompute", () => {
  for (const seed of [1, 7, 42, 1337, 20261005]) {
    test(`seed ${seed}: 400 random result/cancel/correct operations`, () => {
      runFuzz(seed, 400);
    });
  }
});
