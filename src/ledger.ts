/**
 * 多订单分账账本。
 *
 * 分账跨多个订单：每个接收人有全局上下限与全局权重，账本把"所有未退款
 * 订单的总额"作为一个整体，用 split() 在未锁定接收人之间重新分配。
 *
 * - addOrder：登记订单后重算全局分配。
 * - refund：撤销该订单的金额（原订单分配随之失效），对其余未锁定订单
 *   的总额重新分配；已锁定接收人的金额不动。
 * - lock/unlock：锁定即冻结接收人当前份额，后续重算不再变动；
 *   解锁后重新参与分配。
 *
 * 任何重算若不可行（如下限和超过剩余可分配额、锁定额超过剩余总额），
 * 本次操作回滚并抛出 SplitError，账本保持操作前状态。
 */

import {
  normalizeRecipients,
  splitNormalized,
  SplitError,
  type NormalizedRecipient,
  type Recipient,
} from "./split.js";

export class SplitLedger {
  private readonly recipients: NormalizedRecipient[];
  private readonly orders = new Map<string, number>();
  private readonly refunded = new Set<string>();
  private readonly lockedAmounts = new Map<string, number>();
  private current = new Map<string, number>();

  constructor(recipients: readonly Recipient[]) {
    this.recipients = normalizeRecipients(recipients);
    for (const r of this.recipients) this.current.set(r.id, 0);
  }

  /** 登记一笔订单并重新分配全部未退款订单的总额。 */
  addOrder(orderId: string, amount: number): void {
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw new SplitError("INVALID_INPUT", "orderId must be a non-empty string");
    }
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new SplitError("INVALID_INPUT", "amount must be a non-negative safe integer");
    }
    if (this.orders.has(orderId)) {
      throw new SplitError("INVALID_INPUT", `duplicate order id: ${orderId}`);
    }
    this.orders.set(orderId, amount);
    try {
      this.recompute();
    } catch (err) {
      this.orders.delete(orderId);
      throw err;
    }
  }

  /**
   * 退款：撤销该订单的金额，重新分配其余未退款订单。
   * 锁定接收人的份额保持不变。
   */
  refund(orderId: string): void {
    if (!this.orders.has(orderId)) {
      throw new SplitError("INVALID_INPUT", `unknown order id: ${orderId}`);
    }
    if (this.refunded.has(orderId)) {
      throw new SplitError("INVALID_INPUT", `order already refunded: ${orderId}`);
    }
    this.refunded.add(orderId);
    try {
      this.recompute();
    } catch (err) {
      this.refunded.delete(orderId);
      throw err;
    }
  }

  /** 冻结接收人当前份额（幂等）。 */
  lock(recipientId: string): void {
    this.requireRecipient(recipientId);
    if (this.lockedAmounts.has(recipientId)) return;
    this.lockedAmounts.set(recipientId, this.current.get(recipientId)!);
  }

  /** 解冻接收人并立即重新分配（失败则回滚）。 */
  unlock(recipientId: string): void {
    this.requireRecipient(recipientId);
    if (!this.lockedAmounts.has(recipientId)) return;
    const snapshot = this.lockedAmounts.get(recipientId)!;
    this.lockedAmounts.delete(recipientId);
    try {
      this.recompute();
    } catch (err) {
      this.lockedAmounts.set(recipientId, snapshot);
      throw err;
    }
  }

  allocationOf(recipientId: string): number {
    this.requireRecipient(recipientId);
    return this.current.get(recipientId)!;
  }

  allocations(): Record<string, number> {
    return Object.fromEntries(this.current);
  }

  /** 未退款订单的总额。 */
  activeTotal(): number {
    let sum = 0;
    for (const [id, amount] of this.orders) {
      if (!this.refunded.has(id)) sum += amount;
    }
    return sum;
  }

  isLocked(recipientId: string): boolean {
    return this.lockedAmounts.has(recipientId);
  }

  isRefunded(orderId: string): boolean {
    return this.refunded.has(orderId);
  }

  private requireRecipient(recipientId: string): void {
    if (!this.current.has(recipientId)) {
      throw new SplitError("INVALID_INPUT", `unknown recipient id: ${recipientId}`);
    }
  }

  private recompute(): void {
    const active = this.activeTotal();
    let lockedSum = 0;
    for (const amount of this.lockedAmounts.values()) lockedSum += amount;
    const rest = active - lockedSum;
    if (rest < 0) {
      throw new SplitError(
        "INFEASIBLE",
        `locked amounts (${lockedSum}) exceed active order total (${active})`,
      );
    }
    const unlocked = this.recipients.filter((r) => !this.lockedAmounts.has(r.id));
    const next = new Map<string, number>();
    for (const [id, amount] of this.lockedAmounts) next.set(id, amount);
    if (unlocked.length === 0) {
      if (rest !== 0) {
        throw new SplitError(
          "INFEASIBLE",
          `all recipients locked but ${rest} remains unallocated`,
        );
      }
    } else {
      const shares = splitNormalized(rest, unlocked);
      unlocked.forEach((r, i) => next.set(r.id, shares[i]!));
    }
    this.current = next;
  }
}
