/**
 * 购物车定额券分摊与部分退货退款。
 *
 * 金额一律使用整数“分”，避免浮点误差。
 *
 * 规则：
 * - 定额券按商品原价（单价 × 数量）比例分摊到每个商品，向下取分到分；
 *   取分剩余（余分）按商品 ID 升序逐个补 1 分，直到分完。
 * - 券可叠加（按添加顺序逐张分摊），但任何商品应付不得为负：
 *   单张券先按剩余应付总额封顶，再按比例分摊；某商品分摊额超过其剩余应付时，
 *   超出部分在该商品处截断，并在其余商品间继续按比例重分摊。
 * - 部分退货按原分摊结果退款，不重算券：
 *   第 k 件退款额 = floor(应付总额 × 已退累计 k / 购买数量) 的增量，
 *   保证任意次序、任意批次的多次退款之和恰好等于应付总额（守恒）。
 */

export interface CartItemInput {
  id: string;
  /** 单价（分） */
  unitPrice: number;
  quantity: number;
}

export interface CouponInput {
  id: string;
  /** 定额券面额（分） */
  amount: number;
}

export interface ItemAllocation {
  id: string;
  unitPrice: number;
  quantity: number;
  /** 原价总额（分） */
  originalTotal: number;
  /** 全部分摊券额合计（分） */
  couponDiscount: number;
  /** 应付总额（分），恒 >= 0 */
  payable: number;
}

interface ItemState {
  id: string;
  unitPrice: number;
  quantity: number;
  originalTotal: number;
  couponDiscount: number;
  refundedQuantity: number;
  refundedAmount: number;
}

export class Cart {
  private readonly items = new Map<string, ItemState>();
  private readonly coupons: CouponInput[] = [];

