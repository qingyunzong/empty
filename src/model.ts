/** 布局问题模型：整数坐标、显式尺寸范围、显式对齐约束、不重叠约束。 */

export interface RectSpec {
  id: string;
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
  /** 旧布局中的左上角位置与尺寸（移动距离只对位置计费，改尺寸免费）。 */
  oldX: number;
  oldY: number;
  oldW: number;
  oldH: number;
}

/** 对齐边：left/right/top/bottom 为边坐标相等；hcenter/vcenter 为中心相等（用 2 倍整数表示）。 */
export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter';

export interface AlignConstraint {
  a: string;
  b: string;
  edge: AlignEdge;
}

export interface LayoutSpec {
  /** 正方形网格边长（坐标 0..grid）。 */
  grid: number;
  rects: RectSpec[];
  align: AlignConstraint[];
}

export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MAX_RECTS = 8;

function isInt(v: number): boolean {
  return Number.isInteger(v);
}

/** 校验问题定义本身是否合法；返回问题列表（空数组 = 合法）。 */
export function validateSpec(spec: LayoutSpec): string[] {
  const problems: string[] = [];
  if (!isInt(spec.grid) || spec.grid <= 0) problems.push(`grid 必须为正整数，得到 ${spec.grid}`);
  if (!Array.isArray(spec.rects) || spec.rects.length === 0) problems.push('rects 不能为空');
  if (spec.rects.length > MAX_RECTS) problems.push(`矩形数 ${spec.rects.length} 超过上限 ${MAX_RECTS}`);
  const ids = new Set<string>();
  for (const r of spec.rects) {
    if (ids.has(r.id)) problems.push(`矩形 id 重复: ${r.id}`);
    ids.add(r.id);
    const nums = [r.minW, r.maxW, r.minH, r.maxH, r.oldX, r.oldY, r.oldW, r.oldH];
    if (!nums.every(isInt)) problems.push(`${r.id}: 所有字段必须为整数`);
    if (!(1 <= r.minW && r.minW <= r.maxW && r.maxW <= spec.grid)) problems.push(`${r.id}: 宽度范围非法 [${r.minW}, ${r.maxW}]`);
    if (!(1 <= r.minH && r.minH <= r.maxH && r.maxH <= spec.grid)) problems.push(`${r.id}: 高度范围非法 [${r.minH}, ${r.maxH}]`);
    if (!(r.minW <= r.oldW && r.oldW <= r.maxW)) problems.push(`${r.id}: 旧宽度 ${r.oldW} 超出范围`);
    if (!(r.minH <= r.oldH && r.oldH <= r.maxH)) problems.push(`${r.id}: 旧高度 ${r.oldH} 超出范围`);
    if (!(0 <= r.oldX && r.oldX + r.oldW <= spec.grid)) problems.push(`${r.id}: 旧位置 x 越界`);
    if (!(0 <= r.oldY && r.oldY + r.oldH <= spec.grid)) problems.push(`${r.id}: 旧位置 y 越界`);
  }
  for (const c of spec.align) {
    if (c.a === c.b) problems.push(`对齐约束不能作用于自身: ${c.a}`);
    if (!ids.has(c.a)) problems.push(`对齐约束引用未知矩形: ${c.a}`);
    if (!ids.has(c.b)) problems.push(`对齐约束引用未知矩形: ${c.b}`);
  }
  return problems;
}
