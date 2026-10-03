// Structural validation of a history. Any violation throws InvalidHistory
// (code INVALID_HISTORY), which the CLI maps to exit code 1.
//
// Rules:
// - top level must be a JSON array of operation entries.
// - each entry: client (non-empty string), opId (non-empty string, unique),
//   invocationTime / responseTime (finite numbers, invocation <= response),
//   type in {reserve, commit, cancel, read}, account (non-empty string),
//   ok (boolean).
// - amount: required for reserve, must be a finite number >= 0
//   (negative amounts are rejected as INVALID_HISTORY; zero is legal and
//   defined: a zero reserve always succeeds and holds nothing).
//   For commit/cancel/read, amount must be absent or null.
// - reserveId: required non-empty string for reserve/commit/cancel;
//   must be absent or null for read.
// - result: required for read, { balance, frozen } finite numbers >= 0;
//   must be absent or null for other types.
// - duplicate opId (a "duplicate response") is INVALID_HISTORY.

export class InvalidHistory extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidHistory';
    this.code = 'INVALID_HISTORY';
  }
}

const OP_TYPES = new Set(['reserve', 'commit', 'cancel', 'read']);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function fail(message) {
  throw new InvalidHistory(message);
}

function validateEntry(entry, index) {
  const where = `entry[${index}]`;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${where}: must be an object`);
  }
  if (typeof entry.client !== 'string' || entry.client.length === 0) {
    fail(`${where}: "client" must be a non-empty string`);
  }
  if (typeof entry.opId !== 'string' || entry.opId.length === 0) {
    fail(`${where}: "opId" must be a non-empty string`);
  }
  if (!isFiniteNumber(entry.invocationTime) || !isFiniteNumber(entry.responseTime)) {
    fail(`${where}: "invocationTime" and "responseTime" must be finite numbers`);
  }
  if (entry.invocationTime > entry.responseTime) {
    fail(
      `${where} (opId "${entry.opId}"): invocationTime ${entry.invocationTime} > responseTime ${entry.responseTime} (inverted interval)`
    );
  }
  if (!OP_TYPES.has(entry.type)) {
    fail(`${where} (opId "${entry.opId}"): unknown type ${JSON.stringify(entry.type)}`);
  }
  if (typeof entry.account !== 'string' || entry.account.length === 0) {
    fail(`${where} (opId "${entry.opId}"): "account" must be a non-empty string`);
  }
  if (typeof entry.ok !== 'boolean') {
    fail(`${where} (opId "${entry.opId}"): "ok" must be a boolean`);
  }

  const needsReserveId = entry.type !== 'read';
  if (needsReserveId) {
    if (typeof entry.reserveId !== 'string' || entry.reserveId.length === 0) {
      fail(`${where} (opId "${entry.opId}"): "reserveId" must be a non-empty string`);
    }
  } else if (entry.reserveId !== undefined && entry.reserveId !== null) {
    fail(`${where} (opId "${entry.opId}"): "reserveId" must be absent or null for read`);
  }

  if (entry.type === 'reserve') {
    if (!isFiniteNumber(entry.amount)) {
      fail(`${where} (opId "${entry.opId}"): "amount" must be a finite number for reserve`);
    }
    if (entry.amount < 0) {
      fail(`${where} (opId "${entry.opId}"): negative amount ${entry.amount}`);
    }
  } else if (entry.amount !== undefined && entry.amount !== null) {
    fail(`${where} (opId "${entry.opId}"): "amount" must be absent or null for ${entry.type}`);
  }

  if (entry.type === 'read') {
    const result = entry.result;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      fail(`${where} (opId "${entry.opId}"): "result" must be an object for read`);
    }
    if (!isFiniteNumber(result.balance) || !isFiniteNumber(result.frozen)) {
      fail(`${where} (opId "${entry.opId}"): result.balance/result.frozen must be finite numbers`);
    }
    if (result.balance < 0 || result.frozen < 0) {
      fail(`${where} (opId "${entry.opId}"): result.balance/result.frozen must be >= 0`);
    }
  } else if (entry.result !== undefined && entry.result !== null) {
    fail(`${where} (opId "${entry.opId}"): "result" must be absent or null for ${entry.type}`);
  }
}

// Returns a normalized copy of the ops (order preserved).
export function validateHistory(data) {
  if (!Array.isArray(data)) {
    fail('history must be a JSON array of operations');
  }
  const seen = new Set();
  const ops = data.map((entry, index) => {
    validateEntry(entry, index);
    if (seen.has(entry.opId)) {
      fail(`entry[${index}]: duplicate opId "${entry.opId}" (duplicate response)`);
    }
    seen.add(entry.opId);
    return {
      client: entry.client,
      opId: entry.opId,
      invocationTime: entry.invocationTime,
      responseTime: entry.responseTime,
      type: entry.type,
      account: entry.account,
      amount: entry.amount ?? null,
      reserveId: entry.reserveId ?? null,
      ok: entry.ok,
      result: entry.result ?? null,
    };
  });
  return ops;
}
