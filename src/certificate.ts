// 预算证书：记录输入指纹、投放方案、分渠道预算核销、曝光达成与最优性证据，
// 并附 SHA-256 证书哈希；verifyCertificate 可独立复核（含重新求解比对）。
import type { PlanInput, Solution } from './model.js';
import { solve } from './solve.js';
import { hashValue } from './util.js';

export interface BudgetCertificate {
  certificateVersion: 1;
  kind: 'ad-placement-budget-certificate';
  inputHash: string; // 规范化输入的 SHA-256
  status: 'optimal' | 'infeasible';
  objective: { revenue: number; cost: number }; // 收益最大，并列时成本最低
  exposure: { lowerBound: number; achieved: number; satisfied: boolean };
  channels: { id: string; budget: number; spend: number; slack: number; withinBudget: boolean }[];
  allocations: { groupId: string; channel: string; quantity: number; cost: number; exposure: number; revenue: number }[];
  proof: {
    method: 'exact-integer-dp';
    stateSpace: string; // 状态定义说明
    statesExplored: number;
    frontierHash: string; // 最终 DP 前沿哈希
    bruteForce: { checked: boolean; combinations?: number; match?: boolean; reason?: string };
  };
  certificateHash: string; // 对上述全部内容（规范化后）的 SHA-256
}

export function buildCertificate(
  input: PlanInput,
  solution: Solution,
  bruteForce: { checked: boolean; combinations?: number; match?: boolean; reason?: string },
): BudgetCertificate {
  const body = {
    certificateVersion: 1 as const,
    kind: 'ad-placement-budget-certificate' as const,
    inputHash: hashValue(input),
    status: solution.status,
    objective: { revenue: solution.totalRevenue, cost: solution.totalCost },
    exposure: {
      lowerBound: input.exposureLowerBound,
      achieved: solution.totalExposure,
      satisfied: solution.totalExposure >= input.exposureLowerBound,
    },
    channels: input.channels.map((c) => {
      const spend = solution.channelSpend[c.id] ?? 0;
      return { id: c.id, budget: c.budget, spend, slack: c.budget - spend, withinBudget: spend <= c.budget };
    }),
    allocations: solution.allocations,
    proof: {
      method: 'exact-integer-dp' as const,
      stateSpace: '(各渠道已花费向量, 截断到下限的累计曝光) -> 最大收益，并列取最小成本',
      statesExplored: solution.statesExplored,
      frontierHash: solution.frontierHash,
      bruteForce,
    },
  };
  return { ...body, certificateHash: hashValue(body) };
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/** 独立复核证书：结构自检 + 约束核销 + 重新精确求解比对最优性。 */
export function verifyCertificate(input: PlanInput, cert: BudgetCertificate): VerifyResult {
  const errors: string[] = [];
  const { certificateHash, ...body } = cert;
  if (hashValue(body) !== certificateHash) errors.push('证书哈希不匹配，内容可能被篡改');
  if (hashValue(input) !== cert.inputHash) errors.push('inputHash 与当前输入不一致');

  if (cert.status === 'optimal') {
    const spend = new Map<string, number>(input.channels.map((c) => [c.id, 0]));
    let revenue = 0;
    let cost = 0;
    let exposure = 0;
    for (const alloc of cert.allocations) {
      const group = input.groups.find((g) => g.id === alloc.groupId);
      if (!group) {
        errors.push(`未知广告组 ${alloc.groupId}`);
        continue;
      }
      if (!Number.isInteger(alloc.quantity) || alloc.quantity < 0 || alloc.quantity > 10) {
        errors.push(`广告组 ${alloc.groupId} 投放量 ${alloc.quantity} 超出 0..10`);
      }
      const expectCost = alloc.quantity * group.unitCost;
      const expectExposure = alloc.quantity * group.unitExposure;
      const expectRevenue = group.revenue[alloc.quantity] ?? -1;
      if (alloc.cost !== expectCost) errors.push(`广告组 ${alloc.groupId} 成本不符`);
      if (alloc.exposure !== expectExposure) errors.push(`广告组 ${alloc.groupId} 曝光不符`);
      if (alloc.revenue !== expectRevenue) errors.push(`广告组 ${alloc.groupId} 收益不符`);
      spend.set(group.channel, (spend.get(group.channel) ?? 0) + expectCost);
      revenue += expectRevenue;
      cost += expectCost;
      exposure += expectExposure;
    }
    for (const ch of input.channels) {
      if ((spend.get(ch.id) ?? 0) > ch.budget) errors.push(`渠道 ${ch.id} 超出预算`);
    }
    if (exposure < input.exposureLowerBound) errors.push('总曝光未达到下限');
    if (revenue !== cert.objective.revenue) errors.push('证书收益合计与明细不符');
    if (cost !== cert.objective.cost) errors.push('证书成本合计与明细不符');
  }

  // 重新精确求解，核对最优性（收益最大、并列成本最低）。
  const resolved = solve(input);
  if (resolved.status !== cert.status) {
    errors.push(`重新求解状态为 ${resolved.status}，与证书 ${cert.status} 不一致`);
  } else if (cert.status === 'optimal') {
    if (resolved.totalRevenue !== cert.objective.revenue) errors.push('存在更高收益的可行方案，证书非最优');
    if (resolved.totalCost !== cert.objective.cost) errors.push('存在同收益但成本更低的方案，证书非最省');
    if (resolved.frontierHash !== cert.proof.frontierHash) errors.push('DP 前沿哈希不一致');
  }
  return { ok: errors.length === 0, errors };
}
