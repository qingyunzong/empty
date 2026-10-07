export interface Pos {
  readonly x: number;
  readonly y: number;
}

/**
 * Immutable search state.
 * - `keys`: bitmask of collected keys (bit i = key letter 'a'+i).
 * - `openDoors`: bitmask of currently open door instances (bit i = grid.doors[i]).
 * Keys currently spent on open doors are derived: spent = OR of key bits of open doors.
 * Held (usable) keys = keys & ~spent.
 */
export interface State {
  readonly x: number;
  readonly y: number;
  readonly keys: number;
  readonly openDoors: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

export type Action =
  | { readonly kind: 'move'; readonly dir: Direction }
  | { readonly kind: 'open'; readonly door: number }
  | { readonly kind: 'undo-open'; readonly door: number };

export interface KeyInfo {
  readonly pos: Pos;
  readonly keyIndex: number;
}

export interface DoorInfo {
  readonly pos: Pos;
  readonly keyIndex: number;
}

export interface Grid {
  readonly width: number;
  readonly height: number;
  readonly walls: ReadonlyArray<boolean>;
  readonly start: Pos;
  readonly goal: Pos;
  readonly keys: ReadonlyArray<KeyInfo>;
  readonly doors: ReadonlyArray<DoorInfo>;
  /** "x,y" -> index into keys */
  readonly keyAt: ReadonlyMap<string, number>;
  /** "x,y" -> index into doors */
  readonly doorAt: ReadonlyMap<string, number>;
}

export const MAX_GRID = 10;
export const MAX_KEYS = 5;
export const MAX_DOORS = 31;

export function posKey(x: number, y: number): string {
  return `${x},${y}`;
}
