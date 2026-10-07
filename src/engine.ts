import { Puzzle, Vec } from './model.js';

/** Immutable game state. Enemies are a bitmask over the sorted initial cells. */
export interface GameState {
  pos: number;
  enemies: number;
  /** sorted cell indices of obstacles */
  obstacles: number[];
  toggled: boolean;
}

export interface Move {
  kind: 'jump' | 'push';
  from: number;
  dir: Vec;
  /** landing cell of the piece */
  to: number;
  /** jump only: cell of the captured enemy */
  captured?: number;
  /** push only */
  obstacleFrom?: number;
  obstacleTo?: number;
}

export class Engine {
  readonly w: number;
  readonly h: number;
  readonly cells: number;
  /** sorted initial enemy cells; bit i corresponds to enemyCells[i] */
  readonly enemyCells: number[];
  /** cell -> enemy bit index, or -1 */
  private readonly cellToBit: number[];
  readonly toggleCell: number | null;

  constructor(readonly puzzle: Puzzle) {
    this.w = puzzle.width;
    this.h = puzzle.height;
    this.cells = this.w * this.h;
    this.enemyCells = puzzle.enemies;
    this.cellToBit = new Array<number>(this.cells).fill(-1);
    this.enemyCells.forEach((c, i) => {
      this.cellToBit[c] = i;
    });
    this.toggleCell = puzzle.toggle;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.w && y >= 0 && y < this.h;
  }

  cell(x: number, y: number): number {
    return y * this.w + x;
  }

  xy(c: number): [number, number] {
    return [c % this.w, Math.floor(c / this.w)];
  }

  initialState(): GameState {
    return {
      pos: this.puzzle.start,
      enemies: (1 << this.enemyCells.length) - 1,
      obstacles: [...this.puzzle.obstacles],
      toggled: false,
    };
  }

  dirsOf(s: GameState): Vec[] {
    if (s.toggled && this.puzzle.altDirections !== null) return this.puzzle.altDirections;
    return this.puzzle.directions;
  }

  /** union of both direction sets (used for safe bounds) */
  allDirs(): Vec[] {
    const seen = new Set<string>();
    const out: Vec[] = [];
    for (const d of [...this.puzzle.directions, ...(this.puzzle.altDirections ?? [])]) {
      const k = `${d.dx},${d.dy}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(d);
      }
    }
    return out;
  }

  enemyAt(s: GameState, cell: number): boolean {
    const bit = this.cellToBit[cell]!;
    return bit >= 0 && (s.enemies & (1 << bit)) !== 0;
  }

  obstacleAt(s: GameState, cell: number): boolean {
    // binary search over sorted obstacle cells
    let lo = 0;
    let hi = s.obstacles.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = s.obstacles[mid]!;
      if (v === cell) return true;
      if (v < cell) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  occupied(s: GameState, cell: number): boolean {
    return this.enemyAt(s, cell) || this.obstacleAt(s, cell);
  }

  /**
   * Deterministic move generation: all jumps (in direction-set order),
   * then all pushes (in direction-set order).
   */
  genMoves(s: GameState): Move[] {
    const dirs = this.dirsOf(s);
    const moves: Move[] = [];
    const [x, y] = this.xy(s.pos);
    for (const d of dirs) {
      const mx = x + d.dx;
      const my = y + d.dy;
      const lx = x + 2 * d.dx;
      const ly = y + 2 * d.dy;
      if (!this.inBounds(mx, my) || !this.inBounds(lx, ly)) continue;
      const mid = this.cell(mx, my);
      const land = this.cell(lx, ly);
      if (this.enemyAt(s, mid) && !this.occupied(s, land)) {
        moves.push({ kind: 'jump', from: s.pos, dir: d, to: land, captured: mid });
      }
    }
    for (const d of dirs) {
      const ax = x + d.dx;
      const ay = y + d.dy;
      const bx = x + 2 * d.dx;
      const by = y + 2 * d.dy;
      if (!this.inBounds(ax, ay) || !this.inBounds(bx, by)) continue;
      const adj = this.cell(ax, ay);
      const beyond = this.cell(bx, by);
      if (this.obstacleAt(s, adj) && !this.occupied(s, beyond)) {
        moves.push({
          kind: 'push',
          from: s.pos,
          dir: d,
          to: adj,
          obstacleFrom: adj,
          obstacleTo: beyond,
        });
      }
    }
    return moves;
  }

  apply(s: GameState, m: Move): GameState {
    let enemies = s.enemies;
    let obstacles = s.obstacles;
    if (m.kind === 'jump') {
      const bit = this.cellToBit[m.captured!]!;
      enemies = s.enemies & ~(1 << bit);
    } else {
      obstacles = replaceSorted(s.obstacles, m.obstacleFrom!, m.obstacleTo!);
    }
    let toggled = s.toggled;
    if (!toggled && this.toggleCell !== null && m.to === this.toggleCell) toggled = true;
    return { pos: m.to, enemies, obstacles, toggled };
  }

  key(s: GameState): string {
    return `${s.pos}|${s.enemies}|${s.obstacles.join(',')}|${s.toggled ? 1 : 0}`;
  }

  popcountEnemies(s: GameState): number {
    let v = s.enemies;
    let n = 0;
    while (v !== 0) {
      v &= v - 1;
      n++;
    }
    return n;
  }
}

function replaceSorted(arr: number[], from: number, to: number): number[] {
  const out = arr.filter((v) => v !== from);
  let i = 0;
  while (i < out.length && out[i]! < to) i++;
  out.splice(i, 0, to);
  return out;
}
