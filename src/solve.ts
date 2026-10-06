import { Problem, Supplier, maxQtyOf, priceOf, validateProblem } from "./model";

export interface Candidate {
  /** 每家供应商的下单数量（0 表示不订） */
  qty: number[];
  totalQty: number;
  totalCost: number;
}

export interface SlotReport {
  slot: number;
  arrivals: number;
  capacity: number;
  cumArrivals: number;
  cumDemand: number;
  shortage: number;
  ok: boolean;
}

export interface SolveResult {
  feasible: boolean;
  best: Candidate | null;
  slots: SlotReport[];
}

/** 目标序：总价最小 -> 超购（totalQty）最小 -> 数量向量字典序最小 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.totalCost !== b.totalCost) return a.totalCost - b.totalCost;
  if (a.totalQty !== b.totalQty) return a.totalQty - b.totalQty;
  for (let i = 0; i < a.qty.length; i++) {
    const d = (a.qty[i] ?? 0) - (b.qty[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 合同约束：互斥 + 依赖（mask 第 i 位 = 向供应商 i 下了单） */
export function maskSatisfiesContracts(p: Problem, mask: number): boolean {
  for (const [i, j] of p.exclusions ?? []) {
    if ((mask & (1 << i)) !== 0 && (mask & (1 << j)) !== 0) return false;
  }
  for (const [a, b] of p.dependencies ?? []) {
    if ((mask & (1 << a)) !== 0 && (mask & (1 << b)) === 0) return false;
  }
  return true;
}

/** 逐时段缺货验证：各时段到货不超共享容量，且累计到货 >= 累计需求 */
export function verifySchedule(p: Problem, qty: number[]): SlotReport[] {
  const T = p.slotCapacity.length;
  const arrivals = new Array<number>(T).fill(0);
  p.suppliers.forEach((s, i) => {
    const q = qty[i] ?? 0;
    arrivals[s.arrivalSlot] = (arrivals[s.arrivalSlot] ?? 0) + q;
  });
  const reports: SlotReport[] = [];
  let cumArr = 0;
  let cumDem = 0;
  for (let t = 0; t < T; t++) {
    cumArr += arrivals[t] ?? 0;
    cumDem += p.slotDemand[t] ?? 0;
    const capacity = p.slotCapacity[t] ?? 0;
    const arr = arrivals[t] ?? 0;
    const shortage = Math.max(0, cumDem - cumArr);
    reports.push({
      slot: t,
      arrivals: arr,
      capacity,
      cumArrivals: cumArr,
      cumDemand: cumDem,
      shortage,
      ok: arr <= capacity && shortage === 0,
    });
  }
  return reports;
}

function choicesOf(s: Supplier): number[] {
  const mq = maxQtyOf(s);
  const out: number[] = [0];
  for (let q = s.minQty; q <= mq; q++) out.push(q);
  return out;
}

interface DpEntry {
  cost: number;
  total: number;
  qty: number[];
}

