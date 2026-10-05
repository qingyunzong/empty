import { billBySegments, BillSegment, RateInterval, SegmentBill } from "./billing.js";
import { Interval, intersect, mergeIntervals } from "./intervals.js";
import { Ledger, LedgerEntry } from "./ledger.js";
import { Occupation, settleAccount, Share } from "./settlement.js";

/** 一次计费运行的输入。 */
export interface BillingRun {
  /** 运行 ID：确定性条目 ID 的前缀，重放同一 run 幂等。 */
  runId: string;
  accountId: string;
  /** 上线区间（可重叠，内部先求并集）。 */
  online: Interval[];
  rates: RateInterval[];
  /** 各用户占用区间（按用户分别求并集）。 */
  users: { userId: string; online: Interval[] }[];
}

export interface RunResult {
  runId: string;
  bill: SegmentBill;
  /** 每段各用户占用秒与分账。 */
  settlements: { segment: BillSegment; occupations: Occupation[]; shares: Share[] }[];
  totalFeeCents: number;
  /** 本次新入账条数（重放时为 0）。 */
  appendedEntries: number;
}

/**
 * 计费引擎：run → 分段计费 → 逐段分账 → 台账条目。
 * 条目 ID 由 (runId, 段号, userId) 确定性生成，断点重放幂等。
 */
export class BillingEngine {
  constructor(private readonly ledger: Ledger) {}

  get ledgerRef(): Ledger {
    return this.ledger;
  }

  /** 计算各用户在某段内的占用秒数。 */
  static occupationsForSegment(
    segment: Interval,
    users: readonly { userId: string; online: Interval[] }[],
  ): Occupation[] {
    const occ: Occupation[] = [];
    for (const u of users) {
      const merged = mergeIntervals(u.online);
      let seconds = 0;
      for (const iv of merged) {
        const hit = intersect(iv, segment);
        if (hit) seconds += hit.end - hit.start;
      }
      if (seconds > 0) occ.push({ userId: u.userId, seconds });
    }
    return occ;
  }

  /** 应用一次运行：计费、分账、入账（幂等）。 */
  applyRun(run: BillingRun): RunResult {
    const bill = billBySegments(run.online, run.rates);
    const segSettlements = bill.segments.map((segment) => {
      const occupations = BillingEngine.occupationsForSegment(segment, run.users);
      return {
        segmentId: segmentIdOf(run.runId, segment),
        feeCents: segment.feeCents,
        occupations,
      };
    });
    const settled = settleAccount(segSettlements);

    let appended = 0;
    settled.perSegment.forEach((seg, i) => {
      for (const share of seg.shares) {
        const entry: LedgerEntry = {
          id: `${run.runId}/${seg.segmentId}/${share.userId}`,
          runId: run.runId,
          accountId: run.accountId,
          segmentId: seg.segmentId,
          userId: share.userId,
          kind: "charge",
          amountCents: share.shareCents,
        };
        if (this.ledger.append(entry)) appended += 1;
      }
      void i;
    });

    return {
      runId: run.runId,
      bill,
      settlements: settled.perSegment.map((seg, i) => ({
        segment: bill.segments[i]!,
        occupations: segSettlements[i]!.occupations,
        shares: seg.shares,
      })),
      totalFeeCents: bill.totalFeeCents,
      appendedEntries: appended,
    };
  }

  /**
   * 历史更正：对旧 run 的每条已发布账发冲正账，再以新 run 入账。
   * 不修改任何已发布条目。
   */
  correctRun(oldRunId: string, newRun: BillingRun, memo?: string): RunResult {
    const published = this.ledger
      .published()
      .filter((e) => e.runId === oldRunId && e.kind === "charge");
    if (published.length === 0) {
      throw new Error(`找不到已发布账：run ${oldRunId}`);
    }
    for (const entry of published) {
      this.ledger.reverse(
        entry.id,
        `${newRun.runId}/reversal/${entry.id}`,
        memo ?? `冲正 ${oldRunId}`,
      );
    }
    return this.applyRun(newRun);
  }

  /**
   * 断点重放：从 checkpoint 之后重新应用 runs。
   * 因条目 ID 幂等，重放后台账与一次性跑完完全一致。
   */
  replay(runs: readonly BillingRun[]): RunResult[] {
    return runs.map((run) => this.applyRun(run));
  }
}

export function segmentIdOf(runId: string, segment: BillSegment): string {
  return `seg${segment.index}@${segment.start}-${segment.end}`;
}
