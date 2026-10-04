import { describe, test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { RankingEngine } from "../src/engine.js";

function teams(engine: RankingEngine): string[] {
  return engine.getStandings().map((entry) => entry.team);
}

describe("tie-breaking", () => {
  test("head-to-head mini-league points decide a two-team tie", () => {
    const engine = new RankingEngine();
    // X and Y both finish on 3 points; X won the direct encounter.
    engine.recordResult("m1", "X", "Y", 1, 0);
    engine.recordResult("m2", "Z", "X", 2, 0);
    engine.recordResult("m3", "Y", "W", 2, 0);
    // Z: 3, X: 3, Y: 3, W: 0 -> among {Z, X, Y}: Z beat X, X beat Y, Y beat nobody in group...
    // Y's win is over W (outside the group), so mini-league: Z 3, X 3, Y 0.
    deepEqual(teams(engine), ["Z", "X", "Y", "W"]);
  });

  test("mini-league differential breaks a full cycle, recursion resolves the rest", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "A", "B", 2, 1);
    engine.recordResult("m2", "C", "A", 1, 0);
    engine.recordResult("m3", "B", "D", 1, 0);
    engine.recordResult("m4", "D", "C", 2, 0);
    // All four on 3 points. Mini-league points all 3 -> differential:
    // D +1, A 0, B 0, C -1. {A, B} still tied -> recurse: A beat B directly.
    deepEqual(teams(engine), ["D", "A", "B", "C"]);
    const standings = engine.getStandings();
    equal(standings[0]!.diff, 1);
    equal(standings[3]!.diff, -1);
  });

  test("three-team cycle broken by mini-league differential", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "X", "Y", 1, 0);
    engine.recordResult("m2", "Z", "X", 5, 0);
    engine.recordResult("m3", "Y", "Z", 2, 1);
    // Cycle: X>Y, Z>X, Y>Z, all 3 points. Differentials: Z +4, Y 0, X -4.
    deepEqual(teams(engine), ["Z", "Y", "X"]);
  });

  test("no progress from either rule falls back to team id", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "bravo", "alpha", 1, 1);
    // Identical stats, identical mini-league -> id ascending.
    deepEqual(teams(engine), ["alpha", "bravo"]);
  });

  test("recursive no-progress falls back to id within the subgroup", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "q", "p3", 1, 0);
    engine.recordResult("m2", "q", "p1", 1, 0);
    engine.recordResult("m3", "q", "p2", 1, 0);
    engine.recordResult("m4", "p2", "p1", 0, 0);
    engine.recordResult("m5", "p3", "p2", 0, 0);
    engine.recordResult("m6", "p1", "p3", 0, 0);
    // p1/p2/p3 all on 2 points, all draws among themselves -> id order.
    deepEqual(teams(engine), ["q", "p1", "p2", "p3"]);
  });

  test("recursion re-evaluates the subgroup on its own mini-league", () => {
    const engine = new RankingEngine();
    // D sweeps the group; A/B/C form a cycle decided only after D is removed.
    engine.recordResult("m1", "D", "A", 1, 0);
    engine.recordResult("m2", "D", "B", 1, 0);
    engine.recordResult("m3", "D", "C", 1, 0);
    engine.recordResult("m4", "A", "B", 3, 0);
    engine.recordResult("m5", "B", "C", 3, 0);
    engine.recordResult("m6", "C", "A", 1, 0);
    // D on 9 points; A/B/C tied on 3. Their mini-league: each 3 points;
    // differentials: A +2, B 0, C -2.
    deepEqual(teams(engine), ["D", "A", "B", "C"]);
  });
});
