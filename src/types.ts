/** 阶梯档位：购买数量达到 minQty 时，全部数量按 unitPriceCents 计价（全量阶梯单价） */
export interface Tier {
  minQty: number;
  unitPriceCents: number;
}

/** 运费规则：商品金额（不含运费）达到 freeAboveCents 免运费，否则收 feeCents */
export interface ShippingRule {
  freeAboveCents: number;
  feeCents: number;
}

export interface Supplier {
  id: string;
  /** 起订量：要么不买（0），要么 >= moq */
  moq: number;
  /** 按 minQty 升序 */
  tiers: Tier[];
  shipping: ShippingRule;
}

export interface Allocation {
  supplierId: string;
  qty: number;
  unitPriceCents: number;
  goodsCents: number;
  shippingCents: number;
  totalCents: number;
}

export interface Solution {
  feasible: boolean;
  demand: number;
  totalCents: number;
  supplierCount: number;
  allocations: Allocation[];
}
