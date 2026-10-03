import { createHash } from 'node:crypto';

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  ILLEGAL_TRANSITION: 15,
  AMOUNT_OUT_OF_RANGE: 16,
  UNKNOWN_COMMAND: 17,
});

export const STATUS = Object.freeze({
  PENDING: 'PENDING',
  POSTED: 'POSTED',
  REVERSED: 'REVERSED',
  RESTORED: 'RESTORED',
});

export const GENESIS_HASH = 'GENESIS';

export function initialState() {
  return { version: 1, accounts: {}, transactions: {}, migrations: [], processed: {}, seq: 0 };
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function ok(result) {
  return { ok: true, exitCode: EXIT.OK, result };
}

function fail(exitCode, error) {
  return { ok: false, exitCode, error };
}

function zeroAccount() {
  return { available: 0, frozen: 0, locked: 0 };
}

function readAccount(state, name) {
  return state.accounts[name] ?? zeroAccount();
}

function ensureAccount(state, name) {
  let acc = state.accounts[name];
  if (!acc) {
    acc = zeroAccount();
    state.accounts[name] = acc;
  }
  return acc;
}

function isPositiveAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function recordMigration(state, fields) {
  state.seq += 1;
  const prevHash = state.migrations.length > 0
    ? state.migrations[state.migrations.length - 1].hash
    : GENESIS_HASH;
  const record = { id: `mig-${state.seq}`, seq: state.seq, prevHash, ...fields };
  record.hash = sha256(canonical(record));
  state.migrations.push(record);
  return record;
}

function txIdOf(cmd) {
  return cmd.tx ?? cmd.txId;
}

function execTransfer(state, cmd) {
  if (typeof cmd.id !== 'string' || cmd.id === '') {
    return fail(EXIT.USAGE, 'transfer requires a non-empty string "id"');
  }
  if (typeof cmd.from !== 'string' || cmd.from === '' || typeof cmd.to !== 'string' || cmd.to === '') {
    return fail(EXIT.USAGE, 'transfer requires non-empty "from" and "to" accounts');
  }
  if (!isPositiveAmount(cmd.amount)) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, 'transfer amount must be a positive finite number');
  }
  if (cmd.from === cmd.to) {
    return fail(EXIT.ILLEGAL_TRANSITION, 'transfer "from" and "to" must differ');
  }
  if (state.transactions[cmd.id]) {
    return fail(EXIT.ILLEGAL_TRANSITION, `transaction "${cmd.id}" already exists`);
  }
  if (readAccount(state, cmd.from).available < cmd.amount) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, `transfer amount ${cmd.amount} exceeds available funds of "${cmd.from}"`);
  }
  const fromAcc = ensureAccount(state, cmd.from);
  const toAcc = ensureAccount(state, cmd.to);
  fromAcc.available -= cmd.amount;
  toAcc.available += cmd.amount;
  const tx = {
    id: cmd.id, from: cmd.from, to: cmd.to, amount: cmd.amount,
    reversedAmount: 0, lockPortion: 0, status: STATUS.POSTED,
  };
  state.transactions[cmd.id] = tx;
  recordMigration(state, {
    command: 'transfer', from: cmd.from, to: cmd.to, amount: cmd.amount,
    reason: 'transfer', fromStatus: STATUS.PENDING, toStatus: STATUS.POSTED,
  });
  return ok({ txId: tx.id, status: tx.status });
}

function execFreeze(state, cmd) {
  if (typeof cmd.account !== 'string' || cmd.account === '') {
    return fail(EXIT.USAGE, 'freeze requires a non-empty string "account"');
  }
  if (!isPositiveAmount(cmd.amount)) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, 'freeze amount must be a positive finite number');
  }
  if (readAccount(state, cmd.account).available < cmd.amount) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, `freeze amount ${cmd.amount} exceeds available funds of "${cmd.account}"`);
  }
  const acc = ensureAccount(state, cmd.account);
  acc.available -= cmd.amount;
  acc.frozen += cmd.amount;
  recordMigration(state, {
    command: 'freeze', from: cmd.account, to: cmd.account, amount: cmd.amount,
    reason: 'freeze', fromStatus: null, toStatus: null,
  });
  return ok({ account: cmd.account, frozen: acc.frozen });
}

