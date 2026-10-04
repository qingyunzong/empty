'use strict';

const { buildVars } = require('./solver');
const { formulaResidual } = require('./model');

// Independent brute-force enumerator used as a cross-check for the solver.
// Only intended for tiny instances (<=3 items, 2 periods).
function checkAssign(model, vars, values, formulaIds) {
  const vsum = {};
  const vnon = {};
  const bal = {};
  for (const [item, per] of Object.entries(model.balances)) bal[item] = { ...per };
  vars.forEach((vr, i) => {
    const d = values[i];
    vsum[vr.voucher] = (vsum[vr.voucher] || 0) + d * vr.nature;
    if (d !== 0) vnon[vr.voucher] = (vnon[vr.voucher] || 0) + 1;
    bal[vr.item][vr.period] += d;
  });
  for (const v of model.vouchers) {
    if ((vsum[v.id] || 0) !== 0) return false;
    if (v.required && (vnon[v.id] || 0) < 2) return false;
  }
  for (const f of model.formulas) {
    if (!formulaIds.includes(f.id)) continue;
    for (const p of model.periods) {
      if (formulaResidual(model, f, bal, p.id) !== 0) return false;
    }
  }
  return true;
}

function enumerateSat(model, formulaIds, limit = 2000000) {
  const vars = buildVars(model);
  let total = 1;
  for (const v of vars) total *= v.domain.length;
  if (total > limit) throw new Error(`enumeration space too large: ${total}`);
  const odo = new Array(vars.length).fill(0);
  const values = new Array(vars.length).fill(0);
  for (;;) {
    vars.forEach((vr, i) => {
      values[i] = vr.domain[odo[i]];
    });
    if (checkAssign(model, vars, values, formulaIds)) {
      const entries = [];
      vars.forEach((vr, i) => {
        if (values[i] !== 0) {
          entries.push({
            voucher: vr.voucher,
            item: vr.item,
            period: vr.period,
            amount: values[i],
          });
        }
      });
      return { sat: true, entries, space: total };
    }
    let k = vars.length - 1;
    while (k >= 0) {
      odo[k] += 1;
      if (odo[k] < vars[k].domain.length) break;
      odo[k] = 0;
      k -= 1;
    }
    if (k < 0) return { sat: false, entries: [], space: total };
  }
}

module.exports = { enumerateSat, checkAssign };
