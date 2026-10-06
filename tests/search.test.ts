import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Board } from "../src/board.ts";
import { buildCertificate, verifyCertificate } from "../src/certificate.ts";
import { simulate } from "../src/moves.ts";
import { Solver, staticUpperBound } from "../src/search.ts";
import type { BoardSpec } from "../src/types.ts";

const ORTHO_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][];

function solve(spec: BoardSpec) {
  const board = new Board(spec);
  const result = new Solver(board).solve();
  const cert = buildCertificate(board, result);
  return { board, result, cert };
}

test("chain jumps capture a line of enemies", () => {
  const { result, cert, board } = solve({
    width: 6,
    height: 3,
    player: [0, 1],
    enemies: [[1, 1], [3, 1]],
    directionsA: ORTHO_DIRS,
  });
  equal(result.captures, 2);
  deepEqual(result.landings, [[0, 1], [2, 1]]);
  ok(verifyCertificate(board, cert).ok);
});

test("tie-break picks lexicographically smallest landing sequence", () => {
  const { result } = solve({
    width: 5,
    height: 5,
    player: [2, 2],
    enemies: [[1, 2], [3, 2]],
    directionsA: [[1, 0], [-1, 0]],
  });
  equal(result.captures, 2);
  deepEqual(result.landings, [[0, 2], [2, 2]]);
});

test("toggle unlocks a direction set needed for the capture", () => {
  const spec: BoardSpec = {
    width: 5,
    height: 5,
    player: [0, 4],
    enemies: [[0, 3]],
    toggle: [1, 4],
    directionsA: [[1, 0]],
    directionsB: [[1, 0], [0, -1]],
  };
  const { result } = solve(spec);
  equal(result.captures, 1);
  deepEqual(result.landings, [[0, 2]]);
  const without = solve({ ...spec, toggle: null });
  equal(without.result.captures, 0);
});

test("toggle can remove previously available jumps", () => {
  const spec: BoardSpec = {
    width: 5,
    height: 1,
    player: [0, 0],
    enemies: [[1, 0], [3, 0]],
    toggle: [2, 0],
    toggleOnce: true,
    directionsA: [[1, 0]],
    directionsB: [[0, 1]],
  };
  const withToggle = solve(spec);
  equal(withToggle.result.captures, 1);
  const without = solve({ ...spec, toggle: null });
  equal(without.result.captures, 2);
});

test("pushing an obstacle clears a landing cell", () => {
  const { result } = solve({
    width: 5,
    height: 3,
    player: [0, 1],
    enemies: [[1, 1]],
    obstacles: [[2, 1]],
    directionsA: ORTHO_DIRS,
  });
  equal(result.captures, 1);
  deepEqual(result.landings, [[0, 1]]);
  ok(result.actions.some((a) => a.kind === "push"));
});

test("safety upper bound excludes geometrically uncapturable enemies", () => {
  const board = new Board({
    width: 3,
    height: 3,
    player: [2, 2],
    enemies: [[0, 0], [1, 1]],
    directionsA: [[1, 0], [0, 1]],
  });
  equal(staticUpperBound(board, board.initialState()), 1);
  const result = new Solver(board).solve();
  equal(result.captures, 1);
  const sim = simulate(board, result.actions);
  equal(sim.captures, 1);
});

test("walls block movement and jumps", () => {
  const { result } = solve({
    width: 4,
    height: 1,
    player: [0, 0],
    enemies: [[1, 0]],
    walls: [[2, 0]],
    directionsA: ORTHO_DIRS,
  });
  equal(result.captures, 0);
});

test("certificate verifies and replays to the same final state", () => {
  const { board, cert } = solve({
    width: 5,
    height: 5,
    player: [0, 0],
    enemies: [[1, 0], [3, 0], [0, 2]],
    obstacles: [[4, 4]],
    toggle: [2, 2],
    directionsA: ORTHO_DIRS,
    directionsB: [[1, 1], [-1, -1]],
  });
  const check = verifyCertificate(board, cert);
  deepEqual(check.problems, []);
  ok(check.ok);
  ok(cert.optimal <= cert.safetyUpperBound);
});
