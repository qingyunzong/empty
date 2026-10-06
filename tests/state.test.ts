import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { parseStateKey, sortVecs, stateKey } from "../src/state.ts";
import type { State } from "../src/types.ts";

test("state key round-trips", () => {
  const s: State = {
    player: [3, 2],
    enemies: sortVecs([[4, 1], [0, 0], [2, 2]]),
    obstacles: sortVecs([[1, 4], [1, 1]]),
    phase: 1,
    toggleArmed: false,
  };
  deepEqual(parseStateKey(stateKey(s)), s);
});

test("state key is canonical regardless of list order", () => {
  const a: State = {
    player: [0, 0],
    enemies: sortVecs([[2, 1], [1, 1]]),
    obstacles: [],
    phase: 0,
    toggleArmed: true,
  };
  const b: State = { ...a, enemies: sortVecs([[1, 1], [2, 1]]) };
  equal(stateKey(a), stateKey(b));
});
