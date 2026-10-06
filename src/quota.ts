import { QuotaExceededError } from "./errors.js";

/**
 * 租户额度账本：limit 为上限，used 为已结算量，reserved 为在途预留量。
 * 可预留空间 = limit - used - reserved。
 */
export class TenantQuota {
  private limitBytes: number;
  private usedBytes = 0;
  private reservedBytes = 0;

  constructor(limitBytes: number) {
    if (limitBytes < 0) throw new RangeError("额度上限不能为负");
    this.limitBytes = limitBytes;
  }

  get limit(): number {
    return this.limitBytes;
  }

  get used(): number {
    return this.usedBytes;
  }

  get reserved(): number {
    return this.reservedBytes;
  }

  get available(): number {
    return this.limitBytes - this.usedBytes - this.reservedBytes;
  }

  /** 预留额度；不足则拒绝，不产生任何副作用。 */
  reserve(amount: number): void {
    this.assertNonNegative(amount, "预留量");
    if (amount > this.available) {
      throw new QuotaExceededError(amount, this.available);
    }
    this.reservedBytes += amount;
  }

  /** 结束结算：核销整笔预留，按实际量计入已用量。 */
  settle(reservedAmount: number, actualAmount: number): void {
    this.assertNonNegative(reservedAmount, "预留核销量");
    this.assertNonNegative(actualAmount, "实际结算量");
    this.reservedBytes -= reservedAmount;
    this.usedBytes += actualAmount;
  }

  /** 取消释放：整笔预留退回。 */
  release(amount: number): void {
    this.assertNonNegative(amount, "释放量");
    this.reservedBytes -= amount;
  }

  /**
   * 租户缩额：只收紧未来预留，不撤销已在途的预留与已结算用量。
   * 因此缩额后 available 可能为负，属正常状态。
   */
  shrink(newLimitBytes: number): void {
    if (newLimitBytes < 0) throw new RangeError("额度上限不能为负");
    this.limitBytes = newLimitBytes;
  }

  private assertNonNegative(value: number, label: string): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${label}必须是非负有限数`);
    }
  }
}
