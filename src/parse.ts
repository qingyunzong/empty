import type { Instance, RectSpec } from './types.js';

export const MAX_GRID_SIDE = 8;
export const MAX_RECTS = 10;

function intField(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${name} 必须是 [${min}, ${max}] 内的整数`);
  }
  return v;
}

export function parseInstance(raw: unknown): Instance {
  if (typeof raw !== 'object' || raw === null) throw new Error('顶层必须是 JSON 对象');
  const o = raw as Record<string, unknown>;
  if (typeof o.grid !== 'object' || o.grid === null) throw new Error('缺少 grid 对象');
  const g = o.grid as Record<string, unknown>;
  const width = intField(g.width, 'grid.width', 1, MAX_GRID_SIDE);
  const height = intField(g.height, 'grid.height', 1, MAX_GRID_SIDE);

  const forbiddenRaw = g.forbidden ?? [];
  if (!Array.isArray(forbiddenRaw)) throw new Error('grid.forbidden 必须是 [x,y] 数组');
  const forbidden: Array<[number, number]> = [];
  const seenCell = new Set<number>();
  for (const c of forbiddenRaw) {
    if (!Array.isArray(c) || c.length !== 2) throw new Error('grid.forbidden 元素必须是 [x, y]');
    const [x, y] = c as unknown[];
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`禁区坐标必须是整数: ${JSON.stringify(c)}`);
    const xi = x as number;
    const yi = y as number;
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) throw new Error(`禁区坐标越界: [${xi}, ${yi}]`);
    const key = yi * width + xi;
    if (!seenCell.has(key)) {
      seenCell.add(key);
      forbidden.push([xi, yi]);
    }
  }

  if (!Array.isArray(o.rectangles)) throw new Error('缺少 rectangles 数组');
  if (o.rectangles.length > MAX_RECTS) {
    throw new Error(`矩形数量 ${o.rectangles.length} 超过上限 ${MAX_RECTS}`);
  }
  const ids = new Set<string>();
  const rectangles: RectSpec[] = o.rectangles.map((rr: unknown, i: number) => {
    if (typeof rr !== 'object' || rr === null) throw new Error(`rectangles[${i}] 必须是对象`);
    const r = rr as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0) {
      throw new Error(`rectangles[${i}].id 必须是非空字符串`);
    }
    if (ids.has(r.id)) throw new Error(`矩形 id 重复: ${r.id}`);
    ids.add(r.id);
    const w = intField(r.w, `rectangles[${i}].w`, 1, 64);
    const h = intField(r.h, `rectangles[${i}].h`, 1, 64);
    if (typeof r.profit !== 'number' || !Number.isFinite(r.profit) || r.profit < 0) {
      throw new Error(`rectangles[${i}].profit 必须是非负有限数`);
    }
    const rotate = r.rotate ?? false;
    if (typeof rotate !== 'boolean') throw new Error(`rectangles[${i}].rotate 必须是布尔值`);
    return { id: r.id, w, h, profit: r.profit, rotate };
  });

  return { grid: { width, height, forbidden }, rectangles };
}
