import { Board, ORTHO, vecKey } from "./board.ts";
import { sortVecs, stateKey } from "./state.ts";
import type { Action, State, Vec } from "./types.ts";

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];

export function generateActions(board: Board, state: State): Action[] {
  const enemySet = new Set(state.enemies.map(vecKey));
  const obsSet = new Set(state.obstacles.map(vecKey));
  const free = (v: Vec): boolean =>
    board.standable(v) && !enemySet.has(vecKey(v)) && !obsSet.has(vecKey(v));

  const actions: Action[] = [];
  for (const d of ORTHO) {
    const to = add(state.player, d);
    if (free(to)) actions.push({ kind: "step", dir: d, to });
  }
  for (const d of ORTHO) {
    const mid = add(state.player, d);
    if (obsSet.has(vecKey(mid))) {
      const beyond = add(mid, d);
      if (free(beyond)) {
        actions.push({ kind: "push", dir: d, to: mid, obstacleFrom: mid, obstacleTo: beyond });
      }
    }
  }
  for (const d of board.dirs[state.phase]) {
    const mid = add(state.player, d);
    if (enemySet.has(vecKey(mid))) {
      const land = add(mid, d);
      if (free(land)) actions.push({ kind: "jump", dir: d, over: mid, to: land });
    }
  }
  return actions;
}

export function applyAction(board: Board, state: State, action: Action): State {
  let player = state.player;
  let enemies = state.enemies;
  let obstacles = state.obstacles;
  if (action.kind === "step") {
    player = action.to;
  } else if (action.kind === "push") {
    player = action.to;
    obstacles = sortVecs(
      state.obstacles.map((o) => (vecKey(o) === vecKey(action.obstacleFrom) ? action.obstacleTo : o))
    );
  } else {
    player = action.to;
    enemies = state.enemies.filter((e) => vecKey(e) !== vecKey(action.over));
  }
  let phase = state.phase;
  let toggleArmed = state.toggleArmed;
  if (board.toggle !== null && toggleArmed && vecKey(player) === vecKey(board.toggle)) {
    phase = (phase ^ 1) as 0 | 1;
    if (board.toggleOnce) toggleArmed = false;
  }
  return { player, enemies, obstacles, phase, toggleArmed };
}

export function actionEquals(a: Action, b: Action): boolean {
  if (a.kind !== b.kind) return false;
  const eq = (x: Vec, y: Vec): boolean => x[0] === y[0] && x[1] === y[1];
  if (!eq(a.dir, b.dir) || !eq(a.to, b.to)) return false;
  if (a.kind === "push" && b.kind === "push") {
    return eq(a.obstacleFrom, b.obstacleFrom) && eq(a.obstacleTo, b.obstacleTo);
  }
  if (a.kind === "jump" && b.kind === "jump") return eq(a.over, b.over);
  return a.kind === "step" && b.kind === "step";
}

export interface SimResult {
  state: State;
  captures: number;
  landings: Vec[];
}

export function simulate(board: Board, actions: Action[], from?: State): SimResult {
  let state = from ?? board.initialState();
  const landings: Vec[] = [];
  let captures = 0;
  for (const a of actions) {
    const legal = generateActions(board, state).some((x) => actionEquals(x, a));
    if (!legal) {
      throw new Error(`illegal action ${JSON.stringify(a)} at state ${stateKey(state)}`);
    }
    state = applyAction(board, state, a);
    if (a.kind === "jump") {
      captures += 1;
      landings.push(a.to);
    }
  }
  return { state, captures, landings };
}