  addItem(input: CartItemInput): this {
    if (!Number.isInteger(input.unitPrice) || input.unitPrice < 0) {
      throw new Error(`商品 ${input.id} 单价必须为非负整数分`);
    }
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new Error(`商品 ${input.id} 数量必须为正整数`);
    }
    if (this.items.has(input.id)) {
      throw new Error(`商品 ${input.id} 已存在`);
    }
    this.items.set(input.id, {
      id: input.id,
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      originalTotal: input.unitPrice * input.quantity,
      couponDiscount: 0,
      refundedQuantity: 0,
      refundedAmount: 0,
    });
    this.reallocate();
    return this;
  }

  addCoupon(input: CouponInput): this {
    if (!Number.isInteger(input.amount) || input.amount < 0) {
      throw new Error(`券 ${input.id} 面额必须为非负整数分`);
    }
    if (this.coupons.some((c) => c.id === input.id)) {
      throw new Error(`券 ${input.id} 已存在`);
    }
    this.coupons.push({ ...input });
    this.reallocate();
    return this;
  }

  /** 每个商品的分摊结果（按商品 ID 升序）。 */
  allocations(): ItemAllocation[] {
    return [...this.items.values()]
      .sort((a, b) => compareId(a.id, b.id))
      .map((it) => ({
        id: it.id,
        unitPrice: it.unitPrice,
        quantity: it.quantity,
        originalTotal: it.originalTotal,
        couponDiscount: it.couponDiscount,
        payable: it.originalTotal - it.couponDiscount,
      }));
  }

  allocationOf(itemId: string): ItemAllocation {
    const found = this.allocations().find((a) => a.id === itemId);
    if (!found) throw new Error(`商品 ${itemId} 不存在`);
    return found;
  }

  /** 全单应付总额（分）。 */
  totalPayable(): number {
    let sum = 0;
    for (const it of this.items.values()) {
      sum += it.originalTotal - it.couponDiscount;
    }
    return sum;
  }

  /** 全单已分摊券额合计（分）。 */
  totalDiscount(): number {
    let sum = 0;
    for (const it of this.items.values()) sum += it.couponDiscount;
    return sum;
  }

  /**
   * 部分退货：退还某商品 qty 件，返回退款额（分）。
   * 按原分摊退款，不重算券；退款额用累计取整差分计算，
   * 保证全部退完时退款合计恰好等于该商品应付总额。
   */
  refund(itemId: string, quantity: number): number {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`商品 ${itemId} 不存在`);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("退货数量必须为正整数");
    }
    if (item.refundedQuantity + quantity > item.quantity) {
      throw new Error(
        `商品 ${itemId} 退货数量超出可退数量（已退 ${item.refundedQuantity}/${item.quantity}）`,
      );
    }
    const payable = item.originalTotal - item.couponDiscount;
    const before = Math.floor((payable * item.refundedQuantity) / item.quantity);
    item.refundedQuantity += quantity;
    const after = Math.floor((payable * item.refundedQuantity) / item.quantity);
    const amount = after - before;
    item.refundedAmount += amount;
    return amount;
  }

  /** 某商品累计已退款额（分）。 */
  refundedAmountOf(itemId: string): number {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`商品 ${itemId} 不存在`);
    return item.refundedAmount;
  }

  /** 全单累计已退款额（分）。 */
  totalRefunded(): number {
    let sum = 0;
    for (const it of this.items.values()) sum += it.refundedAmount;
    return sum;
  }

  /** 重新计算全部券的分摊（退货不触发重算，仅加商品/券时触发）。 */
  private reallocate(): void {
    for (const it of this.items.values()) it.couponDiscount = 0;
    for (const coupon of this.coupons) {
      this.allocateCoupon(coupon.amount);
    }
  }

  /**
   * 单张券分摊：按原价比例向下取分，余分按商品 ID 升序补齐；
   * 以各商品剩余应付为上限（不得负价），截断部分在其余商品间重分摊。
   */
  private allocateCoupon(amount: number): void {
    const states = [...this.items.values()];
    // 每个商品的分摊上限即其原价总额（累计分摊不得超过原价，否则负价）。
    const cap = new Map<string, number>();
    let totalHeadroom = 0;
    for (const it of states) {
      cap.set(it.id, it.originalTotal);
      totalHeadroom += it.originalTotal - it.couponDiscount;
    }
    // 券额先按整单剩余应付封顶，保证不会分摊出负价。
    let remaining = Math.min(amount, totalHeadroom);

    // 迭代：比例分摊 -> 超出剩余应付的商品截断 -> 余额在其余商品间重分摊。
    let active = states.filter((it) => (cap.get(it.id) ?? 0) - it.couponDiscount > 0);
    while (remaining > 0 && active.length > 0) {
      let totalWeight = 0;
      for (const it of active) totalWeight += it.originalTotal;

      if (totalWeight === 0) {
        // 全部商品原价为 0 但仍有剩余应付（理论上不会发生，防御处理）：
        // 按商品 ID 升序逐个补 1 分。
        const sorted = [...active].sort((a, b) => compareId(a.id, b.id));
        let progressed = false;
        for (const it of sorted) {
          if (remaining === 0) break;
          const room = (cap.get(it.id) ?? 0) - it.couponDiscount;
          if (room > 0) {
            it.couponDiscount += 1;
            remaining -= 1;
            progressed = true;
          }
        }
        if (!progressed) break;
        active = active.filter(
          (it) => (cap.get(it.id) ?? 0) - it.couponDiscount > 0,
        );
        continue;
      }

      const shares = new Map<string, number>();
      let capped = false;
      for (const it of active) {
        const share = Math.floor((remaining * it.originalTotal) / totalWeight);
        const room = (cap.get(it.id) ?? 0) - it.couponDiscount;
        if (share > room) {
          // 截断：该商品分满，余额留待下一轮在其余商品间重分摊。
          it.couponDiscount += room;
          remaining -= room;
          capped = true;
        } else {
          shares.set(it.id, share);
        }
      }

      if (capped) {
        active = active.filter(
          (it) => (cap.get(it.id) ?? 0) - it.couponDiscount > 0,
        );
        continue;
      }

      // 无截断：落实取分份额，余分按商品 ID 升序逐个补 1 分。
      let distributed = 0;
      for (const it of active) {
        const share = shares.get(it.id) ?? 0;
        it.couponDiscount += share;
        distributed += share;
      }
      let remainder = remaining - distributed;
      const sorted = [...active].sort((a, b) => compareId(a.id, b.id));
      while (remainder > 0) {
        let progressed = false;
        for (const it of sorted) {
          if (remainder === 0) break;
          const room = (cap.get(it.id) ?? 0) - it.couponDiscount;
          if (room > 0) {
            it.couponDiscount += 1;
            remainder -= 1;
            progressed = true;
          }
        }
        if (!progressed) break;
      }
      remaining = 0;
    }
  }
}

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
