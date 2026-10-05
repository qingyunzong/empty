import { gridTotalFeeCents } from "./billing.js";
import { computeBill } from "./engine.js";
import { Ledger } from "./ledger.js";
import { correctBill, publishBill } from "./engine.js";

const rates = [
  { start: 0, end: 3600, rateCentsPerMin: 2 },
  { start: 3600, end: 7200, rateCentsPerMin: 5 },
];

const users = [
  { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 3700 }] },
  { userId: "bob", online: [{ start: 60, end: 180 }, { start: 3660, end: 3720 }] },
];

function printBill(title: string, bill: ReturnType<typeof computeBill>): void {
  console.log(`\n== ${title} (billId=${bill.billId}) ==`);
  for (const line of bill.lines) {
    const s = line.segment;
    console.log(
      `段 ${line.segmentId}: [${s.start}, ${s.end}) 费率 ${s.rateCentsPerMin} 分/分, ` +
        `${s.minutes} 分钟, 费用 ${s.feeCents} 分`,
    );
    for (const share of line.shares) {
      console.log(`    ${share.userId}: 占用 ${share.seconds} 秒 -> ${share.amountCents} 分`);
    }
  }
  console.log(`总费用: ${bill.totalCents} 分`);
}

const bill = computeBill("B001", users, rates);
printBill("原始账单", bill);
console.log(`网格计时模型对照: ${gridTotalFeeCents(bill.lines.map((l) => l.segment))} 分`);

const ledger = new Ledger();
publishBill(ledger, bill);

// 历史更正：alice 实际下线时间应为 300 秒。
const correctedUsers = [
  { userId: "alice", online: [{ start: 10, end: 130 }, { start: 100, end: 300 }] },
  users[1]!,
];
const corrected = correctBill(ledger, bill, "B001-C1", correctedUsers, rates);
printBill("更正账单（冲正 + 新账）", corrected);
console.log(`网格计时模型对照: ${gridTotalFeeCents(corrected.lines.map((l) => l.segment))} 分`);

console.log("\n== 账本分录（已发布，不修改） ==");
for (const e of ledger.posted()) {
  console.log(`${e.type.padEnd(8)} ${e.userId.padEnd(6)} ${e.amountCents} 分  (${e.key})`);
}
console.log(`\n账本净额: alice=${ledger.balanceCents("alice")} bob=${ledger.balanceCents("bob")} 合计=${ledger.totalCents()}`);
