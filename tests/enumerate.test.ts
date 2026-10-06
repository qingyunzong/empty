import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { Board } from "../src/board.ts";
import { bruteForce, enumerateAll } from "../src/enumerate.ts";
import { simulate } from "../src/moves.ts";
import { LimitExceededError, Solver } from "../src/search.ts";
import type { BoardSpec, Vec } from "../src/types.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_DIRS: Vec[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

function randomSpec(rng: () => number): BoardSpec {
  const width = 3 + Math.floor(rng() * 2);
  const height = 3;
  const cells: Vec[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) cells.push([x, y]);
  }
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = cells[i] as Vec;
    cells[i] = cells[j] as Vec;
    cells[j] = tmp;
  }
  let cursor = 0;
  const take = (): Vec => {
    const c = cells[cursor] as Vec;
    cursor += 1;
    return c;
  };
  const player = take();
  const enemies = Array.from({ length: 1 + Math.floor(rng() * 2) }, take);
  const obstacles = Array.from({ length: Math.floor(rng() * 2) }, take);
  const walls = Array.from({ length: Math.floor(rng() * 2) }, take);
  const toggle = rng() < 0.5 ? take() : null;
  const pickDirs = (): Vec[] => {
    const n = 1 + Math.floor(rng() * 3);
    const out: Vec[] = [];
    while (out.length < n) {
      const d = ALL_DIRS[Math.floor(rng() * ALL_DIRS.length)] as Vec;
      if (!out.some((o) => o[0] === d[0] && o[1] === d[1])) out.push(d);
    }
    return out;
  };
  return {
    width,
    height,
    player,
    enemies,
    obstacles,
    walls,
    toggle,
    toggleOnce: rng() < 0.5,
    directionsA: pickDirs(),
    directionsB: rng() < 0.5 ? pickDirs() : undefined,
  };
}

test("solver matches full-state enumeration and brute force on tiny boards", () => {
  const rng = mulberry32(20261006);
  let checked = 0;
  let skipped = 0;
  for (let i = 0; i < 40 && checked < 20; i += 1) {
    const spec = randomSpec(rng);
    const board = new Board(spec);
    const result = new Solver(board).solve();

    const sim = simulate(board, result.actions);
    equal(sim.captures, result.captures, `replay mismatch on puzzle ${i}`);
    deepEqual(sim.landings, result.landings);

    const enumeration = enumerateAll(board);
    equal(result.captures, enumeration.maxCaptures, `enumeration mismatch on puzzle ${i}`);

    try {
      const brute = bruteForce(board, 300_000);
      equal(result.captures, brute.captures, `brute force captures mismatch on puzzle ${i}`);
      deepEqual(result.landings, brute.landings, `brute force landings mismatch on puzzle ${i}`);
      checked += 1;
    } catch (err) {
      if (err instanceof LimitExceededError) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }
  ok(checked >= 10, `too few puzzles cross-checked (checked=${checked}, skipped=${skipped})`);
});

test("enumeration counts every reachable state exactly once", () => {
  const board = new Board({
    width: 3,
    height: 3,
    player: [0, 0],
    enemies: [[2, 2]],
    obstacles: [[1, 1]],
    toggle: [0, 2],
    directionsA: [[1, 0]],
    directionsB: [[0, 1]],
  });
  const { stateCount, maxCaptures } = enumerateAll(board);
  ok(stateCount > 0);
  const result = new Solver(board).solve();
  equal(result.captures, maxCaptures);
});
