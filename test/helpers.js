'use strict';

const { signEvent } = require('../src/frame');

// Builds a signed event with an explicit full field set.
function ev(fields) {
  return signEvent({ reason: null, ref: null, ...fields });
}

// Shared 6-event scenario across two items:
//   ITEM-A: PACK(10) -> REWORK -> CORRECT(pack qty 10->12)
//   ITEM-B: PACK(5)  -> SCRAP  -> CORRECT(scrap qty 5->4, reason=audit)
function scenario() {
  const aPack = ev({ batch: 'B1', item: 'ITEM-A', seq: 0, lamport: 1, kind: 'PACK', qty: 10 });
  const aRework = ev({ batch: 'B1', item: 'ITEM-A', seq: 1, lamport: 2, kind: 'REWORK', qty: 10, reason: 'relabel' });
  const aCorrect = ev({ batch: 'B1', item: 'ITEM-A', seq: 2, lamport: 3, kind: 'CORRECT', ref: aPack.id, qty: 12, reason: 'miscount' });
  const bPack = ev({ batch: 'B1', item: 'ITEM-B', seq: 3, lamport: 4, kind: 'PACK', qty: 5 });
  const bScrap = ev({ batch: 'B1', item: 'ITEM-B', seq: 4, lamport: 5, kind: 'SCRAP', qty: 5, reason: 'damaged' });
  const bAudit = ev({ batch: 'B1', item: 'ITEM-B', seq: 5, lamport: 6, kind: 'CORRECT', ref: bScrap.id, qty: 4, reason: 'audit' });
  return { aPack, aRework, aCorrect, bPack, bScrap, bAudit };
}

function scenarioEvents() {
  const s = scenario();
  return [s.aPack, s.aRework, s.aCorrect, s.bPack, s.bScrap, s.bAudit];
}

module.exports = { ev, scenario, scenarioEvents };
