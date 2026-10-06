import type { Supplier } from "./types.js";

export function unitPriceFor(supplier: Supplier, qty: number): number {
  for (const tier of supplier.tiers) {
    if (qty <= tier.upTo) return tier.unitPrice;
  }
  throw new Error(`供应商 ${supplier.name} 的阶梯价未覆盖数量 ${qty}`);
}

export function orderCost(supplier: Supplier, qty: number): number {
  if (qty === 0) return 0;
  return qty * unitPriceFor(supplier, qty);
}
