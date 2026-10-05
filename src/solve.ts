import { Certificate, SubtitleItem, validateItems } from "./model";

/**
 * 精确求解：最多 k 层、同层不重叠（半开区间）、总收益最大的显示集合。
 *
 * 目标字典序：
 *   1. 总收益最大；
 *   2. 收益并列时选中条目数最少（消除零收益冗余）；
 *   3. 仍并列时选中 ID 排序列表字典序最小（“并列 ID 序”）。
 * 层分配确定性：按 (start, end, id) 顺序把每条放到编号最小的可用层。
 *
 * 算法：按 (start, end, id) 时序做带记忆化的轨道 DP。状态 = (下标 i, 各层
 * 空闲时刻升序元组)，转移 = 跳过第 i 条，或放到任一空闲时刻 <= start_i 的层。
 * 按时序处理保证：同层先处理的条目必在 start_i 之前结束，故任意可行解都能
 * 被 DP 重放。随后按 ID 升序“能选则选”地重建，得字典序最小的最优集合。
 */

interface Pair {
  profit: number;
  count: number;
}

function better(a: Pair, b: Pair): Pair {
  if (a.profit !== b.profit) return a.profit > b.profit ? a : b;
  return a.count <= b.count ? a : b;
}

const NEG: Pair = { profit: -Infinity, count: Infinity };

/** 受约束 DP：forced[i] = 1 必选，0 必弃，-1 自由。返回从第 i 条起的最优 (profit, count)。 */
function constrainedDP(
  items: SubtitleItem[],
  k: number,
  forced: number[],
): (i: number, free: number[]) => Pair {
  const n = items.length;
  const memo = new Map<string, Pair>();

  function rec(i: number, free: number[]): Pair {
    if (i === n) return { profit: 0, count: 0 };
    const key = `${i}|${free.join(",")}`;
    const hit = memo.get(key);
    if (hit) return hit;

    const it = items[i]!;
    let best = NEG;

    if (forced[i] !== 1) {
      best = better(best, rec(i + 1, free));
    }
    if (forced[i] !== 0) {
      // 尝试放到每层；空闲时刻相同的层等价，去重。
      const tried = new Set<number>();
      for (let layer = 0; layer < k; layer++) {
        const f = free[layer]!;
        if (f > it.start || tried.has(f)) continue;
        tried.add(f);
        const next = [...free];
        next[layer] = it.end;
        next.sort((a, b) => a - b);
        const sub = rec(i + 1, next);
        if (sub.profit === -Infinity) continue;
        best = better(best, {
          profit: sub.profit + it.priority,
          count: sub.count + 1,
        });
      }
    }

    memo.set(key, best);
    return best;
  }
  return rec;
}

export function solve(input: SubtitleItem[], k: number): Certificate {
  validateItems(input, k);
  // DP 必须按时序处理；层分配同样使用此序。
  const items = [...input].sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const n = items.length;
  const layers = Math.min(k, Math.max(n, 1));
  const free0 = new Array<number>(layers).fill(-Infinity);

  const forced = new Array<number>(n).fill(-1);
  const dp = constrainedDP(items, layers, forced);
  const best = dp(0, free0);

  // 重建：按 ID 升序，若存在与当前决定一致且包含该条的最优解，则选入。
  const idOrder = items
    .map((it, i) => ({ id: it.id, i }))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => e.i);
  const chosen = new Array<boolean>(n).fill(false);
  for (const i of idOrder) {
    forced[i] = 1;
    const probe = constrainedDP(items, layers, forced);
    const res = probe(0, free0);
    if (res.profit === best.profit && res.count === best.count) {
      chosen[i] = true;
    } else {
      forced[i] = 0;
    }
  }

  const selected = items.filter((_, i) => chosen[i]).map((it) => it.id);
  selected.sort();

  // 确定性层分配：按时序放入编号最小的可用层。
  const layerFree = new Array<number>(layers).fill(-Infinity);
  const layerIds: string[][] = Array.from({ length: layers }, () => []);
  for (let idx = 0; idx < n; idx++) {
    if (!chosen[idx]) continue;
    const it = items[idx]!;
    let placed = false;
    for (let layer = 0; layer < layers; layer++) {
      if (layerFree[layer]! <= it.start) {
        layerFree[layer] = it.end;
        layerIds[layer]!.push(it.id);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // 深度 <= k 时必然可放置；走到这里说明内部状态不一致。
      throw new Error(`内部错误：条目 ${it.id} 无法分配到任何层`);
    }
  }

  return {
    k,
    profit: best.profit,
    selected,
    layers: layerIds.filter((layer) => layer.length > 0),
  };
}
