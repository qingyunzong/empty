/** 领域模型与输入校验 */

/** 全量阶梯单价：订单总量落入该档时，整单按 unitPrice 计价 */
export interface Tier {
  /** 档位上界（含），最后一档必须 >= 供应商最大可订量 */
  upTo: number;
  unitPrice: number;
}

export interface Supplier {
  id: string;
  /** 起订量：订则为 [minQty, maxQty] 内整数，否则为 0 */
  minQty: number;
  /** 最大可订量，默认 80 */
  maxQty?: number;
  /** 到货时段（0 起） */
  arrivalSlot: number;
  tiers: Tier[];
}

export interface Problem {
  /** 总需求：总下单量须 >= demand 且 <= cap */
  demand: number;
  /** 总量上限 */
  cap: number;
  suppliers: Supplier[];
  /** 二元互斥：[i, j] 表示两家不可同时下单（下标） */
  exclusions?: Array<[number, number]>;
  /** 二元依赖：[a, b] 表示若向 a 下单则必须也向 b 下单 */
  dependencies?: Array<[number, number]>;
  /** 每时段配送共享容量（该时段所有供应商到货量之和的上限） */
  slotCapacity: number[];
  /** 每时段需求消耗（用于逐时段缺货验证：累计到货 >= 累计需求） */
  slotDemand: number[];
}

export const DEFAULT_MAX_QTY = 80;

export function maxQtyOf(s: Supplier): number {
  return s.maxQty ?? DEFAULT_MAX_QTY;
}

/** 全量阶梯计价：按 q 所在档位的单价乘以全部数量 */
export function priceOf(s: Supplier, q: number): number {
  if (q === 0) return 0;
  for (const t of s.tiers) {
    if (q <= t.upTo) return t.unitPrice * q;
  }
  throw new Error(`供应商 ${s.id} 的阶梯价未覆盖数量 ${q}`);
}

export function validateProblem(p: Problem): void {
  const n = p.suppliers.length;
  if (!Number.isInteger(p.demand) || p.demand < 0) throw new Error("demand 须为非负整数");
  if (!Number.isInteger(p.cap) || p.cap < p.demand) throw new Error("cap 须为整数且 >= demand");
  if (n < 1 || n > 8) throw new Error("供应商数量须在 1..8 之间");
  const T = p.slotCapacity.length;
  if (T < 1) throw new Error("slotCapacity 至少一个时段");
  if (p.slotDemand.length !== T) throw new Error("slotDemand 与 slotCapacity 时段数须一致");
  for (const c of p.slotCapacity) {
    if (!Number.isInteger(c) || c < 0) throw new Error("时段容量须为非负整数");
  }
  for (const d of p.slotDemand) {
    if (!Number.isInteger(d) || d < 0) throw new Error("时段需求须为非负整数");
  }
  const ids = new Set<string>();
  p.suppliers.forEach((s, i) => {
    if (!s.id || ids.has(s.id)) throw new Error(`供应商 id 缺失或重复: ${s.id}`);
    ids.add(s.id);
    if (!Number.isInteger(s.minQty) || s.minQty < 1) throw new Error(`${s.id}: minQty 须为正整数`);
    const mq = maxQtyOf(s);
    if (!Number.isInteger(mq) || mq < s.minQty) throw new Error(`${s.id}: maxQty 须 >= minQty`);
    if (mq > DEFAULT_MAX_QTY) throw new Error(`${s.id}: maxQty 不可超过 ${DEFAULT_MAX_QTY}`);
    if (!Number.isInteger(s.arrivalSlot) || s.arrivalSlot < 0 || s.arrivalSlot >= T) {
      throw new Error(`${s.id}: arrivalSlot 须在 0..${T - 1}`);
    }
    if (!Array.isArray(s.tiers) || s.tiers.length === 0) throw new Error(`${s.id}: 缺少阶梯价`);
    let prev = 0;
    for (const t of s.tiers) {
      if (!Number.isInteger(t.upTo) || t.upTo <= prev) throw new Error(`${s.id}: 阶梯 upTo 须严格递增`);
      if (!(t.unitPrice >= 0)) throw new Error(`${s.id}: 单价须非负`);
      prev = t.upTo;
    }
    const last = s.tiers[s.tiers.length - 1];
    if (last === undefined || last.upTo < mq) throw new Error(`${s.id}: 阶梯价须覆盖到 maxQty=${mq}`);
    void i;
  });
  const checkPair = (pair: [number, number], kind: string) => {
    const [a, b] = pair;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n || a === b) {
      throw new Error(`${kind} 下标非法: [${a}, ${b}]`);
    }
  };
  (p.exclusions ?? []).forEach((pr) => checkPair(pr, "exclusions"));
  (p.dependencies ?? []).forEach((pr) => checkPair(pr, "dependencies"));
}
