import type { Instance, Solution } from './types.js';

const LETTERS = 'ABCDEFGHIJ';

export function letterOf(index: number): string {
  return LETTERS[index] ?? '?';
}

export function renderCertificate(inst: Instance, sol: Solution): string {
  const { width, height } = inst.grid;
  const cell: string[][] = Array.from({ length: height }, () => Array<string>(width).fill('.'));
  for (const [x, y] of inst.grid.forbidden) cell[y]![x] = '#';
  const idxById = new Map(inst.rectangles.map((r, i) => [r.id, i]));
  for (const p of sol.placements) {
    const i = idxById.get(p.id);
    if (i === undefined) continue;
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        cell[p.y + dy]![p.x + dx] = letterOf(i);
      }
    }
  }
  return cell.map((row) => row.join(' ')).join('\n');
}

export function renderLegend(inst: Instance, sol: Solution): string {
  const placed = new Map(sol.placements.map((p) => [p.id, p]));
  return inst.rectangles
    .map((r, i) => {
      const tag = `${letterOf(i)} = ${r.id} ${r.w}x${r.h} 收益${r.profit}${r.rotate ? ' 可旋转' : ' 禁旋转'}`;
      const p = placed.get(r.id);
      return p ? `${tag} -> 放置于 (${p.x},${p.y}) 朝向 ${p.w}x${p.h}` : `${tag} -> 未放置`;
    })
    .join('\n');
}

/** 校验占用证书，返回问题列表（空数组 = 合法）。 */
export function verifyCertificate(inst: Instance, sol: Solution): string[] {
  const problems: string[] = [];
  const { width, height } = inst.grid;
  const idxById = new Map(inst.rectangles.map((r, i) => [r.id, i]));
  const forbidden = new Set(inst.grid.forbidden.map(([x, y]) => y * width + x));
  const seen = new Set<string>();
  const occ = new Set<number>();
  let profit = 0;
  let area = 0;
  for (const p of sol.placements) {
    const i = idxById.get(p.id);
    if (i === undefined) {
      problems.push(`未知矩形 id: ${p.id}`);
      continue;
    }
    if (seen.has(p.id)) problems.push(`矩形 ${p.id} 被放置多次`);
    seen.add(p.id);
    const r = inst.rectangles[i]!;
    const normal = p.w === r.w && p.h === r.h;
    const rotated = r.rotate && p.w === r.h && p.h === r.w;
    if (!normal && !rotated) {
      problems.push(
        `矩形 ${p.id} 放置尺寸 ${p.w}x${p.h} 与规格 ${r.w}x${r.h}(${r.rotate ? '允许旋转' : '禁止旋转'})不符`,
      );
    }
    if (p.x < 0 || p.y < 0 || p.x + p.w > width || p.y + p.h > height) {
      problems.push(`矩形 ${p.id} 越界: (${p.x},${p.y}) ${p.w}x${p.h}`);
    }
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        const c = (p.y + dy) * width + (p.x + dx);
        if (forbidden.has(c)) problems.push(`矩形 ${p.id} 覆盖禁区 (${p.x + dx},${p.y + dy})`);
        if (occ.has(c)) problems.push(`矩形 ${p.id} 与其他矩形重叠于 (${p.x + dx},${p.y + dy})`);
        occ.add(c);
      }
    }
    profit += r.profit;
    area += r.w * r.h;
  }
  if (profit !== sol.profit) problems.push(`收益不符: 声明 ${sol.profit}, 实算 ${profit}`);
  if (area !== sol.area) problems.push(`面积不符: 声明 ${sol.area}, 实算 ${area}`);
  return problems;
}
