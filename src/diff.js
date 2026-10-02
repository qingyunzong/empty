'use strict';
const { stateHash, validateState } = require('./state');
const { applyOps } = require('./apply');

// Computes forward ops (base -> target) and inverse ops (target -> base).
// Op order per account: removeHold, setLimit, addHold, changeTag, which keeps
// every intermediate state valid whenever base and target are both valid.
function diffStates(base, target) {
  const ops = [];
  const inverse = [];
  const ids = Object.keys(target.accounts).sort();
  const baseIds = Object.keys(base.accounts).sort();
  if (ids.join('') !== baseIds.join('')) {
    throw new Error('account sets differ between base and target; only setLimit/addHold/removeHold/changeTag are representable');
  }
  for (const id of ids) {
    const b = base.accounts[id];
    const t = target.accounts[id];
    const bHolds = new Map(b.holds.map((h) => [h.hid, h]));
    const tHolds = new Map(t.holds.map((h) => [h.hid, h]));

    for (const [hid, bh] of bHolds) {
      const th = tHolds.get(hid);
      if (!th || th.amount !== bh.amount) {
        ops.push({ op: 'removeHold', account: id, hid });
        inverse.push({ op: 'addHold', account: id, hid, amount: bh.amount, tag: bh.tag });
      }
    }
    if (b.limit !== t.limit) {
      ops.push({ op: 'setLimit', account: id, limit: t.limit });
      inverse.push({ op: 'setLimit', account: id, limit: b.limit });
    }
    for (const [hid, th] of tHolds) {
      const bh = bHolds.get(hid);
      if (!bh || bh.amount !== th.amount) {
        ops.push({ op: 'addHold', account: id, hid, amount: th.amount, tag: th.tag });
        inverse.push({ op: 'removeHold', account: id, hid });
      }
    }
    for (const [hid, th] of tHolds) {
      const bh = bHolds.get(hid);
      if (bh && bh.amount === th.amount && bh.tag !== th.tag) {
        ops.push({ op: 'changeTag', account: id, hid, tag: th.tag });
        inverse.push({ op: 'changeTag', account: id, hid, tag: bh.tag });
      }
    }
  }
  inverse.reverse();
  return { ops, inverse };
}

// Builds a self-verifying patch. Throws when the base->target difference is
// not representable with the four supported op types (e.g. `used` changed).
function buildPatch(base, target) {
  for (const [name, st] of [['base', base], ['target', target]]) {
    const err = validateState(st);
    if (err) throw new Error(`invalid ${name} state: ${err}`);
  }
  const { ops, inverse } = diffStates(base, target);
  const fromHash = stateHash(base);
  const toHash = stateHash(target);
  const applied = applyOps(base, ops);
  if (!applied.ok) {
    throw new Error(`diff not representable: op ${applied.error.opIndex}: ${applied.error.message}`);
  }
  if (stateHash(applied.state) !== toHash) {
    throw new Error('diff not representable: fields other than limit/holds differ (e.g. used)');
  }
  const body = { fromHash, toHash, ops, inverse };
  const { canonical, sha256Hex } = require('./state');
  return { ...body, sha256: sha256Hex(canonical(body)) };
}

function verifyPatch(patch) {
  if (patch === null || typeof patch !== 'object') return 'patch must be an object';
  for (const key of ['fromHash', 'toHash', 'sha256']) {
    if (typeof patch[key] !== 'string') return `patch.${key} must be a string`;
  }
  if (!Array.isArray(patch.ops) || !Array.isArray(patch.inverse)) {
    return 'patch.ops and patch.inverse must be arrays';
  }
  const { canonical, sha256Hex } = require('./state');
  const body = { fromHash: patch.fromHash, toHash: patch.toHash, ops: patch.ops, inverse: patch.inverse };
  if (sha256Hex(canonical(body)) !== patch.sha256) return 'patch sha256 mismatch (tampered or corrupt)';
  return null;
}

module.exports = { diffStates, buildPatch, verifyPatch };