function execUnfreeze(state, cmd) {
  if (typeof cmd.account !== 'string' || cmd.account === '') {
    return fail(EXIT.USAGE, 'unfreeze requires a non-empty string "account"');
  }
  if (!isPositiveAmount(cmd.amount)) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, 'unfreeze amount must be a positive finite number');
  }
  const current = readAccount(state, cmd.account);
  const releasable = current.frozen - current.locked;
  if (cmd.amount > releasable) {
    return fail(
      EXIT.AMOUNT_OUT_OF_RANGE,
      `unfreeze amount ${cmd.amount} exceeds releasable ${releasable} of "${cmd.account}" (reversal-compensation locked shares are not releasable)`,
    );
  }
  const acc = ensureAccount(state, cmd.account);
  acc.frozen -= cmd.amount;
  acc.available += cmd.amount;
  recordMigration(state, {
    command: 'unfreeze', from: cmd.account, to: cmd.account, amount: cmd.amount,
    reason: 'unfreeze', fromStatus: null, toStatus: null,
  });
  return ok({ account: cmd.account, frozen: acc.frozen });
}

function execReverse(state, cmd) {
  const txId = txIdOf(cmd);
  if (typeof txId !== 'string' || txId === '') {
    return fail(EXIT.USAGE, 'reverse requires a non-empty "tx" id');
  }
  const tx = state.transactions[txId];
  if (!tx) {
    return fail(EXIT.ILLEGAL_TRANSITION, `unknown transaction "${txId}"`);
  }
  if (tx.status !== STATUS.POSTED) {
    return fail(EXIT.ILLEGAL_TRANSITION, `cannot reverse transaction "${txId}" in status ${tx.status}`);
  }
  const remaining = tx.amount - tx.reversedAmount;
  const amount = cmd.amount === undefined ? remaining : cmd.amount;
  if (!isPositiveAmount(amount)) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, 'reverse amount must be a positive finite number');
  }
  if (amount > remaining) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, `reverse amount ${amount} exceeds remaining reversible ${remaining}`);
  }
  const toAcc = state.accounts[tx.to];
  const fromAcc = state.accounts[tx.from];
  const seizable = toAcc.available + (toAcc.frozen - toAcc.locked);
  if (amount > seizable) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, `reversal of ${amount} would overdraft "${tx.to}" (seizable ${seizable})`);
  }
  const fromAvailable = Math.min(toAcc.available, amount);
  const lock = amount - fromAvailable;
  toAcc.available -= fromAvailable;
  toAcc.locked += lock;
  fromAcc.available += amount;
  tx.reversedAmount += amount;
  tx.lockPortion += lock;
  const fromStatus = tx.status;
  if (tx.reversedAmount === tx.amount) {
    tx.status = STATUS.REVERSED;
  }
  recordMigration(state, {
    command: 'reverse', from: tx.to, to: tx.from, amount,
    reason: 'reverse', fromStatus, toStatus: tx.status,
  });
  return ok({ txId: tx.id, status: tx.status, reversedAmount: tx.reversedAmount, locked: lock });
}

function execReverseReversal(state, cmd) {
  const txId = txIdOf(cmd);
  if (typeof txId !== 'string' || txId === '') {
    return fail(EXIT.USAGE, 'reverseReversal requires a non-empty "tx" id');
  }
  const tx = state.transactions[txId];
  if (!tx) {
    return fail(EXIT.ILLEGAL_TRANSITION, `unknown transaction "${txId}"`);
  }
  if (tx.status !== STATUS.REVERSED) {
    return fail(EXIT.ILLEGAL_TRANSITION, `cannot reverse-reversal transaction "${txId}" in status ${tx.status}`);
  }
  const amount = tx.reversedAmount;
  const fromAcc = state.accounts[tx.from];
  const toAcc = state.accounts[tx.to];
  if (fromAcc.available < amount) {
    return fail(EXIT.AMOUNT_OUT_OF_RANGE, `restoration of ${amount} would overdraft "${tx.from}" (available ${fromAcc.available})`);
  }
  const lock = tx.lockPortion;
  fromAcc.available -= amount;
  toAcc.available += amount - lock;
  toAcc.locked -= lock;
  tx.lockPortion = 0;
  tx.status = STATUS.RESTORED;
  recordMigration(state, {
    command: 'reverseReversal', from: tx.from, to: tx.to, amount,
    reason: 'reverseReversal', fromStatus: STATUS.REVERSED, toStatus: STATUS.RESTORED,
  });
  return ok({ txId: tx.id, status: tx.status, restoredAmount: amount, unlocked: lock });
}

