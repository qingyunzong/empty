/**
 * 二维仿射矩阵，按行主序存储 3x3 齐次矩阵的前两行：
 *
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 *
 * 点变换约定：p' = M * [x, y, 1]^T，即
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Mat2D = readonly [number, number, number, number, number, number];

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** 轴对齐包围盒（AABB），min/max 均为世界坐标。 */
export interface AABB {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export const IDENTITY: Mat2D = [1, 0, 0, 1, 0, 0];

/** 矩阵乘法：返回 a * b（先施加 b，再施加 a）。 */
export function multiply(a: Mat2D, b: Mat2D): Mat2D {
  const [a1, a2, a3, a4, a5, a6] = a;
  const [b1, b2, b3, b4, b5, b6] = b;
  return [
    a1 * b1 + a3 * b2,
    a2 * b1 + a4 * b2,
    a1 * b3 + a3 * b4,
    a2 * b3 + a4 * b4,
    a1 * b5 + a3 * b6 + a5,
    a2 * b5 + a4 * b6 + a6,
  ];
}

/** 点的仿射变换。 */
export function transformPoint(m: Mat2D, p: Vec2): Vec2 {
  const [a, b, c, d, e, f] = m;
  return {
    x: a * p.x + c * p.y + e,
    y: b * p.x + d * p.y + f,
  };
}

/**
 * 求仿射变换后局部 AABB 的世界 AABB。
 *
 * 剪切 / 旋转 / 负缩放都会使局部矩形的边与世界轴不对齐，
 * 因此必须对四个角点逐一变换后再取 min/max，
 * 不能简单地缩放局部宽高。
 */
export function transformAABB(m: Mat2D, box: AABB): AABB {
  const corners: Vec2[] = [
    { x: box.minX, y: box.minY },
    { x: box.minX, y: box.maxY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const corner of corners) {
    const p = transformPoint(m, corner);
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** 合并两个 AABB；入参为 null 时返回另一个。 */
export function unionAABB(a: AABB | null, b: AABB | null): AABB | null {
  if (a === null) return b;
  if (b === null) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function aabbEquals(a: AABB | null, b: AABB | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.minX === b.minX &&
    a.minY === b.minY &&
    a.maxX === b.maxX &&
    a.maxY === b.maxY
  );
}

export function matEquals(a: Mat2D, b: Mat2D): boolean {
  for (let i = 0; i < 6; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
