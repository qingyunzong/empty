import { RateInterval } from "./billing.js";
import { Bill, UserUsage, computeBill, correctBill, publishBill } from "./engine.js";
import { Ledger } from "./ledger.js";

/** 清算流水可处理的命令。 */
export type Command =
  | { kind: "publish"; billId: string; users: UserUsage[]; rates: RateInterval[] }
  | {
      kind: "correct";
      billId: string;
      originalBillId: string;
      users: UserUsage[];
      rates: RateInterval[];
    };

/** 断点：已处理命令序号 + 账本快照。 */
export interface Checkpoint {
  seq: number;
  ledgerHash: string;
  ledger: Ledger;
  bills: Map<string, Bill>;
}

/**
 * 清算流水线：按序处理命令，支持断点快照与重放。
 * 所有入账都带确定性幂等键，因此从断点重放（甚至重复重放）结果一致。
 */
export class BillingPipeline {
  private ledger = new Ledger();
  private bills = new Map<string, Bill>();
  private seq = 0;

  apply(command: Command): Bill {
    let bill: Bill;
    if (command.kind === "publish") {
      bill = computeBill(command.billId, command.users, command.rates);
      publishBill(this.ledger, bill);
    } else {
      const original = this.bills.get(command.originalBillId);
      if (!original) throw new Error(`原账单不存在: ${command.originalBillId}`);
      bill = correctBill(
        this.ledger,
        original,
        command.billId,
        command.users,
        command.rates,
      );
    }
    this.bills.set(bill.billId, bill);
    this.seq++;
    return bill;
  }

  /** 打断点：保存当前序号与账本深拷贝。 */
  checkpoint(): Checkpoint {
    return {
      seq: this.seq,
      ledgerHash: this.ledger.hash(),
      ledger: this.ledger.clone(),
      bills: new Map(this.bills),
    };
  }

  /** 从断点恢复出一条可继续重放的流水线。 */
  static restore(checkpoint: Checkpoint): BillingPipeline {
    const pipeline = new BillingPipeline();
    pipeline.ledger = checkpoint.ledger.clone();
    pipeline.bills = new Map(checkpoint.bills);
    pipeline.seq = checkpoint.seq;
    return pipeline;
  }

  /** 重放一段命令（幂等：重复重放不会产生重复分录）。 */
  replay(commands: Command[]): void {
    for (const command of commands) this.apply(command);
  }

  processedCount(): number {
    return this.seq;
  }

  ledgerHash(): string {
    return this.ledger.hash();
  }

  getLedger(): Ledger {
    return this.ledger;
  }

  getBill(billId: string): Bill | undefined {
    return this.bills.get(billId);
  }
}
