'use strict';
const { deepClone, holdsSum } = require('./state');

const ERR_INVARIANT = 'INVARIANT'; // exit 7
const ERR_UNKNOWN_OP = 'UNKNOWN_OP'; // exit 8

function fail(opIndex, message, code = ERR_INVARIANT) {
  return { ok: false, error: { opIndex, message, code } };
}

function checkLimit(acc, accountId, opIndex) {
  if (acc.limit < acc.used + holdsSum(acc)) {
    return fail(opIndex, `account ${accountId}: limit < used + holds (insufficient limit)`);
  }
  return null;
}

// Applies ops to a deep clone of state. Atomic: on the first failing op the
// original state is left untouched and { ok:false, error:{opIndex,...} } is
// returned.
function applyOps(state, ops) {
  const next = deepClone(state);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
      return fail(i, `op ${i}: malformed op`, ERR_UNKNOWN_OP);
    }
    const acc = next.accounts[op.account];
    switch (op.op) {
      case 'setLimit': {
        if (!acc) return fail(i, `op ${i}: unknown account ${op.account}`);
        if (typeof op.limit !== 'number' || !Number.isFinite(op.limit) || op.limit < 0) {
          return fail(i, `op ${i}: limit must be a non-negative number`);
        }
        acc.limit = op.limit;
        const err = checkLimit(acc, op.account, i);
        if (err) return err;
        break;
      }
      case 'addHold': {
        if (!acc) return fail(i, `op ${i}: unknown account ${op.account}`);
        if (typeof op.hid !== 'string' || op.hid.length === 0) {
          return fail(i, `op ${i}: hid must be a non-empty string`);
        }
        if (acc.holds.some((h) => h.hid === op.hid)) {
          return fail(i, `op ${i}: duplicate hid ${op.hid} in account ${op.account}`);
        }
        if (typeof op.amount !== 'number' || !Number.isFinite(op.amount) || op.amount <= 0) {
          return fail(i, `op ${i}: amount must be > 0`);
        }
        // insert sorted by hid so applied states stay in normalized form
        const hold = { hid: op.hid, amount: op.amount, tag: typeof op.tag === 'string' ? op.tag : '' };
        const at = acc.holds.findIndex((h) => h.hid > op.hid);
        if (at === -1) acc.holds.push(hold);
        else acc.holds.splice(at, 0, hold);
        const err = checkLimit(acc, op.account, i);
        if (err) return err;
        break;
      }
      case 'removeHold': {
        if (!acc) return fail(i, `op ${i}: unknown account ${op.account}`);
        const idx = acc.holds.findIndex((h) => h.hid === op.hid);
        if (idx === -1) return fail(i, `op ${i}: no hold ${op.hid} in account ${op.account}`);
        acc.holds.splice(idx, 1);
        break;
      }
      case 'changeTag': {
        if (!acc) return fail(i, `op ${i}: unknown account ${op.account}`);
        const hold = acc.holds.find((h) => h.hid === op.hid);
        if (!hold) return fail(i, `op ${i}: no hold ${op.hid} in account ${op.account}`);
        if (typeof op.tag !== 'string') return fail(i, `op ${i}: tag must be a string`);
        hold.tag = op.tag;
        break;
      }
      default:
        return fail(i, `op ${i}: unknown op ${op.op}`, ERR_UNKNOWN_OP);
    }
  }
  return { ok: true, state: next };
}

module.exports = { applyOps, ERR_INVARIANT, ERR_UNKNOWN_OP };
