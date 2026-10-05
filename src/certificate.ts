import { validateInput } from "./solver.js";
import type { ClearingInput, SolveResult } from "./types.js";

export interface PaymentStep {
  step: number;
  billId: string;
  from: string;
  to: string;
  amount: number;
  payerBefore: number;
  payerAfter: number;
  payeeBefore: number;
  payeeAfter: number;
}

export interface Certificate {
  steps: PaymentStep[];
  refused: { billId: string; from: string; to: string; amount: number; penalty: number }[];
  initialBalances: Record<string, number>;
  finalBalances: Record<string, number>;
  totalPenalty: number;
}

/** 按给定执行序逐步模拟，生成余额证书；任何一步余额不足都会抛错。 */
export function buildCertificate(
  input: ClearingInput,
  paidOrder: number[],
  refused: number[],
): Certificate {
  validateInput(input);
  const balances = { ...input.balances };
  const initialBalances = { ...balances };
  const steps: PaymentStep[] = [];
  paidOrder.forEach((bi, i) => {
    const bill = input.bills[bi]!;
    const payerBefore = balances[bill.from]!;
    const payeeBefore = balances[bill.to]!;
    if (payerBefore < bill.amount) {
      throw new Error(
        `第 ${i + 1} 步：${bill.from} 余额 ${payerBefore} 不足以支付票据 ${bill.id}（金额 ${bill.amount}）`,
      );
    }
    const payerAfter = payerBefore - bill.amount;
    const payeeAfter = payeeBefore + bill.amount;
    balances[bill.from] = payerAfter;
    // 自付票据（from === to）借贷相抵，终值须基于付款后余额再入账。
    balances[bill.to] = bill.from === bill.to ? payerAfter + bill.amount : payeeAfter;
    steps.push({
      step: i + 1,
      billId: bill.id,
      from: bill.from,
      to: bill.to,
      amount: bill.amount,
      payerBefore,
      payerAfter,
      payeeBefore,
      payeeAfter,
    });
  });
  const refusedInfo = refused.map((bi) => {
    const b = input.bills[bi]!;
    return { billId: b.id, from: b.from, to: b.to, amount: b.amount, penalty: b.penalty };
  });
  const totalPenalty = refusedInfo.reduce((s, r) => s + r.penalty, 0);
  return { steps, refused: refusedInfo, initialBalances, finalBalances: balances, totalPenalty };
}

/** 校验证书与求解结果自洽：步骤合法、终态余额正确、罚费一致、支付/拒付划分完整。 */
export function verifyCertificate(
  input: ClearingInput,
  result: SolveResult,
  cert: Certificate,
): string[] {
  const errors: string[] = [];
  const n = input.bills.length;
  const paidSet = new Set(result.paidOrder);
  const refusedSet = new Set(result.refused);
  if (paidSet.size !== result.paidOrder.length) errors.push("执行序中存在重复票据");
  for (let i = 0; i < n; i++) {
    const inPaid = paidSet.has(i);
    const inRefused = refusedSet.has(i);
    if (inPaid === inRefused) errors.push(`票据 ${input.bills[i]!.id} 的支付/拒付划分不完整或冲突`);
  }
  if (cert.totalPenalty !== result.minPenalty) {
    errors.push(`证书罚费 ${cert.totalPenalty} ≠ 最小罚费 ${result.minPenalty}`);
  }
  // 终态余额 = 初始余额 + 已付子集净变动（与顺序无关），独立重算核对。
  const expect = { ...input.balances };
  for (const bi of result.paidOrder) {
    const b = input.bills[bi]!;
    expect[b.from]! -= b.amount;
    expect[b.to]! += b.amount;
  }
  for (const name of Object.keys(input.balances)) {
    if (cert.finalBalances[name] !== expect[name]) {
      errors.push(`账户 ${name} 终态余额 ${cert.finalBalances[name]} ≠ 期望值 ${expect[name]}`);
    }
  }
  for (const s of cert.steps) {
    if (s.payerBefore < s.amount) errors.push(`第 ${s.step} 步余额不足（证书不合法）`);
    if (s.payerAfter !== s.payerBefore - s.amount) errors.push(`第 ${s.step} 步付款方余额变动错误`);
    if (s.payeeAfter !== s.payeeBefore + s.amount) errors.push(`第 ${s.step} 步收款方余额变动错误`);
  }
  return errors;
}

/** 把证书渲染成可读的逐步余额表。 */
export function formatCertificate(input: ClearingInput, result: SolveResult, cert: Certificate): string {
  const names = Object.keys(input.balances);
  const w = Math.max(...names.map((s) => s.length), 5);
  const lines: string[] = [];
  lines.push("=== 清算证书 ===");
  lines.push(`初始余额: ${names.map((a) => `${a}=${cert.initialBalances[a]}`).join("  ")}`);
  lines.push("");
  lines.push("支付步骤（执行时付款方余额必须足够）：");
  const hdr = `${"步".padStart(3)}  ${"票据".padEnd(8)}  ${"付款".padEnd(w)}  ${"收款".padEnd(w)}  ${"金额".padStart(8)}  ${"付款方余额".padStart(14)}  ${"收款方余额".padStart(14)}`;
  lines.push(hdr);
  for (const s of cert.steps) {
    lines.push(
      `${String(s.step).padStart(3)}  ${s.billId.padEnd(8)}  ${s.from.padEnd(w)}  ${s.to.padEnd(w)}  ` +
        `${String(s.amount).padStart(8)}  ${`${s.payerBefore}→${s.payerAfter}`.padStart(14)}  ` +
        `${`${s.payeeBefore}→${s.payeeAfter}`.padStart(14)}`,
    );
  }
  if (cert.steps.length === 0) lines.push("（无支付步骤）");
  lines.push("");
  lines.push("拒付票据（计入罚费）：");
  if (cert.refused.length === 0) {
    lines.push("（无）");
  } else {
    for (const r of cert.refused) {
      lines.push(`  ${r.billId}: ${r.from}→${r.to} 金额 ${r.amount}，罚费 ${r.penalty}`);
    }
  }
  lines.push("");
  lines.push(`终态余额: ${names.map((a) => `${a}=${cert.finalBalances[a]}`).join("  ")}`);
  lines.push(`总罚费（最小）: ${cert.totalPenalty}`);
  lines.push(`已支付子集的合法执行顺序总数: ${result.legalOrderCount}`);
  lines.push(`全部 2^${input.bills.length} 个子集中可合法执行的子集数: ${result.feasibleSubsetCount}`);
  return lines.join("\n");
}
