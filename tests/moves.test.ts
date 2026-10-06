import { test } from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { Board } from "../src/board.ts";
import { applyAction, generateActions, simulate } from "../src/moves.ts";
import type { Action, BoardSpec } from "../src/types.ts";

const base: BoardSpec = {
  width: 3,
  height: 3,
  player: [1, 1],
  enemies: [],
  directionsA: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};

test("steps are generated only into free cells", () => {
  const board = new Board({ ...base, player: [0, 0] });
  const steps = generateActions(board, board.initialState()).filter((a) => a.kind === "step");
  deepEqual(
    steps.map((s) => s.to),
    [[1, 0], [0, 1]]
  );
});

test("push moves obstacle and player; blocked push is not generated", () => {
  const board = new Board({ ...base, width: 3, height: 1, player: [0, 0], obstacles: [[1, 0]] });
  const s0 = board.initialState();
  const pushes = generateActions(board, s0).filter((a) => a.kind === "push");
  equal(pushes.length, 1);
  const s1 = applyAction(board, s0, pushes[0] as Action);
  deepEqual(s1.player, [1, 0]);
  deepEqual(s1.obstacles, [[2, 0]]);
  const pushes2 = generateActions(board, s1).filter((a) => a.kind === "push");
  equal(pushes2.length, 0);
});

test("jump needs enemy midway and free landing", () => {
  const board = new Board({
    ...base,
    width: 4,
    height: 1,
    player: [0, 0],
    enemies: [[1, 0]],
    obstacles: [[2, 0]],
  });
  const jumps = generateActions(board, board.initialState()).filter((a) => a.kind === "jump");
  equal(jumps.length, 0);
});

test("jump removes the jumped enemy", () => {
  const board = new Board({ ...base, width: 4, height: 1, player: [0, 0], enemies: [[1, 0]] });
  const jump = generateActions(board, board.initialState()).find((a) => a.kind === "jump");
  ok(jump);
  const s1 = applyAction(board, board.initialState(), jump as Action);
  deepEqual(s1.player, [2, 0]);
  deepEqual(s1.enemies, []);
});

test("landing on toggle flips direction set; once mode disarms", () => {
  const spec: BoardSpec = {
    ...base,
    width: 3,
    height: 1,
    player: [0, 0],
    toggle: [1, 0],
    toggleOnce: true,
    directionsA: [[1, 0]],
    directionsB: [[-1, 0]],
  };
  const board = new Board(spec);
  const s0 = board.initialState();
  const step = generateActions(board, s0).find((a) => a.kind === "step") as Action;
  const s1 = applyAction(board, s0, step);
  equal(s1.phase, 1);
  equal(s1.toggleArmed, false);
  const back = generateActions(board, s1).find((a) => a.kind === "step") as Action;
  const s2 = applyAction(board, s1, back);
  equal(s2.phase, 1);
});

test("simulate rejects illegal actions", () => {
  const board = new Board(base);
  throws(() => simulate(board, [{ kind: "step", dir: [0, 1], to: [1, 3] }]), /illegal action/);
});
