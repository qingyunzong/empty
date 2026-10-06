import { orderCost } from "./pricing.js";
import type { ProcurementInput, ProcurementResult } from "./types.js";

interface Entry {
  cost: number;
  vec: number[];
}

function vecLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function betterEntry(a: Entry, b: Entry): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  return vecLess(a.vec, b.vec);
}

export function maskFeasible(
  mask: number,
  mutex: [number, number][],
  depends: [number, number][],
): boolean {
  for (const [a, b] of mutex) {
    if ((mask & (1 << a)) !== 0 && (mask & (1 << b)) !== 0) return false;
  }
  for (const [a, b] of depends) {
    if ((mask & (1 << a)) !== 0 && (mask & (1 << b)) === 0) return false;
  }
  return true;
}

function toResult(entry: (Entry & { total: number }) | null, demand: number, n: number): ProcurementResult {
  if (entry === null) {
    return {
      feasible: false,
      quantities: new Array<number>(n).fill(0),
      totalQuantity: 0,
      totalCost: 0,
      overPurchase: 0,
    };
  }
  return {
    feasible: true,
    quantities: entry.vec,
    totalQuantity: entry.total,
    totalCost: entry.cost,
    overPurchase: entry.total - demand,
  };
}

function betterFinal(a: Entry & { total: number }, b: Entry & { total: number }, demand: number): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost;
  const overA = a.total - demand;
  const overB = b.total - demand;
  if (overA !== overB) return overA < overB;
  return vecLess(a.vec, b.vec);
}

export function solveProcurement(input: ProcurementInput): ProcurementResult {
  const n = input.suppliers.length;
  const cap = input.maxTotal;
  const mutex = input.mutex ?? [];
  const depends = input.depends ?? [];
  const stride = cap + 1;

  let layer = new Map<number, Entry>();
  layer.set(0, { cost: 0, vec: new Array<number>(n).fill(0) });

  for (let i = 0; i < n; i++) {
    const supplier = input.suppliers[i];
    if (supplier === undefined) continue;
    const next = new Map<number, Entry>();
    const consider = (key: number, cand: Entry): void => {
      const cur = next.get(key);
      if (cur === undefined || betterEntry(cand, cur)) next.set(key, cand);
    };
    for (const [key, entry] of layer) {
      const mask = Math.floor(key / stride);
      const total = key % stride;
      consider(key, entry);
      for (let q = supplier.minQty; q <= supplier.maxQty && total + q <= cap; q++) {
        const nkey = (mask | (1 << i)) * stride + (total + q);
        const vec = entry.vec.slice();
        vec[i] = q;
        consider(nkey, { cost: entry.cost + orderCost(supplier, q), vec });
      }
    }
    layer = next;
  }

  let best: (Entry & { total: number }) | null = null;
  for (const [key, entry] of layer) {
    const mask = Math.floor(key / stride);
    const total = key % stride;
    if (total < input.demand) continue;
    if (!maskFeasible(mask, mutex, depends)) continue;
    const cand = { cost: entry.cost, vec: entry.vec, total };
    if (best === null || betterFinal(cand, best, input.demand)) best = cand;
  }
  return toResult(best, input.demand, n);
}

export function enumerateProcurement(input: ProcurementInput): ProcurementResult {
  const n = input.suppliers.length;
  const mutex = input.mutex ?? [];
  const depends = input.depends ?? [];
  const vec = new Array<number>(n).fill(0);
  let best: (Entry & { total: number }) | null = null;

  const rec = (i: number, mask: number, total: number, cost: number): void => {
    if (total > input.maxTotal) return;
    if (i === n) {
      if (total < input.demand) return;
      if (!maskFeasible(mask, mutex, depends)) return;
      const cand = { cost, vec: vec.slice(), total };
      if (best === null || betterFinal(cand, best, input.demand)) best = cand;
      return;
    }
    const supplier = input.suppliers[i];
    if (supplier === undefined) return;
    vec[i] = 0;
    rec(i + 1, mask, total, cost);
    for (let q = supplier.minQty; q <= supplier.maxQty; q++) {
      vec[i] = q;
      rec(i + 1, mask | (1 << i), total + q, cost + orderCost(supplier, q));
    }
    vec[i] = 0;
  };
  rec(0, 0, 0, 0);
  return toResult(best, input.demand, n);
}

export function enumerationSize(input: ProcurementInput): number {
  let size = 1;
  for (const s of input.suppliers) {
    size *= s.maxQty - s.minQty + 2;
  }
  return size;
}
