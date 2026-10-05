import { Plan, renderPlan } from './plan';
import { Certificate, NORMALIZING_RULES, RewriteOutcome } from './rules';

export interface OptimizeResult {
  plan: Plan;
  certificates: Certificate[];
}

function applyOnce(p: Plan, certs: Certificate[]): Plan {
  let current = p;
  for (const rule of NORMALIZING_RULES) {
    const out: RewriteOutcome | null = rule(current);
    if (out && out.cert.applied) {
      certs.push(out.cert);
      current = out.plan;
    }
  }
  return current;
}

function optimizeNode(p: Plan, certs: Certificate[]): Plan {
  switch (p.kind) {
    case 'scan':
      return applyOnce(p, certs);
    case 'filter':
      return applyOnce({ ...p, child: optimizeNode(p.child, certs) }, certs);
    case 'project':
      return applyOnce({ ...p, child: optimizeNode(p.child, certs) }, certs);
    case 'innerJoin':
    case 'leftJoin':
      return applyOnce(
        { ...p, left: optimizeNode(p.left, certs), right: optimizeNode(p.right, certs) },
        certs,
      );
  }
}

/** 自底向上重写至不动点（有界迭代保证终止）。只执行前置条件全部成立的规则。 */
export function optimize(plan: Plan, maxRounds = 20): OptimizeResult {
  const certificates: Certificate[] = [];
  let current = plan;
  for (let round = 0; round < maxRounds; round++) {
    const next = optimizeNode(current, certificates);
    if (renderPlan(next) === renderPlan(current)) return { plan: next, certificates };
    current = next;
  }
  return { plan: current, certificates };
}
