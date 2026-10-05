import { createHash } from "node:crypto";

export type EntryType = "charge" | "reversal";

/**
 * 账本条目。已发布的账目不可修改：
 * 历史更正通过追加 type="reversal" 的冲正账实现，原条目保持原样。
 */
export interface LedgerEntry {
  /** 幂等键：同一键重复入账只会生效一次。 */
  key: string;
  billId: string;
  type: EntryType;
  userId: string;
  segmentId: string;
  amountCents: number;
  memo: string;
}

export class Ledger {
  private readonly entries = new Map<string, LedgerEntry>();

  /**
   * 入账（幂等）。返回 true 表示新入账，false 表示相同键已存在被跳过。
   * 相同键但内容不一致视为冲突，直接抛错。
   */
  post(entry: LedgerEntry): boolean {
    const frozen = Object.freeze({ ...entry });
    const existing = this.entries.get(entry.key);
    if (existing) {
      if (
        existing.amountCents !== entry.amountCents ||
        existing.userId !== entry.userId ||
        existing.billId !== entry.billId ||
        existing.type !== entry.type ||
        existing.segmentId !== entry.segmentId
      ) {
        throw new Error(`幂等键冲突: ${entry.key}`);
      }
      return false;
    }
    this.entries.set(entry.key, frozen);
    return true;
  }

  /** 已发布条目（按入账顺序），返回副本，外部无法篡改账本。 */
  posted(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  size(): number {
    return this.entries.size;
  }

  balanceCents(userId: string): number {
    let sum = 0;
    for (const e of this.entries.values()) {
      if (e.userId === userId) sum += e.amountCents;
    }
    return sum;
  }

  totalCents(): number {
    let sum = 0;
    for (const e of this.entries.values()) sum += e.amountCents;
    return sum;
  }

  /** 状态指纹：用于断点重放后比对账本一致性。 */
  hash(): string {
    const hash = createHash("sha256");
    for (const e of this.entries.values()) {
      hash.update(
        `${e.key}|${e.billId}|${e.type}|${e.userId}|${e.segmentId}|${e.amountCents}\n`,
      );
    }
    return hash.digest("hex");
  }

  /** 深拷贝当前账本（用于断点快照）。 */
  clone(): Ledger {
    const copy = new Ledger();
    for (const e of this.entries.values()) copy.post({ ...e });
    return copy;
  }
}
