'use strict';

function initialState() {
  return { txs: [], revoked: [] };
}

function padAmount(amount) {
  return String(amount).padStart(3, '0');
}

function canonicalAction(action) {
  switch (action.op) {
    case 'submit':
      return `submit(${action.subject},${padAmount(action.amount)})`;
    case 'approve':
      return `approve(${action.subject},${action.tx})`;
    case 'revoke':
      return `revoke(${action.rule})`;
    default:
      throw new Error(`unknown op: ${action.op}`);
  }
}

function authorized(spec, revoked, subject, op, amount) {
  const roles = spec.roleClosure[subject] || [];
  let allowed = false;
  for (const rule of spec.rules) {
    if (revoked.includes(rule.id)) continue;
    if (rule.action !== op) continue;
    if (!roles.includes(rule.role)) continue;
    if (rule.minAmount !== null && amount < rule.minAmount) continue;
    if (rule.maxAmount !== null && amount > rule.maxAmount) continue;
    if (rule.effect === 'deny') return false;
    allowed = true;
  }
  return allowed;
}

function listActions(spec, state) {
  const actions = [];
  for (const subject of spec.subjects) {
    for (const amount of spec.amounts) {
      actions.push({ op: 'submit', subject, amount });
    }
  }
  for (const subject of spec.subjects) {
    for (let tx = 0; tx < state.txs.length; tx++) {
      actions.push({ op: 'approve', subject, tx });
    }
  }
  for (const rule of spec.rules) {
    if (rule.revocable && !state.revoked.includes(rule.id)) {
      actions.push({ op: 'revoke', rule: rule.id });
    }
  }
  actions.sort((a, b) => {
    const ca = canonicalAction(a);
    const cb = canonicalAction(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  return actions;
}

function applyAction(spec, state, action) {
  switch (action.op) {
    case 'submit': {
      if (!authorized(spec, state.revoked, action.subject, 'submit', action.amount)) return null;
      const tx = { submitter: action.subject, amount: action.amount, approver: null };
      return { txs: state.txs.concat([tx]), revoked: state.revoked };
    }
    case 'approve': {
      const tx = state.txs[action.tx];
      if (tx === undefined || tx.approver !== null) return null;
      if (!authorized(spec, state.revoked, action.subject, 'approve', tx.amount)) return null;
      const txs = state.txs.slice();
      txs[action.tx] = { submitter: tx.submitter, amount: tx.amount, approver: action.subject };
      return { txs, revoked: state.revoked };
    }
    case 'revoke': {
      const rule = spec.rulesById[action.rule];
      if (rule === undefined || !rule.revocable) return null;
      if (state.revoked.includes(action.rule)) return null;
      return { txs: state.txs, revoked: state.revoked.concat([action.rule]) };
    }
    default:
      return null;
  }
}

function violates(spec, state) {
  const { threshold } = spec.invariant;
  for (let i = 0; i < state.txs.length; i++) {
    const tx = state.txs[i];
    if (tx.approver !== null && tx.approver === tx.submitter && tx.amount > threshold) {
      return {
        invariant: spec.invariant.type,
        tx: i,
        submitter: tx.submitter,
        approver: tx.approver,
        amount: tx.amount,
        threshold,
      };
    }
  }
  return null;
}

function stateKey(state) {
  const txs = state.txs
    .map((tx) => `${tx.submitter}#${tx.amount}#${tx.approver === null ? '-' : tx.approver}`)
    .sort()
    .join(',');
  const revoked = state.revoked.slice().sort().join(',');
  return `${txs}|${revoked}`;
}

function runSequence(spec, actions) {
  let state = initialState();
  const trace = [];
  for (let i = 0; i < actions.length; i++) {
    const next = applyAction(spec, state, actions[i]);
    if (next === null) {
      return { valid: false, failedAt: i, state, trace };
    }
    state = next;
    trace.push({ action: actions[i], canonical: canonicalAction(actions[i]), violation: violates(spec, state) });
  }
  return { valid: true, state, trace };
}

module.exports = {
  initialState,
  canonicalAction,
  authorized,
  listActions,
  applyAction,
  violates,
  stateKey,
  runSequence,
};