function execute(state, cmd) {
  switch (cmd.type) {
    case 'transfer': return execTransfer(state, cmd);
    case 'reverse': return execReverse(state, cmd);
    case 'reverseReversal': return execReverseReversal(state, cmd);
    case 'freeze': return execFreeze(state, cmd);
    case 'unfreeze': return execUnfreeze(state, cmd);
    default: return fail(EXIT.UNKNOWN_COMMAND, `unknown command type: ${String(cmd.type)}`);
  }
}

export function applyCommand(state, cmd) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('state must be an object');
  }
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) {
    return { ok: false, exitCode: EXIT.USAGE, error: 'command must be a JSON object', state, replayed: false };
  }
  const key = cmd.idempotencyKey;
  const hasKey = typeof key === 'string' && key !== '';
  if (hasKey && state.processed[key]) {
    return { ...state.processed[key], state, replayed: true };
  }
  const outcome = execute(state, cmd);
  if (hasKey && outcome.exitCode !== EXIT.USAGE) {
    const stored = { ok: outcome.ok, exitCode: outcome.exitCode };
    if (outcome.ok) stored.result = outcome.result;
    else stored.error = outcome.error;
    state.processed[key] = stored;
  }
  return { ...outcome, state, replayed: false };
}

export function verifyMigrationChain(state) {
  let prev = GENESIS_HASH;
  for (const record of state.migrations) {
    if (record.prevHash !== prev) return false;
    const { hash, ...rest } = record;
    if (sha256(canonical(rest)) !== hash) return false;
    prev = hash;
  }
  return true;
}

export function checkInvariants(state) {
  const problems = [];
  for (const [name, acc] of Object.entries(state.accounts)) {
    if (!(acc.available >= 0)) problems.push(`${name}: negative available ${acc.available}`);
    if (!(acc.frozen >= 0)) problems.push(`${name}: negative frozen ${acc.frozen}`);
    if (!(acc.locked >= 0)) problems.push(`${name}: negative locked ${acc.locked}`);
    if (!(acc.locked <= acc.frozen)) problems.push(`${name}: locked ${acc.locked} exceeds frozen ${acc.frozen}`);
  }
  const lockSums = {};
  for (const tx of Object.values(state.transactions)) {
    if (!(tx.reversedAmount >= 0 && tx.reversedAmount <= tx.amount)) {
      problems.push(`${tx.id}: reversedAmount ${tx.reversedAmount} out of [0, ${tx.amount}]`);
    }
    if (tx.status === STATUS.REVERSED && tx.reversedAmount !== tx.amount) {
      problems.push(`${tx.id}: REVERSED but reversedAmount ${tx.reversedAmount} != amount ${tx.amount}`);
    }
    if (tx.status === STATUS.POSTED && tx.reversedAmount >= tx.amount) {
      problems.push(`${tx.id}: POSTED but fully reversed`);
    }
    if (tx.status === STATUS.RESTORED && tx.lockPortion !== 0) {
      problems.push(`${tx.id}: RESTORED but lockPortion ${tx.lockPortion} != 0`);
    }
    if (!(tx.lockPortion >= 0 && tx.lockPortion <= tx.reversedAmount)) {
      problems.push(`${tx.id}: lockPortion ${tx.lockPortion} out of [0, ${tx.reversedAmount}]`);
    }
    if (tx.status === STATUS.POSTED || tx.status === STATUS.REVERSED) {
      lockSums[tx.to] = (lockSums[tx.to] ?? 0) + tx.lockPortion;
    }
  }
  for (const [name, acc] of Object.entries(state.accounts)) {
    const expected = lockSums[name] ?? 0;
    if (acc.locked !== expected) {
      problems.push(`${name}: locked ${acc.locked} != sum of open tx lock portions ${expected}`);
    }
  }
  return problems;
}
