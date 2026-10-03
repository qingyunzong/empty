'use strict';

const { buildConstraints, domainsForPeriod, periodsToTry } = require('./solver');

// 独立暴力枚举（供测试交叉对照；仅适用于小域）。
function bruteForce(model) {
  for (const pid of periodsToTry(model)) {
    const domains = domainsForPeriod(model, model.periods[model.periodIndex.get(pid)]);
    const values = domains.map(([lo, hi]) => {
      const vs = [];
      for (let v = lo; v <= hi; v++) vs.push(v);
      return vs;
    });
    const n = values.length;
    const idx = new Array(n).fill(0);
    while (true) {
      const delta = idx.map((i, k) => values[k][i]);
      if (delta.some((v) => v !== 0)) {
        const ok = checkAll(model, pid, delta);
        if (ok) return { sat: true, period: pid, delta };
      }
      let i = 0;
      while (i < n && idx[i] === values[i].length - 1) {
        idx[i] = 0;
        i += 1;
      }
      if (i === n) break;
      idx[i] += 1;
    }
  }
  return { sat: false };
}

function checkAll(model, periodId, delta) {
  const period = model.periods[model.periodIndex.get(periodId)];
  for (const c of buildConstraints(model, period)) {
    let sum = 0;
    for (let i = 0; i < delta.length; i++) sum += c.coeffs[i] * delta[i];
    if (sum !== c.target) return false;
  }
  return true;
}

module.exports = { bruteForce };