function lexCompare(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 联合 DP：按到货时段分组、再按供应商转移，状态 = (下单掩码, 各时段到货量)
 * 编码为数值键（总量 = 各时段到货量之和，存于条目内）。
 * 同一状态只保留 (成本, 数量向量字典序) 最优的前缀；
 * 每处理完一个时段的供应商即按“累计到货 >= 累计需求”剪枝。
 */
export function solveDp(p: Problem): SolveResult {
  validateProblem(p);
  const T = p.slotCapacity.length;
  const n = p.suppliers.length;

  // 数值状态键：key = mask * arrSpace + sum(arr[t] * base[t])
  const base: number[] = [];
  let arrSpace = 1;
  for (let t = 0; t < T; t++) {
    base.push(arrSpace);
    arrSpace *= (p.slotCapacity[t] ?? 0) + 1;
  }

  // 每个供应商的 (数量, 价格) 选项，按到货时段分组处理
  const options = p.suppliers.map((s) => {
    const opts: Array<{ q: number; cost: number }> = [{ q: 0, cost: 0 }];
    const mq = maxQtyOf(s);
    for (let q = s.minQty; q <= mq; q++) opts.push({ q, cost: priceOf(s, q) });
    return opts;
  });
  const order = p.suppliers
    .map((s, i) => ({ i, slot: s.arrivalSlot }))
    .sort((a, b) => a.slot - b.slot);
  const cumDemand: number[] = [];
  {
    let c = 0;
    for (let t = 0; t < T; t++) {
      c += p.slotDemand[t] ?? 0;
      cumDemand.push(c);
    }
  }

  let dp = new Map<number, DpEntry>();
  dp.set(0, { cost: 0, total: 0, qty: new Array<number>(n).fill(0) });

  for (let pos = 0; pos < order.length; pos++) {
    const { i, slot } = order[pos] as { i: number; slot: number };
    const bit = (1 << i) * arrSpace;
    const step = base[slot] ?? 0;
    const opts = options[i] ?? [];
    const next = new Map<number, DpEntry>();
    for (const [key, entry] of dp) {
      const slotCap = p.slotCapacity[slot] ?? 0;
      const curArr = Math.floor((key % arrSpace) / step) % (slotCap + 1);
      for (const { q, cost } of opts) {
        const nTotal = entry.total + q;
        if (nTotal > p.cap) continue;
        if (curArr + q > slotCap) continue;
        const nKey = key + q * step + (q > 0 ? bit : 0);
        const nCost = entry.cost + cost;
        const prev = next.get(nKey);
        if (prev !== undefined && nCost > prev.cost) continue;
        const nQty = entry.qty.slice();
        nQty[i] = q;
        if (
          prev === undefined ||
          nCost < prev.cost ||
          (nCost === prev.cost && lexCompare(nQty, prev.qty) < 0)
        ) {
          next.set(nKey, { cost: nCost, total: nTotal, qty: nQty });
        }
      }
    }
    dp = next;
    // 该时段的全部供应商处理完后，按“累计到货 >= 累计需求”剪枝
    const isLastOfSlot = pos + 1 >= order.length || (order[pos + 1]?.slot ?? -1) !== slot;
    if (isLastOfSlot && (cumDemand[slot] ?? 0) > 0) {
      const need = cumDemand[slot] ?? 0;
      const pruned = new Map<number, DpEntry>();
      for (const [key, entry] of dp) {
        let cumArr = 0;
        const rest = key % arrSpace;
        for (let t = 0; t <= slot; t++) cumArr += Math.floor(rest / (base[t] ?? 1)) % ((p.slotCapacity[t] ?? 0) + 1);
        if (cumArr >= need) pruned.set(key, entry);
      }
      dp = pruned;
    }
  }

  return pickBest(p, dp, arrSpace, base, p.slotCapacity);
}

function decodeArr(key: number, arrSpace: number, base: number[], caps: number[]): number[] {
  const rest = key % arrSpace;
  return base.map((b, t) => Math.floor(rest / b) % ((caps[t] ?? 0) + 1));
}

function pickBest(
  p: Problem,
  dp: Map<number, DpEntry>,
  arrSpace: number,
  base: number[],
  caps: number[]
): SolveResult {
  const T = p.slotCapacity.length;
  let best: Candidate | null = null;
  for (const [key, entry] of dp) {
    const mask = Math.floor(key / arrSpace);
    const total = entry.total;
    const arr = decodeArr(key, arrSpace, base, caps);
    if (total < p.demand) continue;
    if (!maskSatisfiesContracts(p, mask)) continue;
    let cumArr = 0;
    let cumDem = 0;
    let okArr = true;
    for (let t = 0; t < T; t++) {
      cumArr += arr[t] ?? 0;
      cumDem += p.slotDemand[t] ?? 0;
      if (cumArr < cumDem) {
        okArr = false;
        break;
      }
    }
    if (!okArr) continue;
    const cand: Candidate = { qty: entry.qty, totalQty: total, totalCost: entry.cost };
    if (best === null || compareCandidates(cand, best) < 0) best = cand;
  }
  return {
    feasible: best !== null,
    best,
    slots: best === null ? emptySlots(p) : verifySchedule(p, best.qty),
  };
}

function emptySlots(p: Problem): SlotReport[] {
  return verifySchedule(p, p.suppliers.map(() => 0));
}

/** 枚举核验：与 DP 完全相同的约束与目标序，用于小例对照 */
export function solveEnumerate(p: Problem): SolveResult {
  validateProblem(p);
  const n = p.suppliers.length;
  const T = p.slotCapacity.length;
  const qty = new Array<number>(n).fill(0);
  let best: Candidate | null = null;

  const rec = (i: number, mask: number, total: number, cost: number, arr: number[]): void => {
    if (i === n) {
      if (total < p.demand || total > p.cap) return;
      if (!maskSatisfiesContracts(p, mask)) return;
      let cumArr = 0;
      let cumDem = 0;
      for (let t = 0; t < T; t++) {
        cumArr += arr[t] ?? 0;
        cumDem += p.slotDemand[t] ?? 0;
        if (cumArr < cumDem) return;
      }
      const cand: Candidate = { qty: qty.slice(), totalQty: total, totalCost: cost };
      if (best === null || compareCandidates(cand, best) < 0) best = cand;
      return;
    }
    const s = p.suppliers[i];
    if (s === undefined) return;
    for (const q of choicesOf(s)) {
      const nTotal = total + q;
      if (nTotal > p.cap) continue;
      const nArr = arr.slice();
      nArr[s.arrivalSlot] = (nArr[s.arrivalSlot] ?? 0) + q;
      if ((nArr[s.arrivalSlot] ?? 0) > (p.slotCapacity[s.arrivalSlot] ?? 0)) continue;
      qty[i] = q;
      rec(i + 1, q > 0 ? mask | (1 << i) : mask, nTotal, cost + priceOf(s, q), nArr);
      qty[i] = 0;
    }
  };
  rec(0, 0, 0, 0, new Array<number>(T).fill(0));

  const finalBest = best as Candidate | null;
  return {
    feasible: finalBest !== null,
    best: finalBest,
    slots: finalBest === null ? emptySlots(p) : verifySchedule(p, finalBest.qty),
  };
}
