import { describe, test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { RankingEngine } from "../src/engine.js";

describe("engine basics", () => {
  test("computes points and stat lines from results", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "A", "B", 3, 1);
    engine.recordResult("m2", "A", "C", 2, 2);
    engine.recordResult("m3", "C", "B", 1, 0);
    const standings = engine.getStandings();
    deepEqual(
      standings.map((s) => [s.rank, s.team, s.points]),
      [
        [1, "A", 4],
        [2, "C", 4],
        [3, "B", 0],
      ],
    );
    const a = standings[0]!;
    equal(a.played, 2);
    equal(a.won, 1);
    equal(a.drawn, 1);
    equal(a.lost, 0);
    equal(a.scored, 5);
    equal(a.conceded, 3);
    equal(a.diff, 2);
    ok(engine.verifyAgainstFullRecompute());
  });

  test("rejects invalid input", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "A", "B", 1, 0);
    throws(() => engine.recordResult("m1", "A", "C", 1, 0)); // duplicate id
    throws(() => engine.recordResult("m2", "A", "A", 1, 0)); // same team
    throws(() => engine.recordResult("m3", "A", "B", -1, 0)); // negative score
    throws(() => engine.recordResult("m4", "A", "B", 1.5, 0)); // non-integer
    throws(() => engine.cancelMatch("nope"));
    throws(() => engine.correctResult("nope", 1, 0));
    ok(engine.verifyAgainstFullRecompute());
  });
});

describe("cancel and correct", () => {
  test("cancelling a match recomputes the affected teams", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "A", "B", 3, 1);
    engine.recordResult("m2", "A", "C", 2, 2);
    engine.recordResult("m3", "C", "B", 1, 0);

    const { affected } = engine.cancelMatch("m2");
    deepEqual(affected, ["A", "C"]);

    const standings = engine.getStandings();
    deepEqual(
      standings.map((s) => [s.team, s.points, s.played]),
      [
        ["A", 3, 1],
        ["C", 3, 1],
        ["B", 0, 2],
      ],
    );
    const a = standings[0]!;
    equal(a.scored, 3);
    equal(a.conceded, 1);
    ok(engine.verifyAgainstFullRecompute());
  });

  test("correcting a result recomputes the affected teams", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "A", "B", 3, 1);
    engine.recordResult("m2", "A", "C", 2, 2);
    engine.recordResult("m3", "C", "B", 1, 0);

    const { affected } = engine.correctResult("m1", 1, 3);
    deepEqual(affected, ["A", "B"]);

    // B now won m1: C 4 pts (win + draw), B 3 pts, A 1 pt.
    deepEqual(
      engine.getStandings().map((s) => [s.team, s.points]),
      [
        ["C", 4],
        ["B", 3],
        ["A", 1],
      ],
    );
    ok(engine.verifyAgainstFullRecompute());
  });

  test("cancel then re-record then correct stays consistent", () => {
    const engine = new RankingEngine();
    engine.recordResult("m1", "A", "B", 2, 0);
    engine.cancelMatch("m1");
    engine.recordResult("m1", "A", "B", 0, 2);
    engine.correctResult("m1", 1, 1);
    const standings = engine.getStandings();
    deepEqual(
      standings.map((s) => [s.team, s.points, s.played]),
      [
        ["A", 1, 1],
        ["B", 1, 1],
      ],
    );
    ok(engine.verifyAgainstFullRecompute());
  });
});
