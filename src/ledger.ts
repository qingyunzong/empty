/**
 * 台账：仅追加（append-only）。已发布条目不可改，
 * 历史更正通过冲正账（reversal，金额为负并引用原条目）加新账完成。
 * 条目 ID 为幂等键：同 ID 同内容重复追加被忽略，同 ID 不同内容报错，
 * 因此断点重放不会产生重复账。
 */
export type EntryKind = "charge" | "reversal";

export interface LedgerEntry {
  /** 幂等键，由产生方确定性地生成。 */
  id: string;
  runId: string;
  accountId: string;
  segmentId: string;
  userId: string;
  kind: EntryKind;
  /** 冲正账为负数。 */
  amountCents: number;
  /** 仅冲正账：被冲正的原条目 ID。 */
  reverses?: string;
  memo?: string;
}

export interface Checkpoint {
  entryCount: number;
  publishedCount: number;
}

export class Ledger {
  private entries: LedgerEntry[] = [];
  private byId = new Map<string, LedgerEntry>();
  private publishedCount = 0;

  /** 追加条目。返回 true 表示新入账，false 表示幂等命中（已存在同内容条目）。 */
  append(entry: LedgerEntry): boolean {
    const existing = this.byId.get(entry.id);
    if (existing) {
      if (!sameEntry(existing, entry)) {
        throw new Error(`幂等冲突：条目 ${entry.id} 已存在且内容不同`);
      }
      return false;
    }
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    return true;
  }

  /** 发布当前全部未发布条目，返回新发布条数。发布后条目不可变。 */
  publish(): number {
    const newly = this.entries.length - this.publishedCount;
    this.publishedCount = this.entries.length;
    return newly;
  }

  isPublished(id: string): boolean {
    const idx = this.entries.findIndex((e) => e.id === id);
    return idx >= 0 && idx < this.publishedCount;
  }

  get(id: string): LedgerEntry | undefined {
    return this.byId.get(id);
  }

  /**
   * 对已发布条目做历史更正：追加一条冲正账（不改动原条目）。
   * 返回冲正条目 ID。
   */
  reverse(publishedId: string, reversalId: string, memo?: string): string {
    if (!this.isPublished(publishedId)) {
      throw new Error(`只能冲正已发布条目：${publishedId}`);
    }
    const orig = this.byId.get(publishedId)!;
    if (orig.kind === "reversal") {
      throw new Error(`不能冲正一条冲正账：${publishedId}`);
    }
    const reversal: LedgerEntry = {
      id: reversalId,
      runId: orig.runId,
      accountId: orig.accountId,
      segmentId: orig.segmentId,
      userId: orig.userId,
      kind: "reversal",
      amountCents: -orig.amountCents,
      reverses: publishedId,
      ...(memo !== undefined ? { memo } : {}),
    };
    this.append(reversal);
    return reversalId;
  }

  /** 断点：当前条目数与已发布数。 */
  checkpoint(): Checkpoint {
    return { entryCount: this.entries.length, publishedCount: this.publishedCount };
  }

  all(): readonly LedgerEntry[] {
    return this.entries;
  }

  published(): readonly LedgerEntry[] {
    return this.entries.slice(0, this.publishedCount);
  }

  /** 某账户当前净额（含冲正）。 */
  netCents(accountId: string): number {
    return this.entries
      .filter((e) => e.accountId === accountId)
      .reduce((sum, e) => sum + e.amountCents, 0);
  }

  /** 序列化/反序列化，用于断点续放。 */
  toJSON(): { entries: LedgerEntry[]; publishedCount: number } {
    return { entries: this.entries.map((e) => ({ ...e })), publishedCount: this.publishedCount };
  }

  static fromJSON(data: { entries: LedgerEntry[]; publishedCount: number }): Ledger {
    const ledger = new Ledger();
    for (const e of data.entries) ledger.append({ ...e });
    ledger.publishN(data.publishedCount);
    return ledger;
  }

  private publishN(n: number): void {
    if (n > this.entries.length) throw new Error("publishedCount 超过条目数");
    this.publishedCount = n;
  }
}

function sameEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  return (
    a.id === b.id &&
    a.runId === b.runId &&
    a.accountId === b.accountId &&
    a.segmentId === b.segmentId &&
    a.userId === b.userId &&
    a.kind === b.kind &&
    a.amountCents === b.amountCents &&
    a.reverses === b.reverses &&
    a.memo === b.memo
  );
}
