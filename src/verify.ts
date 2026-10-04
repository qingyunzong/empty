/**
 * 约束证书：求解结果 + 逐条约束检查 + 上下界，可独立校验。
 * 校验器不信任求解器，从 spec 与 layout 重新计算一切。
 */

import { createHash } from 'node:crypto';
import type { LayoutSpec, Placement } from './model.js';
import { validateSpec } from './model.js';
import { allSatisfied, checkLayout, totalMovement, type ConstraintCheck } from './constraints.js';
import type { SolveResult, SolveStatus } from './solver.js';

export interface Certificate {
  version: 1;
  /** spec 的 SHA-256（规范化 JSON），防篡改。 */
  specHash: string;
  spec: LayoutSpec;
  status: SolveStatus;
  /** 目标值上界（= 所附布局的总移动距离）；无可行解为 null。 */
  objective: number | null;
  /** 最优值的下界（预算内未闭合时 < upperBound）。 */
  lowerBound: number | null;
  upperBound: number | null;
  nodesExplored: number;
  layout: Placement[] | null;
  /** 逐条约束检查（对 layout 而言）。 */
  checks: ConstraintCheck[];
}

export function specHash(spec: LayoutSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

export function buildCertificate(spec: LayoutSpec, result: SolveResult): Certificate {
  return {
    version: 1,
    specHash: specHash(spec),
    spec,
    status: result.status,
    objective: result.objective,
    lowerBound: result.lowerBound,
    upperBound: result.upperBound,
    nodesExplored: result.nodesExplored,
    layout: result.layout,
    checks: result.layout ? checkLayout(spec, result.layout) : [],
  };
}

export interface Verification {
  ok: boolean;
  problems: string[];
}

export function verifyCertificate(cert: Certificate): Verification {
  const problems: string[] = [];
  if (cert.version !== 1) problems.push(`未知证书版本 ${cert.version}`);

  const specProblems = validateSpec(cert.spec);
  problems.push(...specProblems.map((p) => `spec 非法: ${p}`));

  if (specHash(cert.spec) !== cert.specHash) problems.push('specHash 与 spec 不匹配（被篡改？）');

  if (cert.layout) {
    const recomputed = checkLayout(cert.spec, cert.layout);
    if (JSON.stringify(recomputed) !== JSON.stringify(cert.checks)) {
      problems.push('checks 与 layout 重算结果不一致');
    }
    if (!allSatisfied(recomputed)) {
      problems.push(`存在未满足约束: ${recomputed.filter((c) => !c.satisfied).map((c) => c.id).join(', ')}`);
    }
    const cost = totalMovement(cert.spec, cert.layout);
    if (cert.objective !== cost) problems.push(`objective=${cert.objective} 与重算总移动距离 ${cost} 不一致`);
    if (cert.upperBound !== cost) problems.push(`upperBound=${cert.upperBound} 与重算总移动距离 ${cost} 不一致`);
  } else if (cert.objective !== null || cert.upperBound !== null) {
    problems.push('无布局却声明了目标值/上界');
  }

  const lb = cert.lowerBound;
  const ub = cert.upperBound;
  if (lb !== null && ub !== null && lb > ub) problems.push(`下界 ${lb} > 上界 ${ub}`);
  if (cert.status === 'optimal') {
    if (lb === null || ub === null || lb !== ub) problems.push(`optimal 状态要求下界==上界，得到 ${lb} vs ${ub}`);
    if (cert.objective !== ub) problems.push('optimal 状态要求 objective==upperBound');
  }
  if (cert.status === 'infeasible' && cert.layout !== null) problems.push('infeasible 状态不应附带布局');
  if (cert.status === 'bounded' && lb !== null && ub !== null && lb === ub) {
    problems.push('bounded 状态下界已闭合，应为 optimal');
  }
  if (!Number.isInteger(cert.nodesExplored) || cert.nodesExplored < 0) problems.push('nodesExplored 非法');

  return { ok: problems.length === 0, problems };
}
