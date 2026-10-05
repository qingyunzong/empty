import { Rat } from './rational.ts';
import type { UserInput } from './allocator.ts';

/**
 * 逐单位小容量对照模型:
 * 把总容量看成一个个不可分割的小单位,每次把下一单位分给
 * “已得量/权重”最小(并列时 ID 最小)且尚未饱和的用户。
 * 这是加权最大最小公平的离散极限模拟,用于对照逐轮模型的结果。
 */
export function unitModelAllocate(
  capacity: number,
  users: UserInput[],
): Record<string, number> {
  const states = users
    .map((u) => ({
      id: u.id,
      effective: Math.min(u.demand, u.cap),
      weight: Rat.of(u.weight),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const alloc = new Map<string, number>(states.map((s) => [s.id, 0]));

  for (let unit = 0; unit < capacity; unit += 1) {
    let best: (typeof states)[number] | null = null;
    let bestAlloc = 0;
    for (const s of states) {
      const current = alloc.get(s.id)!;
      if (current >= s.effective) continue;
      if (best === null) {
        best = s;
        bestAlloc = current;
        continue;
      }
      // 比较 current/s.weight 与 bestAlloc/best.weight <=> current*best.weight ? bestAlloc*s.weight
      const lhs = Rat.of(current).mul(best.weight);
      const rhs = Rat.of(bestAlloc).mul(s.weight);
      if (lhs.cmp(rhs) < 0) {
        best = s;
        bestAlloc = current;
      }
    }
    if (best === null) break;
    alloc.set(best.id, bestAlloc + 1);
  }

  return Object.fromEntries(alloc);
}
