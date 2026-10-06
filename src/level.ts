/** 关卡解析与校验：网格 ≤10×10，钥匙 ≤5（a-e），门 A-E 与钥匙一一对应。 */

export const MAX_SIZE = 10;
export const MAX_KEYS = 5;

export interface Level {
  width: number;
  height: number;
  /** 每个格子是否为墙，索引 y*width+x */
  walls: boolean[];
  start: number;
  goal: number;
  /** 格子 -> 钥匙 id (0..4) */
  keyAt: Map<number, number>;
  /** 格子 -> 门对应的钥匙 id (0..4) */
  doorAt: Map<number, number>;
  numKeys: number;
}

export function idx(level: Level, x: number, y: number): number {
  return y * level.width + x;
}

export function xy(level: Level, i: number): [number, number] {
  return [i % level.width, Math.floor(i / level.width)];
}

/**
 * 字符约定：
 *   '#' 墙  '.' 空地  'S' 起点  'G' 终点
 *   'a'-'e' 钥匙     'A'-'E' 单次门（需对应钥匙开启）
 */
export function parseLevel(rows: string[]): Level {
  if (rows.length === 0) throw new Error("level must have at least one row");
  const height = rows.length;
  const width = rows[0].length;
  if (width === 0) throw new Error("level rows must be non-empty");
  if (width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`grid exceeds ${MAX_SIZE}x${MAX_SIZE}`);
  }
  for (const row of rows) {
    if (row.length !== width) throw new Error("ragged level rows");
  }

  const walls = new Array<boolean>(width * height).fill(false);
  const keyAt = new Map<number, number>();
  const doorAt = new Map<number, number>();
  const seenKeys = new Set<number>();
  const seenDoors = new Set<number>();
  let start = -1;
  let goal = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = rows[y][x];
      const i = y * width + x;
      if (ch === "#") walls[i] = true;
      else if (ch === "." || ch === " ") { /* floor */ }
      else if (ch === "S") {
        if (start >= 0) throw new Error("multiple start cells");
        start = i;
      } else if (ch === "G") {
        if (goal >= 0) throw new Error("multiple goal cells");
        goal = i;
      } else if (ch >= "a" && ch <= "e") {
        const id = ch.charCodeAt(0) - 97;
        if (seenKeys.has(id)) throw new Error(`duplicate key '${ch}'`);
        seenKeys.add(id);
        keyAt.set(i, id);
      } else if (ch >= "A" && ch <= "E") {
        const id = ch.charCodeAt(0) - 65;
        if (seenDoors.has(id)) throw new Error(`duplicate door '${ch}'`);
        seenDoors.add(id);
        doorAt.set(i, id);
      } else {
        throw new Error(`unknown cell char '${ch}'`);
      }
    }
  }

  if (start < 0) throw new Error("missing start 'S'");
  if (goal < 0) throw new Error("missing goal 'G'");
  if (seenKeys.size > MAX_KEYS) throw new Error(`more than ${MAX_KEYS} keys`);
  for (const id of seenDoors) {
    if (!seenKeys.has(id)) {
      throw new Error(`door '${String.fromCharCode(65 + id)}' has no matching key`);
    }
  }

  return { width, height, walls, start, goal, keyAt, doorAt, numKeys: seenKeys.size };
}
