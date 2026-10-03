'use strict';

// 求解器：域传播 + 回溯 + 回溯预算 + 冲突解释。
// 变量：每个报表项目的更正金额 delta_i（整数，落在其 domain 内）。
// 约束：
//   1) 同凭证借贷必须配对：sum(delta_i) = 0，且至少一条非零分录；
//   2) 每个被强制的勾稽公式：sum(coeff * (balance + delta)) = constant；
//   3) 关闭期间只允许重述项目（其余项目域收缩为 {0}）。

function buildConstraints(model, period) {
  const n = model.items.length;
  const constraints = [];

  // 凭证配对约束
  constraints.push({
    kind: 'voucher',
    coeffs: new Array(n).fill(1),
    target: 0,
  });

  // 勾稽公式约束
  for (const fid of model.enforcedFormulaIds) {
    const f = model.formulas[model.formulaIndex.get(fid)];
    const coeffs = new Array(n).fill(0);
    let base = 0;
    for (const t of f.terms) {
      const idx = model.itemIndex.get(t.item);
      coeffs[idx] += t.coeff;
      base += t.coeff * model.balances.get(t.item);
    }
    constraints.push({
      kind: 'formula',
      id: f.id,
      coeffs,
      target: f.constant - base,
    });
  }
  return constraints;
}

function domainsForPeriod(model, period) {
  return model.items.map((it) => {
    if (period.status === 'closed' && !it.restatement) return [0, 0];
    return [it.lo, it.hi];
  });
}

// 区间（界）一致性传播；原地收缩 domains，返回是否一致。
function propagate(domains, constraints) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of constraints) {
      const coeffs = c.coeffs;
      let totalMin = 0;
      let totalMax = 0;
      for (let i = 0; i < coeffs.length; i++) {
        const k = coeffs[i];
        if (k === 0) continue;
        const [lo, hi] = domains[i];
        if (k > 0) {
          totalMin += k * lo;
          totalMax += k * hi;
        } else {
          totalMin += k * hi;
          totalMax += k * lo;
        }
      }
      if (totalMin > c.target || totalMax < c.target) return false;
      for (let i = 0; i < coeffs.length; i++) {
        const k = coeffs[i];
        if (k === 0) continue;
        const [lo, hi] = domains[i];
        const contribMin = k > 0 ? k * lo : k * hi;
        const contribMax = k > 0 ? k * hi : k * lo;
        const othersMin = totalMin - contribMin;
        const othersMax = totalMax - contribMax;
        // k * d_i ∈ [target - othersMax, target - othersMin]
        let lo2;
        let hi2;
        if (k > 0) {
          lo2 = Math.ceil((c.target - othersMax) / k);
          hi2 = Math.floor((c.target - othersMin) / k);
        } else {
          lo2 = Math.ceil((c.target - othersMin) / k);
          hi2 = Math.floor((c.target - othersMax) / k);
        }
        const nlo = Math.max(lo, lo2);
        const nhi = Math.min(hi, hi2);
        if (nlo > nhi) return false;
        if (nlo !== lo || nhi !== hi) {
          domains[i] = [nlo, nhi];
          changed = true;
          break; // 重新计算总量，保证正确性
        }
      }
    }
  }
  return true;
}

function search(domains, constraints, state) {
  state.nodes += 1;
  if (state.nodes > state.budget) return { pending: true };
  if (!propagate(domains, constraints)) return {};

  let branchIdx = -1;
  let branchSize = Infinity;
  for (let i = 0; i < domains.length; i++) {
    const size = domains[i][1] - domains[i][0] + 1;
    if (size > 1 && size < branchSize) {
      branchSize = size;
      branchIdx = i;
    }
  }

  if (branchIdx === -1) {
    const delta = domains.map((d) => d[0]);
    if (delta.every((v) => v === 0)) return {}; // 全零不是更正分录
    return { solution: delta };
  }

  const [lo, hi] = domains[branchIdx];
  const values = [];
  for (let v = lo; v <= hi; v++) values.push(v);
  values.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b); // 优先小额更正

  for (const v of values) {
    const next = domains.slice();
    next[branchIdx] = [v, v];
    const r = search(next, constraints, state);
    if (r.pending) return r;
    if (r.solution) return r;
    state.backtracks += 1;
  }
  return {};
}

function periodsToTry(model) {
  if (model.forcedPeriod) return [model.forcedPeriod];
  return model.periods.map((p) => p.id);
}

function solveModel(model, budget) {
  const state = { nodes: 0, backtracks: 0, budget };
  for (const pid of periodsToTry(model)) {
    const period = model.periods[model.periodIndex.get(pid)];
    const constraints = buildConstraints(model, period);
    const domains = domainsForPeriod(model, period);
    const r = search(domains, constraints, state);
    if (r.solution) {
      return {
        status: 'OK',
        period: pid,
        delta: r.solution,
        nodes: state.nodes,
        backtracks: state.backtracks,
      };
    }
    if (r.pending) {
      return { status: 'PENDING', nodes: state.nodes, backtracks: state.backtracks };
    }
  }
  return { status: 'UNSAT', nodes: state.nodes, backtracks: state.backtracks };
}

// 删除式最小化：得到不可再删的不可满足公式子集（最小公式冲突）。
function minimalConflictCore(model) {
  let core = model.enforcedFormulaIds.slice();
  for (const fid of core.slice()) {
    const trial = core.filter((x) => x !== fid);
    const sub = Object.assign({}, model, { enforcedFormulaIds: trial });
    if (solveModel(sub, Infinity).status === 'UNSAT') core = trial;
  }
  return core;
}

// 根节点层面解释冲突：每个核心公式可达范围 vs 目标常数。
function explainConflict(model, coreIds) {
  const lines = [];
  const union = model.items.map((it, i) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const pid of periodsToTry(model)) {
      const period = model.periods[model.periodIndex.get(pid)];
      const d = domainsForPeriod(model, period)[i];
      lo = Math.min(lo, d[0]);
      hi = Math.max(hi, d[1]);
    }
    return [lo, hi];
  });

  for (const fid of coreIds) {
    const f = model.formulas[model.formulaIndex.get(fid)];
    let min = 0;
    let max = 0;
    for (const t of f.terms) {
      const idx = model.itemIndex.get(t.item);
      const base = model.balances.get(t.item);
      const [lo, hi] = union[idx];
      if (t.coeff > 0) {
        min += t.coeff * (base + lo);
        max += t.coeff * (base + hi);
      } else {
        min += t.coeff * (base + hi);
        max += t.coeff * (base + lo);
      }
    }
    const reachable = f.constant >= min && f.constant <= max;
    lines.push(
      `公式 ${fid}: 左右差额可达区间 [${min}, ${max}]，目标 ${f.constant}` +
        (reachable ? '（区间内，冲突来自公式间耦合或凭证配对约束）' : '（目标不可达）'),
    );
  }
  lines.push('同凭证借贷必须配对：所有分录金额之和须为 0 且至少一条非零。');
  return lines.join('\n');
}

module.exports = {
  solveModel,
  minimalConflictCore,
  explainConflict,
  buildConstraints,
  domainsForPeriod,
  propagate,
  periodsToTry,
};
