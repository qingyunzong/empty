'use strict';

const { natureOf, formulaResidual } = require('./model');

class BudgetExceeded extends Error {}

// One variable per (voucher, item, period) cell. Closed periods restrict
// non-restatement items to the fixed value 0 (domain propagation at build).
function buildVars(model) {
  const vars = [];
  for (const v of model.vouchers) {
    for (const it of model.items) {
      for (const p of model.periods) {
        const blocked = p.status === 'closed' && !it.restatement;
        vars.push({
          voucher: v.id,
          item: it.id,
          period: p.id,
          nature: natureOf(it.side),
          domain: blocked ? [0] : [0, ...model.domain],
        });
      }
    }
  }
  return vars;
}

function search(model, formulaIds, budget) {
  const vars = buildVars(model);
  const n = vars.length;
  const formulas = model.formulas.filter((f) => formulaIds.includes(f.id));
  const periods = model.periods;
  const itemById = new Map(model.items.map((i) => [i.id, i]));

  const vIndex = new Map(model.vouchers.map((v, i) => [v.id, i]));
  const vstate = model.vouchers.map((v) => ({
    required: v.required,
    sum: 0,
    unassigned: 0,
    nonzero: 0,
    vars: [],
  }));
  vars.forEach((vr, i) => {
    const st = vstate[vIndex.get(vr.voucher)];
    st.vars.push(i);
    st.unassigned += 1;
  });

  // affects[i]: which (formula, period) residuals a variable touches, with coef.
  const affects = vars.map((vr) => {
    const list = [];
    const side = itemById.get(vr.item).side;
    formulas.forEach((f, fi) => {
      let coef = 0;
      for (const t of f.lhs) {
        if (t.kind === 'item' && t.item === vr.item) coef += t.coef;
        else if (t.kind === 'side' && t.side === side) coef += t.coef;
      }
      for (const t of f.rhs) {
        if (t.kind === 'item' && t.item === vr.item) coef -= t.coef;
        else if (t.kind === 'side' && t.side === side) coef -= t.coef;
      }
      if (coef !== 0) list.push({ fi, pid: vr.period, coef });
    });
    return list;
  });

  const resid = formulas.map((f) => {
    const per = {};
    for (const p of periods) per[p.id] = formulaResidual(model, f, model.balances, p.id);
    return per;
  });

  const assign = new Array(n).fill(null);
  let nodes = 0;
  let solution = null;

  // Domain propagation: when a voucher has exactly one open leg, the
  // debit/credit pairing constraint forces that leg to a single value.
  function domainOf(i) {
    const vr = vars[i];
    const st = vstate[vIndex.get(vr.voucher)];
    if (st.unassigned === 1) {
      const forced = -st.sum / vr.nature;
      return vr.domain.filter((d) => d === forced);
    }
    return vr.domain;
  }

  function pruned() {
    // Voucher pairing: nature-weighted sum must be able to reach 0.
    for (const st of vstate) {
      let lo = st.sum;
      let hi = st.sum;
      for (const i of st.vars) {
        if (assign[i] !== null) continue;
        const vr = vars[i];
        let mn = Infinity;
        let mx = -Infinity;
        for (const d of vr.domain) {
          const w = d * vr.nature;
          if (w < mn) mn = w;
          if (w > mx) mx = w;
        }
        lo += mn;
        hi += mx;
      }
      if (lo > 0 || hi < 0) return true;
    }
    // Formula residuals: 0 must remain reachable per (formula, period).
    for (let fi = 0; fi < formulas.length; fi++) {
      for (const p of periods) {
        const r = resid[fi][p.id];
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < n; i++) {
          if (assign[i] === null) {
            for (const a of affects[i]) {
              if (a.fi !== fi || a.pid !== p.id) continue;
              let mn = Infinity;
              let mx = -Infinity;
              for (const d of vars[i].domain) {
                const w = d * a.coef;
                if (w < mn) mn = w;
                if (w > mx) mx = w;
              }
              lo += mn;
              hi += mx;
            }
          }
        }
        if (r + lo > 0 || r + hi < 0) return true;
      }
    }
    return false;
  }

  function dfs(idx) {
    if (++nodes > budget) throw new BudgetExceeded();
    if (idx === n) {
      for (const st of vstate) {
        if (st.required && st.nonzero < 2) return false;
      }
      solution = assign.slice();
      return true;
    }
    const vi = vIndex.get(vars[idx].voucher);
    const st = vstate[vi];
    for (const d of domainOf(idx)) {
      assign[idx] = d;
      st.sum += d * vars[idx].nature;
      st.unassigned -= 1;
      if (d !== 0) st.nonzero += 1;
      for (const a of affects[idx]) resid[a.fi][a.pid] += d * a.coef;
      if (!pruned() && dfs(idx + 1)) return true;
      for (const a of affects[idx]) resid[a.fi][a.pid] -= d * a.coef;
      if (d !== 0) st.nonzero -= 1;
      st.unassigned += 1;
      st.sum -= d * vars[idx].nature;
      assign[idx] = null;
    }
    return false;
  }

  try {
    if (dfs(0)) {
      const entries = [];
      solution.forEach((d, i) => {
        if (d !== 0) {
          entries.push({
            voucher: vars[i].voucher,
            item: vars[i].item,
            period: vars[i].period,
            amount: d,
          });
        }
      });
      return { status: 'SOLVED', entries, nodes };
    }
    return { status: 'UNSAT', entries: [], nodes };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { status: 'PENDING', entries: [], nodes };
    throw e;
  }
}

function solve(model) {
  const r = search(model, model.check, model.budget);
  if (r.status === 'SOLVED') return { ...r, conflicts: [] };
  if (r.status === 'PENDING') return { ...r, conflicts: null };
  // UNSAT is proven only by exhaustive search; explain it with a minimal
  // conflict core of formulas (deletion-based minimization).
  let core = [...model.check];
  for (const id of [...core]) {
    const trial = core.filter((x) => x !== id);
    const t = search(model, trial, Math.max(model.budget, 200000));
    if (t.status === 'UNSAT') core = trial;
  }
  return { ...r, conflicts: core };
}

module.exports = { buildVars, search, solve, BudgetExceeded };
