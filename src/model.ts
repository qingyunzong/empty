/**
 * Puzzle model for a fully custom jump-capture board game.
 *
 * Rules (self-contained, not borrowed from any real-world game):
 *  - One player piece moves on a rectangular grid.
 *  - JUMP: if the adjacent cell in a direction of the CURRENT direction set
 *    holds an enemy and the cell straight beyond is in-bounds and empty
 *    (no enemy, no obstacle), the piece lands there and the enemy is removed.
 *    Jumps may chain (a jump is just another move from the new state).
 *  - PUSH: if the adjacent cell in a current direction holds an obstacle and
 *    the cell beyond is in-bounds and empty, the piece steps into the
 *    obstacle's cell and the obstacle slides one cell. Pushing captures nothing.
 *  - TOGGLE: at most one toggle square. The first time the piece LANDS on it
 *    (by jump or push) the direction set switches to `altDirections`
 *    permanently. This can make previously jumpable positions unjumpable and
 *    vice versa.
 *  - The piece has no plain step move; it only moves by jumping or pushing.
 */

export interface Vec {
  readonly dx: number;
  readonly dy: number;
}

export interface Puzzle {
  width: number;
  height: number;
  /** cell index (y * width + x) of the piece start */
  start: number;
  /** sorted unique cell indices of enemies, length <= 12 */
  enemies: number[];
  /** sorted unique cell indices of pushable obstacles, length <= 6 */
  obstacles: number[];
  /** cell index of the one-time toggle square, or null */
  toggle: number | null;
  /** active direction set before the toggle is triggered */
  directions: Vec[];
  /** direction set after the toggle; required iff toggle !== null */
  altDirections: Vec[] | null;
}

export const MAX_ENEMIES = 12;
export const MAX_OBSTACLES = 6;
export const MAX_CELLS = 64;

export type Point = [number, number];

/** Raw JSON shape accepted by the CLI. */
export interface PuzzleJson {
  width: number;
  height: number;
  start: Point;
  enemies?: Point[];
  obstacles?: Point[];
  toggle?: Point | null;
  directions: Point[];
  altDirections?: Point[] | null;
}

function fail(msg: string): never {
  throw new Error(`invalid puzzle: ${msg}`);
}

function isPoint(p: unknown): p is Point {
  return (
    Array.isArray(p) &&
    p.length === 2 &&
    Number.isInteger(p[0]) &&
    Number.isInteger(p[1])
  );
}

function toCell(p: Point, w: number, h: number, what: string): number {
  const [x, y] = p;
  if (x < 0 || x >= w || y < 0 || y >= h) {
    fail(`${what} (${x},${y}) is out of bounds for ${w}x${h} board`);
  }
  return y * w + x;
}

function parseDirs(raw: unknown, w: number, h: number, what: string): Vec[] {
  if (!Array.isArray(raw) || raw.length === 0) fail(`${what} must be a non-empty array of [dx,dy]`);
  const seen = new Set<string>();
  const out: Vec[] = [];
  for (const p of raw) {
    if (!isPoint(p)) fail(`${what} entries must be [dx,dy] integer pairs`);
    const [dx, dy] = p;
    if (dx === 0 && dy === 0) fail(`${what} must not contain the zero vector`);
    const key = `${dx},${dy}`;
    if (seen.has(key)) fail(`${what} contains duplicate direction [${key}]`);
    seen.add(key);
    out.push({ dx, dy });
  }
  return out;
}

export function parsePuzzle(data: unknown): Puzzle {
  if (typeof data !== 'object' || data === null) fail('top-level value must be an object');
  const j = data as PuzzleJson;
  const { width: w, height: h } = j;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    fail('width and height must be positive integers');
  }
  if (w * h > MAX_CELLS) fail(`board too large (${w}x${h}); max ${MAX_CELLS} cells`);
  if (!isPoint(j.start)) fail('start must be [x,y]');
  const start = toCell(j.start, w, h, 'start');

  const enemyPts = j.enemies ?? [];
  if (!Array.isArray(enemyPts)) fail('enemies must be an array of [x,y]');
  if (enemyPts.length > MAX_ENEMIES) fail(`too many enemies (${enemyPts.length}); max ${MAX_ENEMIES}`);
  const enemies = enemyPts.map((p, i) => {
    if (!isPoint(p)) fail(`enemies[${i}] must be [x,y]`);
    return toCell(p, w, h, `enemies[${i}]`);
  });
  if (new Set(enemies).size !== enemies.length) fail('duplicate enemy cells');

  const obstaclePts = j.obstacles ?? [];
  if (!Array.isArray(obstaclePts)) fail('obstacles must be an array of [x,y]');
  if (obstaclePts.length > MAX_OBSTACLES) fail(`too many obstacles (${obstaclePts.length}); max ${MAX_OBSTACLES}`);
  const obstacles = obstaclePts.map((p, i) => {
    if (!isPoint(p)) fail(`obstacles[${i}] must be [x,y]`);
    return toCell(p, w, h, `obstacles[${i}]`);
  });
  if (new Set(obstacles).size !== obstacles.length) fail('duplicate obstacle cells');

  let toggle: number | null = null;
  if (j.toggle !== undefined && j.toggle !== null) {
    if (!isPoint(j.toggle)) fail('toggle must be [x,y] or null');
    toggle = toCell(j.toggle, w, h, 'toggle');
  }

  const directions = parseDirs(j.directions, w, h, 'directions');
  let altDirections: Vec[] | null = null;
  if (j.altDirections !== undefined && j.altDirections !== null) {
    altDirections = parseDirs(j.altDirections, w, h, 'altDirections');
  }
  if (toggle !== null && altDirections === null) {
    fail('altDirections is required when a toggle square is present');
  }
  if (toggle === null && altDirections !== null) {
    fail('altDirections given but no toggle square');
  }

  const occupied = new Set<number>([start, ...enemies, ...obstacles]);
  if (occupied.size !== 1 + enemies.length + obstacles.length) {
    fail('start, enemies and obstacles must be on distinct cells');
  }
  if (toggle !== null && occupied.has(toggle)) {
    fail('toggle square must be empty initially (distinct from start/enemies/obstacles)');
  }

  enemies.sort((a, b) => a - b);
  obstacles.sort((a, b) => a - b);
  return { width: w, height: h, start, enemies, obstacles, toggle, directions, altDirections };
}

/** Canonical JSON string (stable key order) used for hashing. */
export function canonicalPuzzleJson(p: Puzzle): string {
  const pt = (c: number): Point => [c % p.width, Math.floor(c / p.width)];
  const dir = (d: Vec): Point => [d.dx, d.dy];
  return JSON.stringify({
    width: p.width,
    height: p.height,
    start: pt(p.start),
    enemies: p.enemies.map(pt),
    obstacles: p.obstacles.map(pt),
    toggle: p.toggle === null ? null : pt(p.toggle),
    directions: p.directions.map(dir),
    altDirections: p.altDirections === null ? null : p.altDirections.map(dir),
  });
}
