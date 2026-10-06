import type { ProcurementInput, ScheduleInput } from "./types.js";

export const MAX_SUPPLIERS = 8;
export const MAX_QTY = 80;

function assertInt(value: number, label: string): void {
  if (!Number.isInteger(value)) throw new Error(`${label} 必须为整数，得到 ${value}`);
}

export function validateProcurement(input: ProcurementInput): void {
  const n = input.suppliers?.length ?? 0;
  if (n < 1 || n > MAX_SUPPLIERS) {
    throw new Error(`供应商数量须在 1..${MAX_SUPPLIERS} 之间，得到 ${n}`);
  }
  assertInt(input.demand, "demand");
  assertInt(input.maxTotal, "maxTotal");
  if (input.demand < 0) throw new Error("demand 不能为负");
  if (input.maxTotal < input.demand) {
    throw new Error(`maxTotal(${input.maxTotal}) 不能小于 demand(${input.demand})`);
  }
  input.suppliers.forEach((s, i) => {
    assertInt(s.minQty, `suppliers[${i}].minQty`);
    assertInt(s.maxQty, `suppliers[${i}].maxQty`);
    if (s.minQty < 1) throw new Error(`供应商 ${s.name} 的 minQty 须 ≥ 1`);
    if (s.maxQty > MAX_QTY) {
      throw new Error(`供应商 ${s.name} 的 maxQty(${s.maxQty}) 超过上限 ${MAX_QTY}`);
    }
    if (s.minQty > s.maxQty) {
      throw new Error(`供应商 ${s.name} 的 minQty(${s.minQty}) 大于 maxQty(${s.maxQty})`);
    }
    if (!Array.isArray(s.tiers) || s.tiers.length === 0) {
      throw new Error(`供应商 ${s.name} 缺少阶梯价 tiers`);
    }
    let prev = 0;
    for (const tier of s.tiers) {
      assertInt(tier.upTo, `供应商 ${s.name} 的 tier.upTo`);
      if (tier.upTo <= prev) throw new Error(`供应商 ${s.name} 的 tiers 须按 upTo 严格递增`);
      if (tier.unitPrice < 0) throw new Error(`供应商 ${s.name} 的单价不能为负`);
      prev = tier.upTo;
    }
    const last = s.tiers[s.tiers.length - 1];
    if (last !== undefined && last.upTo < s.maxQty) {
      throw new Error(`供应商 ${s.name} 的阶梯价未覆盖到 maxQty(${s.maxQty})`);
    }
  });
  for (const [a, b] of input.mutex ?? []) {
    checkPair(a, b, n, "mutex");
  }
  for (const [a, b] of input.depends ?? []) {
    checkPair(a, b, n, "depends");
  }
}

function checkPair(a: number, b: number, n: number, label: string): void {
  for (const x of [a, b]) {
    if (!Number.isInteger(x) || x < 0 || x >= n) {
      throw new Error(`${label} 含非法供应商索引 ${x}（共 ${n} 家）`);
    }
  }
  if (a === b) throw new Error(`${label} 含自引用索引 ${a}`);
}

export function validateSchedule(input: ScheduleInput): void {
  const n = input.quantities?.length ?? 0;
  if (n < 1 || n > MAX_SUPPLIERS) {
    throw new Error(`quantities 长度须在 1..${MAX_SUPPLIERS} 之间，得到 ${n}`);
  }
  if (!Array.isArray(input.slots) || input.slots.length === 0) {
    throw new Error("slots 至少需要一个时段");
  }
  input.quantities.forEach((q, i) => {
    assertInt(q, `quantities[${i}]`);
    if (q < 0 || q > MAX_QTY) throw new Error(`quantities[${i}]=${q} 超出 0..${MAX_QTY}`);
  });
  input.slots.forEach((slot, t) => {
    assertInt(slot.capacity, `slots[${t}].capacity`);
    assertInt(slot.demand, `slots[${t}].demand`);
    if (slot.capacity < 0 || slot.demand < 0) throw new Error(`slots[${t}] 不能为负`);
  });
}
