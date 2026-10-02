'use strict';

function record(id, stratum, overrides) {
  return {
    id,
    stratum,
    version: 1,
    source: 'nodeA',
    seq: 1,
    amount: 100,
    currency: 'USD',
    ...(overrides || {}),
  };
}

function ledgerFor(strataSpec) {
  // strataSpec: { stratumId: count } -> deterministic records tx-<stratum>-<i>
  const ledger = [];
  for (const [stratum, count] of Object.entries(strataSpec)) {
    for (let i = 0; i < count; i += 1) {
      ledger.push(record('tx-' + stratum + '-' + i, stratum, { amount: 10 * (i + 1) }));
    }
  }
  return ledger;
}

function strataQuotas(spec) {
  return Object.entries(spec).map(([id, quota]) => ({ id, quota }));
}

function baseRequest(overrides) {
  return {
    seed: 'audit-seed-1',
    version: 1,
    ledger: ledgerFor({ retail: 5, wholesale: 4 }),
    strata: strataQuotas({ retail: 2, wholesale: 2 }),
    ...(overrides || {}),
  };
}

module.exports = { record, ledgerFor, strataQuotas, baseRequest };
