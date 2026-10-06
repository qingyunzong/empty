/**
 * 证书：对给定解逐条输出可独立核验的证据——
 * 两类资源用量各一条，每条用户间约束各一条。
 */
import {
  Assignment, Constraint, Problem, UNSERVED, evaluate, normalize,
} from './model';

export interface BudgetCertificate {
  kind: 'budget';
  resource: 'r1' | 'r2';
  used: number;
  limit: number;
  ok: boolean;
  detail: string;
}

export interface ConstraintCertificate {
  kind: 'constraint';
  index: number;
  constraint: Constraint;
  tierI: number | null;
  tierJ: number | null;
  ok: boolean;
  detail: string;
}

export type Certificate = BudgetCertificate | ConstraintCertificate;

export interface Verification {
  ok: boolean;
  benefit: number;
  used1: number;
  used2: number;
  certificates: Certificate[];
}

function tierLabel(t: number): string {
  return t === UNSERVED ? 'unserved' : `tier ${t}`;
}

/** 生成并校验全部证书；ok 为所有证书与结构检查的逻辑与。 */
export function verifySolution(problem: Problem, assignment: Assignment): Verification {
  const np = normalize(problem);
  if (!Array.isArray(assignment) || assignment.length !== np.users) {
    throw new Error(`assignment length must be ${np.users}`);
  }
  for (const t of assignment) {
    if (t !== UNSERVED && (!Number.isInteger(t) || t < 0 || t >= np.tiers.length)) {
      throw new Error(`assignment contains invalid tier ${t}`);
    }
  }
  const ev = evaluate(np, assignment);
  const certificates: Certificate[] = [];

  certificates.push({
    kind: 'budget', resource: 'r1', used: ev.used1, limit: np.budget1,
    ok: ev.used1 <= np.budget1,
    detail: `resource r1: used ${ev.used1} <= budget ${np.budget1}`,
  });
  certificates.push({
    kind: 'budget', resource: 'r2', used: ev.used2, limit: np.budget2,
    ok: ev.used2 <= np.budget2,
    detail: `resource r2: used ${ev.used2} <= budget ${np.budget2}`,
  });

  np.constraints.forEach((c, index) => {
    const ti = assignment[c.i];
    const tj = assignment[c.j];
    let ok: boolean;
    let detail: string;
    if (ti === UNSERVED || tj === UNSERVED) {
      ok = true;
      detail = `constraint#${index} ${c.kind}(${c.i},${c.j}): ` +
        `user ${ti === UNSERVED ? c.i : c.j} unserved -> vacuously satisfied`;
    } else {
      ok = c.kind === 'same' ? ti === tj : ti !== tj;
      const rel = c.kind === 'same' ? '==' : '!=';
      detail = `constraint#${index} ${c.kind}(${c.i},${c.j}): ` +
        `${tierLabel(ti)} ${rel} ${tierLabel(tj)} -> ${ok ? 'satisfied' : 'VIOLATED'}`;
    }
    certificates.push({
      kind: 'constraint', index, constraint: c,
      tierI: ti === UNSERVED ? null : ti,
      tierJ: tj === UNSERVED ? null : tj,
      ok, detail,
    });
  });

  return {
    ok: certificates.every((c) => c.ok),
    benefit: ev.benefit,
    used1: ev.used1,
    used2: ev.used2,
    certificates,
  };
}
