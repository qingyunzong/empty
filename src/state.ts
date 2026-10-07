import { Action, Direction, Grid, State, posKey } from './types.js';

const DIRS: Record<Direction, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export const DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

/** Bitmask of keys spent on currently open doors. */
export function spentKeys(grid: Grid, state: State): number {
  let spent = 0;
  for (let d = 0; d < grid.doors.length; d++) {
    if (state.openDoors & (1 << d)) spent |= 1 << grid.doors[d]!.keyIndex;
  }
  return spent;
}

/** Bitmask of keys currently held (collected and not spent on an open door). */
export function heldKeys(grid: Grid, state: State): number {
  return state.keys & ~spentKeys(grid, state);
}

export function isGoal(grid: Grid, state: State): boolean {
  return state.x === grid.goal.x && state.y === grid.goal.y;
}

function isAdjacent(x: number, y: number, px: number, py: number): boolean {
  return Math.abs(x - px) + Math.abs(y - py) === 1;
}

/**
 * Applies an action to a state, returning the new immutable state.
 * Throws on any illegal action (wall, closed door, missing key, ...).
 * - move: walks one cell; entering a key cell collects it; closed doors block.
 * - open: opens an adjacent closed door, consuming the matching held key.
 * - undo-open: closes an adjacent open door, refunding the consumed key.
 */
export function applyAction(grid: Grid, state: State, action: Action): State {
  if (action.kind === 'move') {
    const [dx, dy] = DIRS[action.dir];
    const nx = state.x + dx;
    const ny = state.y + dy;
    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) {
      throw new Error(`move ${action.dir} leaves the grid`);
    }
    if (grid.walls[ny * grid.width + nx]) throw new Error(`move ${action.dir} hits a wall`);
    const doorIdx = grid.doorAt.get(posKey(nx, ny));
    if (doorIdx !== undefined && !(state.openDoors & (1 << doorIdx))) {
      throw new Error(`move ${action.dir} blocked by closed door ${doorIdx}`);
    }
    let keys = state.keys;
    const keyIdx = grid.keyAt.get(posKey(nx, ny));
    if (keyIdx !== undefined) keys |= 1 << grid.keys[keyIdx]!.keyIndex;
    return { x: nx, y: ny, keys, openDoors: state.openDoors };
  }

  const door = grid.doors[action.door];
  if (!door) throw new Error(`unknown door ${action.door}`);
  if (!isAdjacent(door.pos.x, door.pos.y, state.x, state.y)) {
    throw new Error(`door ${action.door} is not adjacent to the player`);
  }

  if (action.kind === 'open') {
    if (state.openDoors & (1 << action.door)) throw new Error(`door ${action.door} already open`);
    if (!(heldKeys(grid, state) & (1 << door.keyIndex))) {
      throw new Error(`no held key for door ${action.door}`);
    }
    return { ...state, openDoors: state.openDoors | (1 << action.door) };
  }

  // undo-open: restore the door, refunding the consumed key
  if (!(state.openDoors & (1 << action.door))) throw new Error(`door ${action.door} is not open`);
  return { ...state, openDoors: state.openDoors & ~(1 << action.door) };
}

/** All currently legal actions, in deterministic order. */
export function legalActions(grid: Grid, state: State): Action[] {
  const actions: Action[] = [];
  for (const dir of DIRECTIONS) {
    try {
      applyAction(grid, state, { kind: 'move', dir });
      actions.push({ kind: 'move', dir });
    } catch {
      // illegal move
    }
  }
  for (let d = 0; d < grid.doors.length; d++) {
    const door = grid.doors[d]!;
    if (!isAdjacent(door.pos.x, door.pos.y, state.x, state.y)) continue;
    if (state.openDoors & (1 << d)) {
      actions.push({ kind: 'undo-open', door: d });
    } else if (heldKeys(grid, state) & (1 << door.keyIndex)) {
      actions.push({ kind: 'open', door: d });
    }
  }
  return actions;
}

/** Canonical key for a full state, used by the BFS visited set. */
export function stateKey(state: State): string {
  return `${state.x},${state.y},${state.keys},${state.openDoors}`;
}
