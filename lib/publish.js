'use strict';

// Layered publish simulation: layers publish bottom-up; the first failing
// layer stops the chain, and every layer above it has its reserved amounts
// charged back (rolled back). Reversal amount = sum of |entry amounts|.
function publish(model, entries) {
  let failedSeen = false;
  const layers = model.layers.map((layer) => {
    const vids = new Set(
      model.vouchers.filter((v) => v.layer === layer.id).map((v) => v.id)
    );
    const total = entries
      .filter((e) => vids.has(e.voucher))
      .reduce((s, e) => s + Math.abs(e.amount), 0);
    if (failedSeen) return { id: layer.id, status: 'ROLLED_BACK', reversal: total };
    if (layer.publish === 'fail') {
      failedSeen = true;
      return { id: layer.id, status: 'FAILED', reversal: total };
    }
    return { id: layer.id, status: 'PUBLISHED', reversal: 0 };
  });
  return { layers, reversalTotal: layers.reduce((s, l) => s + l.reversal, 0) };
}

module.exports = { publish };
