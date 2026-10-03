'use strict';

function formulaHolds(model, formulaId, delta) {
  const f = model.formulas[model.formulaIndex.get(formulaId)];
  let sum = 0;
  for (const t of f.terms) {
    const idx = model.itemIndex.get(t.item);
    sum += t.coeff * (model.balances.get(t.item) + delta[idx]);
  }
  return sum === f.constant;
}

// 分层发布模拟：自低层向高层逐层发布。
// 低层失败时，所有更高层的预留（reserve）被冲回（reversal），状态 ROLLED_BACK。
function simulatePublish(model, delta) {
  const totalAbs = delta.reduce((s, v) => s + Math.abs(v), 0);
  const layers = [];
  let failed = false;
  let reversals = 0;

  for (const layer of model.layers) {
    if (failed) {
      layers.push({
        id: layer.id,
        status: 'ROLLED_BACK',
        reserve: layer.reserve,
        reversal: layer.reserve,
      });
      reversals += layer.reserve;
      continue;
    }
    const failedFormula = layer.formulaIds.find((fid) => !formulaHolds(model, fid, delta));
    const amountOk = layer.maxAmount === null || totalAbs <= layer.maxAmount;
    if (!failedFormula && amountOk) {
      layers.push({ id: layer.id, status: 'PUBLISHED', reserve: layer.reserve, reversal: 0 });
    } else {
      layers.push({
        id: layer.id,
        status: 'FAILED',
        reserve: layer.reserve,
        reversal: 0,
        reason: failedFormula ? `公式 ${failedFormula} 未配平` : `更正总额 ${totalAbs} 超过层上限 ${layer.maxAmount}`,
      });
      failed = true;
    }
  }

  return { layers, reversals, ok: !failed };
}

module.exports = { simulatePublish, formulaHolds };
