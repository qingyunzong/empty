// UNSAT 最小不可行证书：给出单点松弛即可恢复可行的证据，并可独立复验。
//
// 证书断言（对生成时的当前状态）：
//   1. 原问题完备搜索后不可行（exhaustive: true，绝不由 UNKNOWN 冒充）；
//   2. 删去某一个到期约束（skip 某道工序的 calDue 检查）即可可行 —— 附目击计划；
//   3. 或增加一单位预算即可可行 —— 附目击计划。
// verifyCertificate 重新求解原问题与每个松弛项，并重放目击计划逐项核对。

import { validateProblem, domainError } from './domain.js';
import { Planner } from './planner.js';

function reach(problem, path) {
  const planner = new Planner(problem);
  for (const action of path) planner.apply(action);
  return planner;
}

function withRelax(problem, { skipCalDueOpIds = [], extraBudget = 0 }) {
  return {
    ...problem,
    relax: {
      skipCalDueOpIds: [...problem.relax.skipCalDueOpIds, ...skipCalDueOpIds],
      extraBudget: problem.relax.extraBudget + extraBudget,
    },
  };
}

function witnessOf(result) {
  return result.status === 'SAT'
    ? { downtime: result.downtime, actions: result.plans[0].actions }
    : null;
}

export function buildCertificate(problem, path = []) {
  const normalized = validateProblem(problem);
  const base = reach(normalized, path);
  const baseResult = base.solve({ certificate: false });
  if (baseResult.status !== 'UNSAT') {
    throw domainError('cannot build an UNSAT certificate for a feasible state');
  }
  const relaxations = [];
  for (const op of base.pendingOps) {
    const relaxed = withRelax(normalized, { skipCalDueOpIds: [op.id] });
    const res = reach(relaxed, path).solve({ certificate: false });
    relaxations.push({
      kind: 'removeCalDueConstraint',
      op: op.id,
      feasible: res.status === 'SAT',
      witness: witnessOf(res),
    });
  }
  const budgetRelaxed = withRelax(normalized, { extraBudget: 1 });
  const budgetResult = reach(budgetRelaxed, path).solve({ certificate: false });
  relaxations.push({
    kind: 'addBudget',
    amount: 1,
    feasible: budgetResult.status === 'SAT',
    witness: witnessOf(budgetResult),
  });
  return {
    type: 'UNSAT_CERTIFICATE',
    status: 'UNSAT',
    exhaustive: true,
    path: path.map((action) => ({ ...action })),
    state: { ...base.state, pendingOps: base.pendingOps.map((op) => op.id) },
    relaxations,
  };
}

function checkWitness(problem, path, witness) {
  try {
    const planner = reach(problem, path);
    const before = planner.state.downtime;
    for (const action of witness.actions) planner.apply(action);
    return (
      planner.pendingOps.length === 0 &&
      Math.abs(planner.state.downtime - before - witness.downtime) < 1e-9
    );
  } catch {
    return false;
  }
}

export function verifyCertificate(problem, certificate) {
  const checks = [];
  const ok = (name, cond) => {
    checks.push({ name, ok: Boolean(cond) });
    return checks[checks.length - 1].ok;
  };
  let normalized;
  try {
    normalized = validateProblem(problem);
  } catch {
    ok('problem-valid', false);
    return { valid: false, checks };
  }
  ok('declares-unsat', certificate?.type === 'UNSAT_CERTIFICATE' && certificate?.status === 'UNSAT');
  ok('exhaustive-not-unknown', certificate?.exhaustive === true);
  const path = certificate?.path ?? [];
  let baseResult = null;
  try {
    baseResult = reach(normalized, path).solve({ certificate: false });
  } catch {
    baseResult = null;
  }
  ok('original-unsat', baseResult !== null && baseResult.status === 'UNSAT');
  for (const rel of certificate?.relaxations ?? []) {
    const label = rel.kind === 'removeCalDueConstraint' ? `${rel.kind}:${rel.op}` : rel.kind;
    let relaxed = null;
    if (rel.kind === 'removeCalDueConstraint') {
      relaxed = withRelax(normalized, { skipCalDueOpIds: [rel.op] });
    } else if (rel.kind === 'addBudget') {
      relaxed = withRelax(normalized, { extraBudget: rel.amount });
    }
    if (!relaxed) {
      ok(`relaxation:${label}:known-kind`, false);
      continue;
    }
    let res = null;
    try {
      res = reach(relaxed, path).solve({ certificate: false });
    } catch {
      res = null;
    }
    ok(
      `relaxation:${label}:feasible=${rel.feasible}`,
      res !== null && (res.status === 'SAT') === rel.feasible,
    );
    if (rel.feasible && rel.witness) {
      ok(`witness:${label}`, checkWitness(relaxed, path, rel.witness));
    }
  }
  return { valid: checks.every((check) => check.ok), checks };
}
