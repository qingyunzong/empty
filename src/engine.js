import { createHash } from 'node:crypto';

const ACTION_RANK = { FREEZE: 0, CONFIRM: 1, CANCEL: 2 };

export class HistoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new HistoryError(code, message, details);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stableStringify(value[key]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateEvent(raw, index) {
  if (!isPlainObject(raw)) {
    fail('INVALID_EVENT', `event at index ${index} must be an object`);
  }
  const { requestId, idempotencyKey, ts, amount, action } = raw;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    fail('INVALID_EVENT', `event at index ${index}: requestId must be a non-empty string`);
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    fail('INVALID_EVENT', `event at index ${index}: idempotencyKey must be a non-empty string`);
  }
  if (!Number.isInteger(ts) || ts < 0) {
    fail('INVALID_EVENT', `event at index ${index}: ts must be a non-negative integer logical timestamp`);
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    fail('INVALID_EVENT', `event at index ${index}: amount must be a positive integer`);
  }
  if (!(action in ACTION_RANK)) {
    fail('INVALID_EVENT', `event at index ${index}: action must be one of FREEZE/CONFIRM/CANCEL`);
  }
  return { requestId, idempotencyKey, ts, amount, action };
}

export function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.requestId !== b.requestId) return a.requestId < b.requestId ? -1 : 1;
  if (ACTION_RANK[a.action] !== ACTION_RANK[b.action]) {
    return ACTION_RANK[a.action] - ACTION_RANK[b.action];
  }
  if (a.idempotencyKey !== b.idempotencyKey) return a.idempotencyKey < b.idempotencyKey ? -1 : 1;
  return 0;
}

export function processHistory(history) {
  if (!isPlainObject(history)) {
    fail('INVALID_HISTORY', 'history must be an object with { quota, events }');
  }
  const { quota, events } = history;
  if (!Number.isInteger(quota) || quota < 0) {
    fail('INVALID_HISTORY', 'quota must be a non-negative integer');
  }
  if (!Array.isArray(events)) {
    fail('INVALID_HISTORY', 'events must be an array');
  }

  const seenByKey = new Map();
  const uniqueEvents = [];
  const duplicateKeys = [];
  events.forEach((raw, index) => {
    const event = validateEvent(raw, index);
    const prior = seenByKey.get(event.idempotencyKey);
    if (prior !== undefined) {
      if (stableStringify(prior) !== stableStringify(event)) {
        fail(
          'IDEMPOTENCY_CONFLICT',
          `idempotencyKey "${event.idempotencyKey}" reused with a different payload`,
          { idempotencyKey: event.idempotencyKey },
        );
      }
      duplicateKeys.push(event.idempotencyKey);
      return;
    }
    seenByKey.set(event.idempotencyKey, event);
    uniqueEvents.push(event);
  });

  const ordered = [...uniqueEvents].sort(compareEvents);

  let available = quota;
  const requests = new Map();
  const results = [];
  const acceptedOrder = [];

  const requestState = (id) => {
    if (!requests.has(id)) {
      requests.set(id, { state: 'none', heldAmount: 0 });
    }
    return requests.get(id);
  };

  for (const event of ordered) {
    const req = requestState(event.requestId);
    let status;
    let reason;
    switch (event.action) {
      case 'FREEZE':
        if (req.state !== 'none') {
          status = 'invalid';
          reason = `FREEZE_NOT_ALLOWED_FROM_${req.state.toUpperCase()}`;
        } else if (event.amount > available) {
          status = 'rejected';
          reason = 'INSUFFICIENT_QUOTA';
          req.state = 'rejected';
        } else {
          available -= event.amount;
          req.state = 'frozen';
          req.heldAmount = event.amount;
          status = 'accepted';
        }
        break;
      case 'CONFIRM':
        if (req.state === 'frozen') {
          req.state = 'confirmed';
          status = 'accepted';
        } else if (req.state === 'rejected') {
          status = 'invalid';
          reason = 'CONFIRM_AFTER_REJECTED_FREEZE';
        } else {
          status = 'invalid';
          reason = `CONFIRM_NOT_ALLOWED_FROM_${req.state.toUpperCase()}`;
        }
        break;
      case 'CANCEL':
        if (req.state === 'frozen') {
          available += req.heldAmount;
          req.heldAmount = 0;
          req.state = 'released';
          status = 'accepted';
        } else if (req.state === 'confirmed') {
          available += req.heldAmount;
          req.heldAmount = 0;
          req.state = 'compensated';
          status = 'accepted';
          reason = 'COMPENSATING_RELEASE';
        } else {
          status = 'invalid';
          reason = `CANCEL_NOT_ALLOWED_FROM_${req.state.toUpperCase()}`;
        }
        break;
    }
    const record = {
      idempotencyKey: event.idempotencyKey,
      requestId: event.requestId,
      action: event.action,
      ts: event.ts,
      amount: event.amount,
      status,
    };
    if (reason !== undefined) record.reason = reason;
    record.availableAfter = available;
    results.push(record);
    if (status === 'accepted') {
      acceptedOrder.push({
        idempotencyKey: event.idempotencyKey,
        requestId: event.requestId,
        action: event.action,
        ts: event.ts,
      });
    }
  }

  const finalRequests = {};
  for (const id of [...requests.keys()].sort()) {
    const req = requests.get(id);
    finalRequests[id] = { state: req.state, heldAmount: req.heldAmount };
  }

  const finalState = { quota, available, requests: finalRequests };
  const stateHash = createHash('sha256')
    .update(stableStringify({ finalState, acceptedOrder }))
    .digest('hex');

  return {
    acceptedOrder,
    results,
    duplicates: duplicateKeys,
    finalState,
    stateHash,
  };
}
