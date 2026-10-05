import { RateInterval, Segment, buildSegments, totalFeeCents } from "./billing.js";
import {
  Interval,
  coveredSeconds,
  intersectIntervals,
  unionIntervals,
} from "./interval.js";
import { Ledger, LedgerEntry } from "./ledger.js";
import { Share, Usage, splitBySeconds } from "./settlement.js";

/** 一个用户的上线记录。 */
export interface UserUsage {
  userId: string;
  online: Interval[];
}

/** 账单中的一行：一个来源段及其费用与分账。 */
export interface BillLine {
  segmentId: string;
  segment: Segment;
  shares: Share[];
}

export interface Bill {
  billId: string;
  lines: BillLine[];
  totalCents: number;
  entries: LedgerEntry[];
}

function userSecondsInSegment(unioned: Interval[], segment: Segment): number {
  return coveredSeconds(intersectIntervals(unioned, [segment]));
}

/**
 * 计算账单：
 * 1. 每个用户的上线区间各自求并集；
 * 2. 全体用户的并集再合并，与费率区间求交得到来源段；
 * 3. 每段向上计分钟乘费率得到段费用；
 * 4. 段费用按各用户在该段内的占用秒数比例分账（向下取分 + 余分按精确余数、ID 分配）。
 * 守恒保证：每段 Σ 分账 = 段费用；整单 Σ 段费用 = 总费用。
 */
export function computeBill(
  billId: string,
  users: UserUsage[],
  rates: RateInterval[],
): Bill {
  const seen = new Set<string>();
  const unionedByUser = new Map<string, Interval[]>();
  for (const u of users) {
    if (seen.has(u.userId)) throw new Error(`用户重复: ${u.userId}`);
    seen.add(u.userId);
    unionedByUser.set(u.userId, unionIntervals(u.online));
  }

  const allOnline = users.flatMap((u) => u.online);
  const segments = buildSegments(allOnline, rates);

  const lines: BillLine[] = segments.map((segment, index) => {
    const segmentId = `${billId}:seg${index}`;
    const usage: Usage[] = users.map((u) => ({
      userId: u.userId,
      seconds: userSecondsInSegment(unionedByUser.get(u.userId)!, segment),
    }));
    const shares = splitBySeconds(segment.feeCents, usage).filter(
      (s) => s.seconds > 0,
    );
    const allocated = shares.reduce((sum, s) => sum + s.amountCents, 0);
    if (allocated !== segment.feeCents) {
      throw new Error(`段内分账不守恒: ${segmentId} ${allocated} != ${segment.feeCents}`);
    }
    return { segmentId, segment, shares };
  });

  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    for (const share of line.shares) {
      if (share.amountCents === 0) continue;
      entries.push({
        key: `${line.segmentId}:${share.userId}:charge`,
        billId,
        type: "charge",
        userId: share.userId,
        segmentId: line.segmentId,
        amountCents: share.amountCents,
        memo: `段 ${line.segmentId} 分账 ${share.amountCents} 分`,
      });
    }
  }

  const total = totalFeeCents(segments);
  const entrySum = entries.reduce((sum, e) => sum + e.amountCents, 0);
  if (entrySum !== total) {
    throw new Error(`整单金额不守恒: 分录合计 ${entrySum} != 总费用 ${total}`);
  }
  return { billId, lines, totalCents: total, entries };
}

/** 发布账单：把全部分录入账（幂等）。 */
export function publishBill(ledger: Ledger, bill: Bill): void {
  for (const entry of bill.entries) ledger.post(entry);
}

/**
 * 历史更正：对原账单逐笔发冲正账（金额取反），再按更正后的数据计算并入新账。
 * 已发布的原分录不做任何修改。
 */
export function correctBill(
  ledger: Ledger,
  original: Bill,
  correctedBillId: string,
  correctedUsers: UserUsage[],
  rates: RateInterval[],
): Bill {
  const published = new Set(ledger.posted().map((e) => e.key));
  for (const entry of original.entries) {
    if (!published.has(entry.key)) {
      throw new Error(`原账单分录未发布，无法冲正: ${entry.key}`);
    }
  }
  for (const entry of original.entries) {
    ledger.post({
      key: `${correctedBillId}:rev:${entry.key}`,
      billId: correctedBillId,
      type: "reversal",
      userId: entry.userId,
      segmentId: entry.segmentId,
      amountCents: -entry.amountCents,
      memo: `冲正 ${entry.key}`,
    });
  }
  const corrected = computeBill(correctedBillId, correctedUsers, rates);
  publishBill(ledger, corrected);
  return corrected;
}
