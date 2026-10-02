'use strict';
const { cloneState } = require('./state');

function applyStep(state, step, label) {
  const next = cloneState(state);
  const reject = (reason) => {
    next.rejected.push({ step: label, type: step.type, id: step.id || null, reason });
    return { state: next, rejected: reason };
  };
  switch (step.type) {
    case 'reserve': {
      if (next.frozenAccounts.includes(step.from)) return reject('ACCOUNT_FROZEN');
      next.frozen[step.from] += step.amount;
      next.holds[step.id] = {
        from: step.from,
        to: step.to,
        amount: step.amount,
        status: 'pending',
      };
      return { state: next, rejected: null };
    }
    case 'commit': {
      const hold = next.holds[step.id];
      if (!hold || hold.status !== 'pending') return reject('NOT_PENDING');
      next.balances[hold.from] -= hold.amount;
      next.balances[hold.to] += hold.amount;
      next.frozen[hold.from] -= hold.amount;
      hold.status = 'committed';
      return { state: next, rejected: null };
    }
    case 'cancel': {
      const hold = next.holds[step.id];
      if (!hold || hold.status !== 'pending') return reject('NOT_PENDING');
      next.frozen[hold.from] -= hold.amount;
      hold.status = 'cancelled';
      return { state: next, rejected: null };
    }
    case 'freeze': {
      if (next.frozenAccounts.includes(step.account)) return reject('ALREADY_FROZEN');
      next.frozenAccounts.push(step.account);
      next.frozenAccounts.sort();
      return { state: next, rejected: null };
    }
    default:
      return reject('UNKNOWN_STEP_TYPE');
  }
}

module.exports = { applyStep };
