import type { Supplier, Tier } from "./types";

/** 阶梯全量单价：取 minQty <= qty 的最高档，全部数量按该档单价计 */
export function unitPriceCentsFor(tiers: Tier[], qty: number): number {
  let price = -1;
  for (const tier of tiers) {
    if (tier.minQty <= qty) price = tier.unitPriceCents;
    else break;
  }
  if (price < 0) {
    throw new Error(`no tier covers qty=${qty} (tiers must start at minQty<=1)`);
  }
  return price;
}

/** 单供应商费用（整数分）。qty=0 表示不采购，费用 0；0<qty<moq 不可行 */
export function supplierCostCents(supplier: Supplier, qty: number): number {
  if (qty === 0) return 0;
  if (qty < supplier.moq) return Number.POSITIVE_INFINITY;
  const goods = qty * unitPriceCentsFor(supplier.tiers, qty);
  const shipping =
    goods >= supplier.shipping.freeAboveCents ? 0 : supplier.shipping.feeCents;
  return goods + shipping;
}

/** 费用明细（仅对可行 qty 调用） */
export function supplierCostBreakdown(
  supplier: Supplier,
  qty: number,
): { unitPriceCents: number; goodsCents: number; shippingCents: number; totalCents: number } {
  const unitPriceCents = unitPriceCentsFor(supplier.tiers, qty);
  const goodsCents = qty * unitPriceCents;
  const shippingCents =
    goodsCents >= supplier.shipping.freeAboveCents ? 0 : supplier.shipping.feeCents;
  return { unitPriceCents, goodsCents, shippingCents, totalCents: goodsCents + shippingCents };
}
