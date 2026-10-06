import type { BoardSpec, State, Vec } from "./types.ts";
import { sortVecs } from "./state.ts";

export const ORTHO: readonly Vec[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export const MAX_ENEMIES = 12;
export const MAX_OBSTACLES = 6;

export function vecKey(v: Vec): string {
  return `${v[0]},${v[1]}`;
}

function isVec(v: unknown): v is Vec {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isInteger(v[0]) &&
    Number.isInteger(v[1])
  );
}

export class Board {
  readonly width: number;
  readonly height: number;
  readonly walls: ReadonlySet<string>;
  readonly toggle: Vec | null;
  readonly toggleOnce: boolean;
  readonly dirs: readonly [readonly Vec[], readonly Vec[]];
  readonly totalEnemies: number;
  private readonly start: State;

  constructor(spec: BoardSpec) {
    if (!Number.isInteger(spec.width) || !Number.isInteger(spec.height) ||
        spec.width < 1 || spec.height < 1 || spec.width > 64 || spec.height > 64) {
      throw new Error(`invalid board size ${spec.width}x${spec.height}`);
    }
    this.width = spec.width;
    this.height = spec.height;

    const enemies = spec.enemies ?? [];
    const obstacles = spec.obstacles ?? [];
    const walls = spec.walls ?? [];
    if (enemies.length > MAX_ENEMIES) {
      throw new Error(`too many enemies: ${enemies.length} > ${MAX_ENEMIES}`);
    }
    if (obstacles.length > MAX_OBSTACLES) {
      throw new Error(`too many obstacles: ${obstacles.length} > ${MAX_OBSTACLES}`);
    }
    if (!isVec(spec.player)) throw new Error("player must be [x,y]");
    for (const group of [enemies, obstacles, walls]) {
      for (const v of group) {
        if (!isVec(v)) throw new Error(`bad position ${JSON.stringify(v)}`);
      }
    }

    const dirsA = spec.directionsA ?? [];
    const dirsB = spec.directionsB ?? dirsA;
    if (dirsA.length === 0) throw new Error("directionsA must be non-empty");
    for (const d of [...dirsA, ...dirsB]) {
      if (!isVec(d) || (d[0] === 0 && d[1] === 0)) {
        throw new Error(`bad direction ${JSON.stringify(d)}`);
      }
    }
    this.dirs = [dirsA, dirsB];

    const inBounds = (v: Vec): boolean =>
      v[0] >= 0 && v[0] < this.width && v[1] >= 0 && v[1] < this.height;
    const positioned: [string, Vec][] = [
      ["player", spec.player],
      ...enemies.map((e): [string, Vec] => ["enemy", e]),
      ...obstacles.map((o): [string, Vec] => ["obstacle", o]),
      ...walls.map((w): [string, Vec] => ["wall", w]),
    ];
    for (const [label, v] of positioned) {
      if (!inBounds(v)) throw new Error(`${label} out of bounds at ${vecKey(v)}`);
    }

    this.walls = new Set(walls.map(vecKey));
    const occupied = new Map<string, string>();
    const claim = (v: Vec, label: string): void => {
      if (this.walls.has(vecKey(v))) throw new Error(`${label} on wall at ${vecKey(v)}`);
      const prev = occupied.get(vecKey(v));
      if (prev) throw new Error(`${label} overlaps ${prev} at ${vecKey(v)}`);
      occupied.set(vecKey(v), label);
    };
    claim(spec.player, "player");
    enemies.forEach((e) => claim(e, "enemy"));
    obstacles.forEach((o) => claim(o, "obstacle"));

    this.toggle = spec.toggle ?? null;
    if (this.toggle !== null) {
      if (!isVec(this.toggle) || !inBounds(this.toggle)) {
        throw new Error("toggle out of bounds");
      }
      if (this.walls.has(vecKey(this.toggle))) throw new Error("toggle on wall");
    }
    this.toggleOnce = spec.toggleOnce ?? false;

    this.totalEnemies = enemies.length;
    this.start = {
      player: spec.player,
      enemies: sortVecs(enemies),
      obstacles: sortVecs(obstacles),
      phase: 0,
      toggleArmed: true,
    };
  }

  inBounds(v: Vec): boolean {
    return v[0] >= 0 && v[0] < this.width && v[1] >= 0 && v[1] < this.height;
  }

  standable(v: Vec): boolean {
    return this.inBounds(v) && !this.walls.has(vecKey(v));
  }

  initialState(): State {
    return {
      player: this.start.player,
      enemies: [...this.start.enemies],
      obstacles: [...this.start.obstacles],
      phase: this.start.phase,
      toggleArmed: this.start.toggleArmed,
    };
  }
}
