'use strict';

const crypto = require('node:crypto');

const EXIT_OK = 0;
const EXIT_ILLEGAL_TRANSITION = 15;
const EXIT_AMOUNT_OUT_OF_RANGE = 16;
const EXIT_UNKNOWN_COMMAND = 17;

const GENESIS_HASH = '0'.repeat(64);

class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

function initialState() {
  return {
    version: 1,
    accounts: {},
    transactions: {},
    migrations: [],
    idempotency: {},
    head: GENESIS_HASH,
  };
}

function getAccount(state, id) {
  let acct = state.accounts[id];
  if (!acct) {
    acct = { available: 0, frozen: 0, frozenLocked: 0 };
    state.accounts[id] = acct;
  }
  return acct;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CommandError(EXIT_AMOUNT_OUT_OF_RANGE, `${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveAmount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new CommandError(EXIT_AMOUNT_OUT_OF_RANGE, `${field} must be a positive finite number`);
  }
  return value;
}

// Debit `amount` from an account: available first, then unlocked frozen,
// then reversal-locked frozen. Never allows a negative balance.
function debit(state, accountId, amount) {
  const acct = getAccount(state, accountId);
  const fromAvailable = Math.min(acct.available, amount);
  let rest = amount - fromAvailable;
  const unlockedFrozen = acct.frozen - acct.frozenLocked;
  const fromFrozenUnlocked = Math.min(unlockedFrozen, rest);
  rest -= fromFrozenUnlocked;
  const fromFrozenLocked = Math.min(acct.frozenLocked, rest);
  rest -= fromFrozenLocked;
  if (rest > 0) {
    throw new CommandError(
      EXIT_AMOUNT_OUT_OF_RANGE,
      `insufficient funds in account "${accountId}" (need ${amount})`,
    );
  }
  acct.available -= fromAvailable;
  acct.frozen -= fromFrozenUnlocked + fromFrozenLocked;
  acct.frozenLocked -= fromFrozenLocked;
  return { fromAvailable, fromFrozenUnlocked, fromFrozenLocked };
}

function creditParts(state, accountId, parts) {
  const acct = getAccount(state, accountId);
  acct.available += parts.fromAvailable;
  acct.frozen += parts.fromFrozenUnlocked + parts.fromFrozenLocked;
  acct.frozenLocked += parts.fromFrozenLocked;
}

const ZERO_PARTS = { fromAvailable: 0, fromFrozenUnlocked: 0, fromFrozenLocked: 0 };

function addParts(a, b) {
  return {
    fromAvailable: a.fromAvailable + b.fromAvailable,
    fromFrozenUnlocked: a.fromFrozenUnlocked + b.fromFrozenUnlocked,
    fromFrozenLocked: a.fromFrozenLocked + b.fromFrozenLocked,
  };
}

function recordMigration(state, rec) {
  const body = {
    seq: state.migrations.length,
    id: rec.id,
    from: rec.from,
    to: rec.to,
    amount: rec.amount,
    reason: typeof rec.reason === 'string' ? rec.reason : null,
  };
  const hash = crypto
    .createHash('sha256')
    .update(state.head)
    .update('\n')
    .update(JSON.stringify(body))
    .digest('hex');
  const full = { ...body, hash };
  state.migrations.push(full);
  state.head = hash;
  return full;
}

function cmdTransfer(state, cmd, migrations) {
  const id = requireString(cmd.id, 'id');
  const from = requireString(cmd.from, 'from');
  const to = requireString(cmd.to, 'to');
  const amount = requirePositiveAmount(cmd.amount, 'amount');
  if (state.transactions[id]) {
    throw new CommandError(EXIT_ILLEGAL_TRANSITION, `transaction "${id}" already exists`);
  }
  debit(state, from, amount);
  getAccount(state, to).available += amount;
  state.transactions[id] = {
    id,
    from,
    to,
    amount,
    reversedAmount: 0,
    status: 'POSTED',
    settlements: [],
  };
  migrations.push(recordMigration(state, { id, from: 'PENDING', to: 'POSTED', amount, reason: cmd.reason }));
}

function cmdReverse(state, cmd, migrations) {
  const txId = requireString(cmd.txId, 'txId');
  const tx = state.transactions[txId];
  if (!tx) {
    throw new CommandError(EXIT_ILLEGAL_TRANSITION, `unknown transaction "${txId}"`);
  }
  if (tx.status !== 'POSTED') {
    throw new CommandError(
      EXIT_ILLEGAL_TRANSITION,
      `cannot reverse transaction "${txId}" in status ${tx.status}`,
    );
  }
  const remaining = tx.amount - tx.reversedAmount;
  const amount = cmd.amount === undefined ? remaining : requirePositiveAmount(cmd.amount, 'amount');
  if (amount > remaining) {
    throw new CommandError(
      EXIT_AMOUNT_OUT_OF_RANGE,
      `reverse amount ${amount} exceeds remaining reversible amount ${remaining}`,
    );
  }
  const parts = debit(state, tx.to, amount);
  getAccount(state, tx.from).available += amount;
  tx.settlements.push(parts);
  tx.reversedAmount += amount;
  const next = tx.reversedAmount === tx.amount ? 'REVERSED' : 'POSTED';
  const prev = tx.status;
  tx.status = next;
  migrations.push(recordMigration(state, { id: tx.id, from: prev, to: next, amount, reason: cmd.reason }));
}

function cmdReverseReversal(state, cmd, migrations) {
  const txId = requireString(cmd.txId, 'txId');
  const tx = state.transactions[txId];
  if (!tx) {
    throw new CommandError(EXIT_ILLEGAL_TRANSITION, `unknown transaction "${txId}"`);
  }
  if (tx.status !== 'REVERSED') {
    throw new CommandError(
      EXIT_ILLEGAL_TRANSITION,
      `cannot reverseReversal transaction "${txId}" in status ${tx.status}`,
    );
  }
  const total = tx.reversedAmount;
  debit(state, tx.from, total);
  const restored = tx.settlements.reduce(addParts, { ...ZERO_PARTS });
  creditParts(state, tx.to, restored);
  tx.status = 'RESTORED';
  migrations.push(recordMigration(state, { id: tx.id, from: 'REVERSED', to: 'RESTORED', amount: total, reason: cmd.reason }));
}

function cmdFreeze(state, cmd, migrations) {
  const account = requireString(cmd.account, 'account');
  const amount = requirePositiveAmount(cmd.amount, 'amount');
  const acct = getAccount(state, account);
  if (amount > acct.available) {
    throw new CommandError(
      EXIT_AMOUNT_OUT_OF_RANGE,
      `freeze amount ${amount} exceeds available ${acct.available}`,
    );
  }
  const locked = cmd.locked === true || cmd.reason === 'reversal-compensation';
  acct.available -= amount;
  acct.frozen += amount;
  if (locked) acct.frozenLocked += amount;
  migrations.push(recordMigration(state, {
    id: typeof cmd.id === 'string' ? cmd.id : account,
    from: 'AVAILABLE',
    to: locked ? 'FROZEN_LOCKED' : 'FROZEN',
    amount,
    reason: cmd.reason,
  }));
}

function cmdUnfreeze(state, cmd, migrations) {
  const account = requireString(cmd.account, 'account');
  const amount = requirePositiveAmount(cmd.amount, 'amount');
  const acct = getAccount(state, account);
  const releasable = acct.frozen - acct.frozenLocked;
  if (amount > releasable) {
    throw new CommandError(
      EXIT_AMOUNT_OUT_OF_RANGE,
      `unfreeze amount ${amount} exceeds releasable ${releasable} (reversal-compensation locked share is protected)`,
    );
  }
  acct.frozen -= amount;
  acct.available += amount;
  migrations.push(recordMigration(state, {
    id: typeof cmd.id === 'string' ? cmd.id : account,
    from: 'FROZEN',
    to: 'AVAILABLE',
    amount,
    reason: cmd.reason,
  }));
}

const HANDLERS = {
  transfer: cmdTransfer,
  reverse: cmdReverse,
  reverseReversal: cmdReverseReversal,
  freeze: cmdFreeze,
  unfreeze: cmdUnfreeze,
};

function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string' || !HANDLERS[cmd.type]) {
    return { code: EXIT_UNKNOWN_COMMAND, error: `unknown command type: ${cmd && cmd.type}` };
  }
  const key = typeof cmd.idempotencyKey === 'string' && cmd.idempotencyKey.length > 0
    ? cmd.idempotencyKey
    : null;
  if (key && state.idempotency[key]) {
    return { ...state.idempotency[key].result, replayed: true };
  }
  const migrations = [];
  let result;
  try {
    HANDLERS[cmd.type](state, cmd, migrations);
    result = { code: EXIT_OK, migrations };
  } catch (err) {
    if (err instanceof CommandError) {
      result = { code: err.code, error: err.message };
    } else {
      throw err;
    }
  }
  if (key) {
    state.idempotency[key] = { result };
  }
  return result;
}

function verifyState(state) {
  const errors = [];
  let head = GENESIS_HASH;
  state.migrations.forEach((rec, i) => {
    const body = {
      seq: rec.seq,
      id: rec.id,
      from: rec.from,
      to: rec.to,
      amount: rec.amount,
      reason: rec.reason,
    };
    if (rec.seq !== i) errors.push(`migration ${i}: bad seq ${rec.seq}`);
    const hash = crypto
      .createHash('sha256')
      .update(head)
      .update('\n')
      .update(JSON.stringify(body))
      .digest('hex');
    if (hash !== rec.hash) errors.push(`migration ${i}: hash mismatch`);
    head = rec.hash;
  });
  if (head !== state.head) errors.push('head hash mismatch');
  for (const [id, acct] of Object.entries(state.accounts)) {
    if (acct.available < 0) errors.push(`account ${id}: negative available`);
    if (acct.frozen < 0) errors.push(`account ${id}: negative frozen`);
    if (acct.frozenLocked < 0 || acct.frozenLocked > acct.frozen) {
      errors.push(`account ${id}: frozenLocked ${acct.frozenLocked} out of [0, ${acct.frozen}]`);
    }
  }
  for (const [id, tx] of Object.entries(state.transactions)) {
    if (tx.reversedAmount < 0 || tx.reversedAmount > tx.amount) {
      errors.push(`tx ${id}: reversedAmount ${tx.reversedAmount} out of range`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  EXIT_OK,
  EXIT_ILLEGAL_TRANSITION,
  EXIT_AMOUNT_OUT_OF_RANGE,
  EXIT_UNKNOWN_COMMAND,
  GENESIS_HASH,
  CommandError,
  initialState,
  getAccount,
  applyCommand,
  verifyState,
};
